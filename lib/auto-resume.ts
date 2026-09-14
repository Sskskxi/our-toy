import { CliFailure, isRetryable } from "./cli-errors";
import type { Actor, AutoResume, Call, ConversationTurn } from "./types";

// Failed research resumes on its own when waiting is all the user could do:
// overload, network and timeout failures retry a few times with growing gaps,
// and usage limits wait until the subscription window resets. Login, model,
// CLI and output problems need the user, so they never auto-resume.
export const TRANSIENT_RESUMES = 3;
export const TRANSIENT_STEP_MS = 3 * 60_000;
export const LIMIT_CHECK_MS = 15 * 60_000;
/** 40 checks every 15 minutes: about 10 hours. */
export const LIMIT_CHECKS = 40;
export const RESTART_RESUMES = 3;
/** Follow-up answers: automatic retries after a retryable failure. */
export const TURN_RETRIES = 2;
export const TURN_RETRY_MS = 30_000;

const at = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();
const PROVIDERS: Record<string, Actor> = { codex: "GPT", claude: "Claude" };

export function planAutoResume({
  error,
  previous,
  progressed,
  now,
}: {
  error: unknown;
  previous?: AutoResume;
  /** This run completed at least one new, non-replayed call. */
  progressed: boolean;
  now: Date;
}): AutoResume | undefined {
  // Counters carry over only across the same kind of failure and only while
  // the run makes no progress.
  const carried = (reason: AutoResume["reason"]) =>
    !progressed && previous?.reason === reason ? previous.attempts : 0;
  if (error instanceof CliFailure && error.kind === "limit") {
    const attempts = carried("limit") + 1;
    if (attempts > LIMIT_CHECKS) return undefined;
    return {
      reason: "limit",
      attempts,
      at: at(now, LIMIT_CHECK_MS),
      provider: PROVIDERS[error.command],
      note: "사용량 한도가 풀리면 자동으로 이어서 실행해요",
    };
  }
  if (!isRetryable(error)) return undefined;
  const attempts = carried("transient") + 1;
  if (attempts > TRANSIENT_RESUMES) return undefined;
  const minutes = (TRANSIENT_STEP_MS / 60_000) * attempts;
  return {
    reason: "transient",
    attempts,
    at: at(now, TRANSIENT_STEP_MS * attempts),
    note: `${minutes}분 뒤 자동으로 이어서 실행해요 (${attempts}/${TRANSIENT_RESUMES})`,
  };
}

/** Postpone a usage-limit resume by one check, or give up after the cap. */
export function postponeLimitResume(previous: AutoResume, now: Date): AutoResume | undefined {
  const attempts = previous.attempts + 1;
  if (attempts > LIMIT_CHECKS) return undefined;
  return { ...previous, attempts, at: at(now, LIMIT_CHECK_MS) };
}

/**
 * A run cut by a server restart continues on its own. Restarts that keep
 * interrupting the same run without any new finished call stop after a few
 * tries, so a project that crashes the worker cannot loop forever.
 */
export function planRestartResume(
  previous: AutoResume | undefined,
  calls: Pick<Call, "status" | "replayed" | "finishedAt">[],
  now: Date,
): AutoResume | undefined {
  const progressed =
    previous?.reason === "restart" &&
    calls.some(
      (c) => c.status === "complete" && !c.replayed && c.finishedAt && c.finishedAt > previous.at,
    );
  const attempts = (previous?.reason === "restart" && !progressed ? previous.attempts : 0) + 1;
  if (attempts > RESTART_RESUMES) return undefined;
  return {
    reason: "restart",
    attempts,
    at: now.toISOString(),
    note: "서버가 다시 켜져 자동으로 이어서 실행해요",
  };
}

/** Usage windows allow a resume: every reported window has quota left. */
export function usageAllowsResume(usage: {
  status: "available" | "unavailable";
  short?: { remainingPercent: number };
  weekly?: { remainingPercent: number };
}) {
  if (usage.status !== "available") return undefined;
  return [usage.short, usage.weekly].every((w) => !w || w.remainingPercent > 0);
}

/** Schedule an automatic retry for a failed follow-up turn, or undefined. */
export function planTurnRetry(
  turn: Pick<ConversationTurn, "autoRetry">,
  error: unknown,
  now: Date,
): ConversationTurn["autoRetry"] {
  const attempts = turn.autoRetry?.attempts ?? 0;
  if (!isRetryable(error) || attempts >= TURN_RETRIES) return undefined;
  return { attempts: attempts + 1, at: at(now, TURN_RETRY_MS) };
}
