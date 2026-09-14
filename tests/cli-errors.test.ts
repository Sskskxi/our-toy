import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  CliFailure,
  classifyFailure,
  cliFailure,
  isRetryable,
  reportedErrors,
  sanitizeDetail,
  stageTimeout,
} from "../lib/cli-errors";
import { decodeClaude } from "../lib/subscription";
import { withRetry } from "../lib/engine";

const codexEvents = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");

test("regression: usage fields and prompt text in stdout are not read as auth or limit errors", () => {
  const stdout = codexEvents(
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { text: "로그인 token 401 quota usage limit 관련 웹 문서 요약" } },
    { type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 30 } },
    { type: "error", message: "stream disconnected before completion: 503 Service Unavailable" },
  );
  const failure = cliFailure("codex", stdout, "");
  assert.equal(failure.kind, "transient");
  assert.equal(failure.retryable, true);
  assert.match(failure.message, /503/);
  assert.doesNotMatch(reportedErrors(stdout, ""), /로그인 token/);
});

test("each failure case is classified with the right retry policy", () => {
  const cases: [string, string, boolean][] = [
    ["You've hit your usage limit. Try again at 3:10pm.", "limit", false],
    ["Claude AI usage limit reached|1757830000", "limit", false],
    ["Error: 429 Too Many Requests", "limit", false],
    ["Not logged in · Please run /login", "auth", false],
    ["401 Unauthorized: token expired", "auth", false],
    ["The model `gpt-9` does not exist or you do not have access to it.", "model", false],
    ["API Error: 529 Overloaded", "transient", true],
    ["request failed: ECONNRESET", "transient", true],
    ["error: unexpected argument '--ignore-rules' found", "cli", false],
    ["error_max_turns", "output", false],
    ["something odd happened", "unknown", false],
  ];
  for (const [text, kind, retry] of cases) {
    assert.equal(classifyFailure(text), kind, text);
    assert.equal(new CliFailure("x", classifyFailure(text)).retryable, retry, text);
  }
  assert.equal(new CliFailure("codex", "timeout").retryable, true);
});

test("Claude error results keep their real reason instead of a generic message", () => {
  assert.throws(
    () =>
      decodeClaude(
        JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 Overloaded" }),
        "claude-opus-5",
      ),
    (e: unknown) => e instanceof CliFailure && e.kind === "transient" && /529/.test(e.message),
  );
  assert.throws(
    () => decodeClaude("not json", "claude-opus-5"),
    (e: unknown) => e instanceof CliFailure && e.kind === "output",
  );
});

test("error details shown in the UI hide emails, secrets and home paths", () => {
  const detail = sanitizeDetail(
    `auth failed for me@example.com at ${os.homedir()}/.codex/auth.json key sk-abcdefghijklmnopqrstuv`,
  );
  assert.doesNotMatch(detail, /example\.com|sk-abc|\/Users\//);
  assert.match(detail, /<email>.*~\/\.codex.*<secret>/);
});

test("stage time limits give web-search stages more room", () => {
  assert.equal(stageTimeout("research", {}), 600_000);
  assert.equal(stageTimeout("revise", {}), 600_000);
  assert.equal(stageTimeout("merge", {}), 420_000);
  assert.equal(stageTimeout("plan", {}), 300_000);
  assert.equal(stageTimeout("plan", { CLI_TIMEOUT_SECONDS: "900" }), 900_000);
});

test("transient failures retry with backoff; limits and auth fail immediately", async () => {
  let calls = 0;
  const flaky = await withRetry(
    async () => {
      if (++calls < 3) throw new CliFailure("claude", "transient", "529");
      return "ok";
    },
    () => {},
    [0, 0],
  );
  assert.equal(flaky, "ok");
  assert.equal(calls, 3);

  let limited = 0;
  await assert.rejects(
    withRetry(async () => {
      limited++;
      throw new CliFailure("codex", "limit");
    }, () => {}, [0, 0]),
  );
  assert.equal(limited, 1);
  assert.equal(isRetryable(new Error("codex: 응답 시간 제한")), true);
  assert.equal(isRetryable(new Error("codex: 구독 사용량 제한")), false);
});
