import type { Actor, ModelChoices, Project, Stage } from "./types";

// Rough time and token estimate for a new research, learned from calls this
// machine has already made. Falls back to conservative per-stage defaults.

export type Strategy = "codraft" | "debate" | "relay";
type Planned = { stage: Stage; actor: Actor };

const both = (stage: Stage): Planned[] => [
  { stage, actor: "GPT" },
  { stage, actor: "Claude" },
];

const PLANS: Record<Strategy, { once: Planned[]; round: Planned[] }> = {
  codraft: {
    once: [
      { stage: "plan", actor: "GPT" },
      ...both("draft"),
      { stage: "merge", actor: "GPT" },
      { stage: "contradictions", actor: "GPT" },
      { stage: "synthesis", actor: "Claude" },
    ],
    round: both("revise"),
  },
  relay: {
    once: [
      { stage: "plan", actor: "GPT" },
      { stage: "contradictions", actor: "GPT" },
      { stage: "synthesis", actor: "GPT" },
    ],
    round: both("explore"),
  },
  debate: {
    once: [
      { stage: "plan", actor: "GPT" },
      { stage: "contradictions", actor: "GPT" },
      { stage: "synthesis", actor: "GPT" },
    ],
    round: [...both("research"), ...both("critique"), ...both("rebuttal")],
  },
};

const DEFAULT_SECONDS: Partial<Record<Stage, number>> = {
  plan: 30,
  draft: 150,
  merge: 90,
  revise: 180,
  explore: 180,
  research: 150,
  critique: 60,
  rebuttal: 80,
  contradictions: 60,
  synthesis: 180,
};
const DEFAULT_TOKENS = 40_000;
const EFFORT_FACTOR: Record<string, number> = { low: 0.5, medium: 0.75, high: 1, xhigh: 1.8, max: 4 };

export type CallStats = Map<string, { ms: number; tokens: number; n: number }>;
const statKey = (stage: string, effort: string) => `${stage}|${effort}`;

/** Average duration and tokens per (stage, effort) from finished live calls. */
export function collectStats(projects: Project[]): CallStats {
  const stats: CallStats = new Map();
  for (const p of projects) {
    if (p.mode === "mock") continue;
    for (const c of p.calls) {
      if (c.status !== "complete" || c.replayed || !c.finishedAt || !c.result) continue;
      const ms = Date.parse(c.finishedAt) - Date.parse(c.startedAt);
      if (!(ms > 0)) continue;
      const k = statKey(c.stage, p.models?.[c.actor]?.effort ?? "default");
      const s = stats.get(k) ?? { ms: 0, tokens: 0, n: 0 };
      s.ms += ms;
      s.tokens += c.result.tokens;
      s.n += 1;
      stats.set(k, s);
    }
  }
  return stats;
}

export type Estimate = {
  calls: [number, number];
  minutes: [number, number];
  tokens: [number, number];
  /** Past calls the estimate is based on; 0 means defaults only. */
  basedOn: number;
};

export function estimateRun(
  input: {
    strategy?: Strategy;
    minRounds?: number;
    maxRounds: number;
    models?: ModelChoices;
    /** Maps a chosen effort to the one a stage actually runs with (caps). */
    effortFor?: (stage: Stage, effort: string) => string;
  },
  stats: CallStats,
  defaults: Record<Actor, string> = { GPT: "high", Claude: "high" },
): Estimate {
  const plan = PLANS[input.strategy ?? "codraft"];
  const seen = new Set<string>();
  let basedOn = 0;
  const total = (items: Planned[]) =>
    items.reduce(
      (acc, item) => {
        const chosen = input.models?.[item.actor]?.effort ?? defaults[item.actor];
        const effort = input.effortFor ? input.effortFor(item.stage, chosen) : chosen;
        const k = statKey(item.stage, effort);
        const s = stats.get(k) ?? stats.get(statKey(item.stage, "default"));
        if (s?.n && !seen.has(k)) {
          seen.add(k);
          basedOn += s.n;
        }
        const factor = EFFORT_FACTOR[effort] ?? 1;
        const ms = s?.n ? s.ms / s.n : (DEFAULT_SECONDS[item.stage] ?? 120) * 1000 * factor;
        const tokens = s?.n ? s.tokens / s.n : DEFAULT_TOKENS * factor;
        return { ms: acc.ms + ms, tokens: acc.tokens + tokens, n: acc.n + 1 };
      },
      { ms: 0, tokens: 0, n: 0 },
    );
  const fixed = total(plan.once);
  const round = total(plan.round);
  const at = (rounds: number) => ({
    calls: fixed.n + round.n * rounds,
    minutes: Math.max(1, Math.round((fixed.ms + round.ms * rounds) / 60000)),
    tokens: Math.round((fixed.tokens + round.tokens * rounds) / 1000) * 1000,
  });
  const lo = at(Math.max(1, Math.min(input.minRounds ?? 1, input.maxRounds)));
  const hi = at(input.maxRounds);
  return {
    calls: [lo.calls, hi.calls],
    minutes: [lo.minutes, hi.minutes],
    tokens: [lo.tokens, hi.tokens],
    basedOn,
  };
}
