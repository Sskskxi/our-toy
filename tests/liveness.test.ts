import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-tests-"));
process.env.MOCK_DELAY_MS = "0";
const { execute, decodeClaude, progressTracker, buildClaudeArgs } = await import("../lib/subscription");
const { callLimits, CliFailure } = await import("../lib/cli-errors");
const { create, save } = await import("../lib/store");
const { run } = await import("../lib/engine");
const { mock } = await import("../lib/mock");
import type { CallProgress, Request } from "../lib/types";

const node = (script: string) => [process.execPath, ["-e", script]] as const;

test("call limits: stop on silence, not on a long healthy run", () => {
  assert.deepEqual(callLimits({}), { maxMs: 120 * 60_000, idleMs: 900_000 });
  assert.deepEqual(callLimits({ CLI_IDLE_SECONDS: "300", CLI_MAX_MINUTES: "180" }), { maxMs: 180 * 60_000, idleMs: 300_000 });
  assert.equal(callLimits({ CLI_TIMEOUT_SECONDS: "600" }).maxMs, 600_000, "legacy total limit still wins");
  assert.deepEqual(callLimits({ CLI_IDLE_SECONDS: "5", CLI_MAX_MINUTES: "1" }), { maxMs: 120 * 60_000, idleMs: 900_000 }, "values below the floor fall back to defaults");
  assert.equal(callLimits({}, 1.5).maxMs, 180 * 60_000);
});

test("a process that keeps printing outlives the idle limit; a silent one is stopped", async () => {
  const [cmd, chatty] = node("let n=0;const t=setInterval(()=>{console.log('tick');if(++n===8){clearInterval(t)}},100)");
  const chunks: string[] = [];
  const out = await execute(cmd, [...chatty], os.tmpdir(), "", 10_000, { idleMs: 400, onOutput: (c) => chunks.push(c) });
  assert.match(out, /tick/);
  assert.ok(chunks.length >= 2, "output is streamed while running");
  const [, silent] = node("console.log('start');setTimeout(()=>{},5000)");
  const started = Date.now();
  await assert.rejects(execute(cmd, [...silent], os.tmpdir(), "", 10_000, { idleMs: 400 }), (e: unknown) => {
    assert.ok(e instanceof CliFailure);
    assert.equal(e.kind, "timeout");
    assert.match(e.message, /응답 없음/);
    return true;
  });
  assert.ok(Date.now() - started < 3000, "stopped soon after going silent");
  const [, endless] = node("setInterval(()=>console.log('still working'),50)");
  await assert.rejects(execute(cmd, [...endless], os.tmpdir(), "", 600, { idleMs: 400 }), /전체 .*초과/);
});

