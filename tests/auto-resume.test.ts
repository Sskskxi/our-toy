import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "auto-resume-tests-"));
process.env.MOCK_DELAY_MS = "0";
const { CliFailure } = await import("../lib/cli-errors");
const { planAutoResume, planRestartResume, planTurnRetry, postponeLimitResume, usageAllowsResume, LIMIT_CHECKS } =
  await import("../lib/auto-resume");
const { tickAutoResume } = await import("../lib/auto-resume-scheduler");
const { briefs, create, get, save } = await import("../lib/store");
const { run } = await import("../lib/engine");
const { enqueueMessage, runConversation } = await import("../lib/conversation");
const { mock } = await import("../lib/mock");
import type { AccountUsage } from "../lib/account-usage";
import type { AutoResume, Provider } from "../lib/types";

const now = new Date("2026-09-14T00:00:00.000Z");
const plus = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();

test("transient and timeout failures resume after 3, 6, 9 minutes, then stop", () => {
  const timeout = new CliFailure("claude", "timeout", "600초 초과");
  let previous: AutoResume | undefined;
  for (const attempts of [1, 2, 3]) {
    previous = planAutoResume({ error: timeout, previous, progressed: false, now });
    assert.equal(previous?.reason, "transient");
    assert.equal(previous?.attempts, attempts);
    assert.equal(previous?.at, plus(3 * attempts));
    assert.match(previous!.note, new RegExp(`자동으로 이어서 실행해요 \\(${attempts}/3\\)`));
  }
  assert.equal(planAutoResume({ error: timeout, previous, progressed: false, now }), undefined);
  // A run that moved forward starts counting again.
  const reset = planAutoResume({ error: new CliFailure("codex", "transient", "503"), previous, progressed: true, now });
  assert.equal(reset?.attempts, 1);
  // Plain provider errors that read like timeouts count too.
  assert.equal(planAutoResume({ error: new Error("응답 시간 제한"), progressed: false, now })?.reason, "transient");
});

test("usage limits wait 15 minutes per check for about 10 hours and name the provider", () => {
  const limit = planAutoResume({ error: new CliFailure("codex", "limit"), progressed: false, now });
  assert.deepEqual(limit, {
    reason: "limit",
    attempts: 1,
    at: plus(15),
    provider: "GPT",
    note: "사용량 한도가 풀리면 자동으로 이어서 실행해요",
  });
  assert.equal(planAutoResume({ error: new CliFailure("claude", "limit"), progressed: false, now })?.provider, "Claude");
  const near = { ...limit!, attempts: LIMIT_CHECKS - 1 };
  assert.equal(postponeLimitResume(near, now)?.attempts, LIMIT_CHECKS);
  assert.equal(postponeLimitResume({ ...near, attempts: LIMIT_CHECKS }, now), undefined);
  assert.equal(planAutoResume({ error: new CliFailure("claude", "limit"), previous: { ...near, attempts: LIMIT_CHECKS }, progressed: false, now }), undefined);
});

test("login, model, CLI, output and unknown failures never auto-resume", () => {
  for (const kind of ["auth", "model", "cli", "output", "unknown"] as const)
    assert.equal(planAutoResume({ error: new CliFailure("claude", kind), progressed: false, now }), undefined);
  assert.equal(planAutoResume({ error: new Error("연구 질문이 없습니다."), progressed: false, now }), undefined);
});

test("restart resumes stop after repeated restarts without progress", () => {
  let plan = planRestartResume(undefined, [], now);
  assert.equal(plan?.attempts, 1);
  plan = planRestartResume(plan, [{ status: "complete", replayed: true, finishedAt: plus(5) }], now);
  assert.equal(plan?.attempts, 2);
  plan = planRestartResume(plan, [], now);
  assert.equal(planRestartResume(plan, [], now), undefined);
  // A new finished call after the last restart resets the count.
  assert.equal(planRestartResume(plan, [{ status: "complete", finishedAt: plus(5) }], now)?.attempts, 1);
});

test("usage check allows a resume only when every window has quota left", () => {
  assert.equal(usageAllowsResume({ status: "unavailable" }), undefined);
  assert.equal(usageAllowsResume({ status: "available", short: { remainingPercent: 0 }, weekly: { remainingPercent: 40 } }), false);
  assert.equal(usageAllowsResume({ status: "available", short: { remainingPercent: 3 } }), true);
});

