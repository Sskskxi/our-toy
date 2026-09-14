import os from "node:os";

export type FailureKind =
  | "limit"
  | "auth"
  | "model"
  | "transient"
  | "timeout"
  | "cli"
  | "output"
  | "unknown";

const HINTS: Record<FailureKind, string> = {
  limit: "구독 사용량 한도에 도달했어요. 한도가 풀리면 이어서 할 수 있어요.",
  auth: "로그인이 풀렸어요. 홈 화면 계정 카드에서 다시 로그인한 뒤 이어서 실행해 주세요.",
  model: "선택한 모델을 이 계정에서 쓸 수 없어요. 모델이나 추론 수준을 바꾼 뒤 이어서 실행해 주세요.",
  transient: "서비스 과부하나 네트워크 문제로 잠시 실패했어요.",
  timeout: "응답 시간 제한을 넘었어요.",
  cli: "CLI가 실행 옵션을 거부했어요. Codex/Claude Code를 최신 버전으로 업데이트한 뒤 이어서 실행해 주세요.",
  output: "모델 응답을 해석하지 못했어요. 이어서 실행하면 그 단계부터 다시 요청해요.",
  unknown: "CLI 실행이 실패했어요. 잠시 뒤 이어서 실행해 주세요.",
};

export class CliFailure extends Error {
  constructor(
    readonly command: string,
    readonly kind: FailureKind,
    readonly detail = "",
  ) {
    super(
      `${command}: ${HINTS[kind]}${detail ? ` (원인: ${detail})` : ""} (API 자동 전환 없음)`,
    );
    this.name = "CliFailure";
  }
  get retryable() {
    return this.kind === "transient" || this.kind === "timeout" || isOversized(this);
  }
}

/**
 * Messages the CLI itself reported as errors. The raw stdout also carries
 * prompts, web pages and usage fields like "input_tokens", so it must never be
 * pattern-matched as a whole: that misreported healthy logins as auth failures.
 */
export function reportedErrors(stdout: string, stderr: string) {
  const messages: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const error = event.error as { message?: unknown } | string | undefined;
    if (event.type === "error" && typeof event.message === "string")
      messages.push(event.message);
    if (event.type === "turn.failed")
      messages.push(
        typeof error === "string" ? error : String(error?.message ?? "turn failed"),
      );
    if (event.is_error === true) {
      if (typeof event.result === "string") messages.push(event.result);
      if (typeof event.subtype === "string") messages.push(event.subtype);
      if (Array.isArray(event.errors)) messages.push(...event.errors.map(String));
    }
  }
  if (stderr.trim()) messages.push(stderr.trim().slice(-2000));
  return messages.join("\n");
}

export function classifyFailure(text: string): FailureKind {
  if (/usage limit|rate[ _-]?limit|limit reached|quota|too many requests|\b429\b/i.test(text))
    return "limit";
  if (
    /not logged in|log ?in required|please (run .{0,20})?log ?in|unauthori[sz]ed|\b401\b|invalid (api[ _-]?key|token|credentials)|(token|session|credentials?) (has )?expired|authentication (failed|required|error)/i.test(
      text,
    )
  )
    return "auth";
  if (
    /model.{0,40}(not (found|supported|available)|does not exist|unsupported|not have access)|unknown model|invalid model|no access to model/i.test(
      text,
    )
  )
    return "model";
  if (
    /overloaded|\b5(00|02|03|04|29)\b|internal server error|bad gateway|service unavailable|econnreset|etimedout|enotfound|eai_again|socket hang up|stream (disconnected|error|closed)|network error|connection (reset|closed|refused|error)|temporarily unavailable/i.test(
      text,
    )
  )
    return "transient";
  if (/unexpected argument|unknown (option|flag|argument)|unrecognized|invalid value for/i.test(text))
    return "cli";
  if (/error_max_turns|max.?turns/i.test(text)) return "output";
  return "unknown";
}

/** One short, privacy-safe line from the CLI's own error text. */
export function sanitizeDetail(text: string, max = 180) {
  const home = os.homedir();
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .find((l) => !/^at\s/.test(l)) ?? "";
  return line
    .split(home)
    .join("~")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\b(sk|ghp|gho|xox[a-z])-?[A-Za-z0-9_-]{10,}/g, "<secret>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<id>")
    .slice(0, max);
}

export function cliFailure(command: string, stdout: string, stderr: string) {
  const text = reportedErrors(stdout, stderr);
  return new CliFailure(command, classifyFailure(text), sanitizeDetail(text));
}

export function isRetryable(error: unknown) {
  if (error instanceof CliFailure) return error.retryable;
  // Providers other than the CLIs (tests, mock) signal timeouts by message.
  return error instanceof Error && /시간 제한|네트워크 오류|과부하/.test(error.message);
}

/** Output larger than the CLI limit: too much for this effort, not a broken model. */
function isOversized(error: CliFailure) {
  return error.kind === "output" && /MB/.test(error.detail);
}

/**
 * The answer was too big or too slow for the chosen effort. Such calls are
 * retried at a lower effort so the conversation keeps moving.
 */
export function isVolumeFailure(error: unknown) {
  return isTimeout(error) || (error instanceof CliFailure && isOversized(error));
}

/** Extra time for heavier reasoning; multiplies the stage limit and retry scale. */
export function effortTimeFactor(effort?: string) {
  return effort === "max" ? 3 : effort === "xhigh" ? 2 : 1;
}

/** A time-limit failure: the call already burned its whole budget. */
export function isTimeout(error: unknown) {
  if (error instanceof CliFailure) return error.kind === "timeout";
  return error instanceof Error && /시간 제한/.test(error.message);
}

/**
 * Per-stage CLI time limits in ms; web-search stages need the most room.
 * `scale` stretches the limit for retries after a timeout (the
 * CLI_TIMEOUT_SECONDS override is scaled too).
 */
export function stageTimeout(
  stage: string,
  env: Record<string, string | undefined> = process.env,
  scale = 1,
) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const override = Number(env.CLI_TIMEOUT_SECONDS);
  const base =
    Number.isFinite(override) && override >= 60
      ? override * 1000
      : ["research", "draft", "revise", "explore"].includes(stage)
        ? 600_000
        : ["merge", "synthesis"].includes(stage)
          ? 420_000
          : 300_000;
  return Math.round(base * factor);
}