test("claude streams events and the final result event is decoded", () => {
  const args = buildClaudeArgs({ model: "claude-opus-5", effort: "high", search: true, schema: "{}" });
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
  const answer = { questions: [], claims: [], critiques: [], unresolved: [], resolved: [], summary: "본문" };
  const stream = [
    { type: "system", subtype: "init" },
    { type: "rate_limit_event", rate_limit_info: {} },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch" }] } },
    { type: "result", subtype: "success", is_error: false, structured_output: answer, usage: { input_tokens: 10, output_tokens: 5 } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const result = decodeClaude(stream, "claude-opus-5");
  assert.equal(result.answer.summary, "본문");
  assert.equal(result.tokens, 15);
  assert.equal(decodeClaude(JSON.stringify({ type: "result", subtype: "success", structured_output: answer }), "m").answer.summary, "본문", "plain JSON still works");
  assert.throws(() => decodeClaude('{"type":"system"}\n{"type":"assistant"}', "m"), /형식|JSON/);
  const seen: CallProgress[] = [];
  const track = progressTracker((p) => seen.push(p), 0);
  track(stream.slice(0, 40));
  track(stream.slice(40) + "\n");
  assert.equal(seen.at(-1)!.events, 4);
  assert.equal(seen.at(-1)!.searches, 1);
});

const input = { topic: "공공 에이전트 권한 관리 정책 검증", mode: "mock" as const, maxRounds: 2, minRounds: 1, noveltyThreshold: 0.12 };
const stalled = () => new CliFailure("claude", "timeout", "15분 동안 응답 없음");

for (const strategy of ["codraft", "relay"] as const)
  test(`${strategy}: a stalled turn is skipped and the other model keeps the round going`, async () => {
    const stage = strategy === "codraft" ? "revise" : "explore";
    const p = create({ ...input, strategy });
    await run(p, async (r: Request) => {
      if (r.actor === "Claude" && r.stage === stage && r.round === 1) throw stalled();
      return mock(r);
    }, () => save(p));
    assert.equal(p.status, "complete", p.error);
    assert.deepEqual(p.rounds[0].skipped, ["Claude"]);
    assert.ok(p.rounds.length >= 2, "a skipped turn does not count as agreement");
    assert.ok(p.calls.some((c) => c.actor === "Claude" && c.stage === stage && c.round === 1 && c.status === "failed"));
    assert.ok(p.calls.some((c) => c.actor === "GPT" && c.stage === stage && c.round === 1 && c.status === "complete"));
  });

test("when every turn of a round stalls the run fails and can resume", async () => {
  const p = create({ ...input, strategy: "codraft" });
  await run(p, async (r: Request) => {
    if (r.stage === "revise") throw stalled();
    return mock(r);
  }, () => save(p));
  assert.equal(p.status, "failed");
  assert.match(p.error!, /응답이 멈췄거나/);
  await run(p, mock, () => save(p));
  assert.equal(p.status, "complete", "resume retries the stalled turns");
});

test("other failures are not skipped", async () => {
  const p = create({ ...input, strategy: "codraft" });
  await run(p, async (r: Request) => {
    if (r.actor === "Claude" && r.stage === "revise") throw new CliFailure("claude", "auth", "login");
    return mock(r);
  }, () => save(p));
  assert.equal(p.status, "failed");
  assert.equal(p.rounds[0].skipped, undefined);
});

const limitError = () => new CliFailure("claude", "limit", "구독 사용량 한도");

test("co-draft: when one account runs out of usage the other keeps the research going", async () => {
  const p = create({ ...input, strategy: "codraft", maxRounds: 3, minRounds: 2 });
  const seen: Request[] = [];
  await run(p, async (r: Request) => {
    seen.push(r);
    if (r.actor === "Claude") throw limitError();
    return mock(r);
  }, () => save(p));
  assert.equal(p.status, "complete", p.error);
  assert.ok(p.limited?.Claude, "the limited model is recorded");
  assert.match(p.limited!.Claude!.note, /한도/);
  assert.ok(!seen.some((r) => r.actor === "Claude" && r.stage === "revise"), "no further Claude turns");
  assert.ok(seen.some((r) => r.actor === "GPT" && r.stage === "revise"));
  assert.ok(!seen.some((r) => r.stage === "merge"), "one draft needs no merge");
  assert.equal(seen.find((r) => r.stage === "synthesis")?.actor, "GPT", "the free model writes the report");
  assert.ok(p.report);
  assert.ok(p.documents!.length >= 2, "the single draft became the shared document");
});

test("relay: a limited model drops out and the rounds continue", async () => {
  const p = create({ ...input, strategy: "relay", maxRounds: 2, minRounds: 1 });
  const seen: Request[] = [];
  await run(p, async (r: Request) => {
    seen.push(r);
    if (r.actor === "GPT" && r.stage === "explore") throw limitError();
    return mock(r);
  }, () => save(p));
  assert.equal(p.status, "complete", p.error);
  assert.ok(p.limited?.GPT);
  assert.equal(seen.filter((r) => r.actor === "GPT" && r.stage === "explore").length, 1, "GPT is asked once, then dropped");
  assert.ok(seen.filter((r) => r.actor === "Claude" && r.stage === "explore").length >= 2);
  assert.equal(seen.find((r) => r.stage === "synthesis")?.actor, "Claude", "the report hands over to the free model");
});

test("single-model stages hand over, and the run stops when both accounts are out", async () => {
  const plan = create({ ...input, strategy: "codraft", maxRounds: 1, minRounds: 1 });
  const seen: Request[] = [];
  await run(plan, async (r: Request) => {
    seen.push(r);
    if (r.actor === "GPT" && r.stage === "plan") throw limitError();
    return mock(r);
  }, () => save(plan));
  assert.equal(plan.status, "complete", plan.error);
  assert.equal(seen.filter((r) => r.stage === "plan").map((r) => r.actor).join(","), "GPT,Claude", "the plan hands over");
  assert.ok(plan.limited?.GPT);

  const both = create({ ...input, strategy: "codraft", maxRounds: 2, minRounds: 1 });
  await run(both, async () => { throw limitError(); }, () => save(both));
  assert.equal(both.status, "failed");
  assert.match(both.error!, /한도/);

  const off = create({ ...input, strategy: "codraft", maxRounds: 2, minRounds: 1 });
  off.soloOnLimit = false;
  await run(off, async (r: Request) => {
    if (r.actor === "Claude") throw limitError();
    return mock(r);
  }, () => save(off));
  assert.equal(off.status, "failed", "the switch keeps the old behaviour");
  assert.equal(off.limited, undefined);
});
