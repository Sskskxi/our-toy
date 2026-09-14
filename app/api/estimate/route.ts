import { NextRequest, NextResponse } from "next/server";
import { collectStats, estimateRun, type CallStats, type Strategy } from "@/lib/estimate";
import { effortFor } from "@/lib/engine";
import { rejectUnsafe } from "@/lib/http";
import { list } from "@/lib/store";
import { modelDefaults } from "@/lib/subscription";
import { efforts } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cache: { at: number; stats: CallStats } | undefined;

// Time and token estimate for the new-research form, from this Mac's past calls.
export async function GET(req: NextRequest) {
  const unsafe = rejectUnsafe(req, { json: false });
  if (unsafe) return unsafe;
  const q = req.nextUrl.searchParams;
  const strategy = (["codraft", "debate", "relay"] as const).find((s) => s === q.get("strategy")) ?? "codraft";
  const maxRounds = Math.min(30, Math.max(1, Number(q.get("maxRounds")) || 1));
  const minRounds = Math.min(maxRounds, Math.max(1, Number(q.get("minRounds")) || 1));
  const effort = (name: string) => {
    const v = q.get(name);
    return (efforts as readonly string[]).includes(v ?? "") ? (v as (typeof efforts)[number]) : undefined;
  };
  if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), stats: collectStats(list()) };
  const defaults = modelDefaults();
  const estimate = estimateRun(
    {
      strategy: strategy as Strategy,
      minRounds,
      maxRounds,
      models: { GPT: { effort: effort("gpt") }, Claude: { effort: effort("claude") } },
      effortFor: (stage, e) => effortFor(stage, e) ?? e,
    },
    cache.stats,
    { GPT: defaults.GPT.effort, Claude: defaults.Claude.effort },
  );
  return NextResponse.json(estimate, { headers: { "Cache-Control": "private, no-store" } });
}