test("follow-up turns retry twice after retryable failures only", () => {
  const transient = new CliFailure("claude", "transient");
  assert.deepEqual(planTurnRetry({}, transient, now), { attempts: 1, at: new Date(now.getTime() + 30_000).toISOString() });
  assert.equal(planTurnRetry({ autoRetry: { attempts: 1, at: plus(0) } }, transient, now)?.attempts, 2);
  assert.equal(planTurnRetry({ autoRetry: { attempts: 2, at: plus(0) } }, transient, now), undefined);
  assert.equal(planTurnRetry({}, new CliFailure("claude", "auth"), now), undefined);
});

const input = { topic: "자동 재개 동작 확인용 연구", mode: "mock" as const, maxRounds: 1, minRounds: 1, noveltyThreshold: 0.12 };

test("a failed run records its automatic resume and a completed run clears it", async () => {
  const p = create(input);
  let fail = true;
  const flaky: Provider = async (r) => {
    if (fail && r.stage === "merge") throw new CliFailure("claude", "transient", "529");
    return mock(r);
  };
  await run(p, flaky);
  assert.equal(p.status, "failed");
  assert.equal(p.autoResume?.reason, "transient");
  assert.equal(p.autoResume?.attempts, 1);
  assert.match(p.stage, /자동으로 이어서 실행해요/);
  assert.equal(p.calls.find((c) => c.stage === "merge")?.status, "failed");

  // Resumed run fails again with only replayed calls before it: counter grows.
  p.status = "queued";
  await run(p, flaky);
  assert.equal(p.autoResume?.attempts, 2);

  fail = false;
  p.status = "queued";
  await run(p, flaky);
  assert.equal(p.status, "complete");
  assert.equal(p.autoResume, undefined);

  const auth = create(input);
  await run(auth, async (r) => {
    if (r.stage === "plan") throw new CliFailure("codex", "auth");
    return mock(r);
  });
  assert.equal(auth.status, "failed");
  assert.equal(auth.autoResume, undefined);
});

test("scheduler requeues due runs and turns, and checks usage before a limit resume", async () => {
  const usage = (remaining: number): AccountUsage => ({
    codex: { status: "available", short: { label: "5h", remainingPercent: remaining }, weekly: { label: "week", remainingPercent: 50 } },
    claude: { status: "unavailable" },
    fetchedAt: now.toISOString(),
  });
  const due = create({ ...input, mode: "subscription" });
  due.status = "failed";
  due.error = "codex: 한도";
  due.autoResume = { reason: "limit", attempts: 1, at: plus(-1), provider: "GPT", note: "n" };
  save(due);
  const later = create(input);
  later.status = "failed";
  later.autoResume = { reason: "transient", attempts: 1, at: plus(60), note: "n" };
  save(later);
  const unavailable = new Map<string, number>();

  // Still no quota: postponed 15 minutes, still failed.
  let resumed = await tickAutoResume({ briefs, get, save, usage: async () => usage(0), now, unavailable });
  assert.deepEqual(resumed, []);
  let p = get(due.id)!;
  assert.equal(p.status, "failed");
  assert.equal(p.autoResume?.attempts, 2);
  assert.equal(p.autoResume?.at, plus(15));

  const afterWait = new Date(now.getTime() + 16 * 60_000);
  resumed = await tickAutoResume({ briefs, get, save, usage: async () => usage(20), now: afterWait, unavailable });
  assert.deepEqual(resumed, [due.id]);
  p = get(due.id)!;
  assert.equal(p.status, "queued");
  assert.equal(p.error, undefined);
  assert.equal(p.stage, "사용량이 회복돼 자동으로 이어서 실행해요");
  assert.equal(p.autoResume?.attempts, 2);
  assert.equal(get(later.id)!.status, "failed");

  const chat = create(input);
  chat.status = "complete";
  const turn = enqueueMessage(chat, { message: "질문", target: "Claude" });
  save(chat);
  await runConversation(chat, turn.id, async () => {
    throw new CliFailure("claude", "transient", "503");
  });
  const failedTurn = get(chat.id)!.conversation.turns[0];
  assert.equal(failedTurn.status, "failed");
  assert.equal(failedTurn.autoRetry?.attempts, 1);
  resumed = await tickAutoResume({
    briefs, get, save, usage: async () => usage(0), now: new Date(Date.now() + 31_000), unavailable,
  });
  assert.equal(get(chat.id)!.conversation.turns[0].status, "queued");
  assert.equal(get(chat.id)!.conversation.turns[0].error, undefined);
});
