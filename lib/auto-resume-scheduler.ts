import type { AccountUsage } from "./account-usage";
import { postponeLimitResume, TRANSIENT_RESUMES, usageAllowsResume } from "./auto-resume";
import type { ProjectBrief } from "./store";
import type { Project } from "./types";

/** Usage checks that could not read the account before resuming anyway. */
export const UNAVAILABLE_CHECKS = 3;

export type SchedulerDeps = {
  briefs: () => ProjectBrief[];
  get: (id: string) => Project | undefined;
  save: (p: Project) => void;
  usage: () => Promise<AccountUsage>;
  now?: Date;
  /** Per-project count of usage checks that returned no data (worker memory). */
  unavailable: Map<string, number>;
};

/**
 * Requeue failed runs and follow-up turns whose automatic retry is due. Only
 * projects the cheap briefs mark as due are loaded from disk.
 */
export async function tickAutoResume(deps: SchedulerDeps) {
  const now = deps.now ?? new Date();
  const iso = now.toISOString();
  let usage: AccountUsage | undefined;
  let usageRead = false;
  const readUsage = async () => {
    if (!usageRead) {
      usageRead = true;
      usage = await deps.usage().catch(() => undefined);
    }
    return usage;
  };
  const resumed: string[] = [];
  for (const brief of deps.briefs()) {
    const projectDue = brief.status === "failed" && brief.autoResumeAt && brief.autoResumeAt <= iso;
    const turnDue = brief.turnRetryAt && brief.turnRetryAt <= iso;
    if (!projectDue && !turnDue) continue;
    const p = deps.get(brief.id);
    if (!p) continue;
    let changed = false;

    for (const turn of p.conversation.turns)
      if (turn.status === "failed" && turn.autoRetry && turn.autoRetry.at <= iso) {
        // autoRetry stays so the attempt count carries into the next failure.
        turn.status = "queued";
        turn.error = undefined;
        turn.updatedAt = iso;
        p.stage = "대화 응답을 자동으로 다시 요청해요";
        changed = true;
      }

    const plan = p.autoResume;
    const busyTurn = p.conversation.turns.some((t) => t.status === "running" || t.status === "queued");
    // A follow-up answer runs first; the resume waits for the next tick.
    if (p.status === "failed" && plan && plan.at <= iso && p.mode !== "live" && !busyTurn) {
      const resume = (stage: string) => {
        p.status = "queued";
        p.stage = stage;
        p.error = undefined;
        deps.unavailable.delete(p.id);
        resumed.push(p.id);
        changed = true;
      };
      if (plan.reason !== "limit") {
        resume(
          plan.reason === "restart"
            ? "서버가 다시 켜져 자동으로 이어서 실행해요"
            : `자동으로 이어서 실행해요 (${plan.attempts}/${TRANSIENT_RESUMES})`,
        );
      } else if (p.mode === "mock") {
        resume("사용량이 회복돼 자동으로 이어서 실행해요");
      } else {
        const current = await readUsage();
        const account = plan.provider === "GPT" ? current?.codex : plan.provider === "Claude" ? current?.claude : undefined;
        const allowed = account ? usageAllowsResume(account) : undefined;
        const misses = allowed === undefined ? (deps.unavailable.get(p.id) ?? 0) + 1 : 0;
        if (allowed === true) resume("사용량이 회복돼 자동으로 이어서 실행해요");
        else if (allowed === undefined && misses >= UNAVAILABLE_CHECKS)
          resume("사용량을 확인하지 못했지만 자동으로 이어서 실행해 봐요");
        else {
          if (allowed === undefined) deps.unavailable.set(p.id, misses);
          const next = postponeLimitResume(plan, now);
          p.autoResume = next;
          if (!next) {
            deps.unavailable.delete(p.id);
            p.stage = "사용량 한도가 오래 풀리지 않아 자동 재개를 멈췄어요 · 이어서 실행 가능";
          }
          changed = true;
        }
      }
    }
    if (changed) deps.save(p);
  }
  return resumed;
}
