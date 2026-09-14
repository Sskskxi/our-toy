import test from "node:test";
import assert from "node:assert/strict";
process.env.MOCK_DELAY_MS = "0";
const { callAdaptive, effortFor, lowerEffort } = await import("../lib/engine");
const { CliFailure, effortTimeFactor, isVolumeFailure, stageTimeout } = await import("../lib/cli-errors");
import type { Result } from "../lib/types";

const ok = (effort?: string) => ({ answer: { questions: [], claims: [], critiques: [], unresolved: [], resolved: [], summary: `ok ${effort}` }, observedUrls: [], tokens: 1, model: "m" }) as Result;

test("slow stages cap heavy effort at high unless disabled", () => {
  assert.equal(effortFor("revise", "max", {}), "high");
  assert.equal(effortFor("explore", "xhigh", {}), "high");
  assert.equal(effortFor("conversation", "max", {}), "high");
  assert.equal(effortFor("draft", "max", {}), "max");
  assert.equal(effortFor("synthesis", "max", {}), "max");
  assert.equal(effortFor("revise", "medium", {}), "medium");
  assert.equal(effortFor("revise", "max", { EFFORT_CAP: "off" }), "max");
  assert.equal(effortFor("revise", undefined, {}), undefined);
});

test("effort steps down and heavier effort gets more time", () => {
  assert.deepEqual(["max", "xhigh", "high", "medium", "low", undefined].map(lowerEffort), ["high", "high", "medium", "low", undefined, undefined]);
  assert.equal(stageTimeout("revise", {}, 1 * effortTimeFactor("max")), 1_800_000);
  assert.equal(stageTimeout("revise", {}, 1.5 * effortTimeFactor("high")), 900_000);
});

test("a too-slow or too-large answer is retried one effort step lower", async () => {
  const seen: (string | undefined)[] = [];
  const notes: string[] = [];
  const out = await callAdaptive(async (effort) => {
    seen.push(effort);
    if (seen.length === 1) throw new CliFailure("claude", "timeout", "1800초 초과");
    return ok(effort);
  }, "max", (n) => notes.push(n));
  assert.deepEqual(seen, ["max", "high"]);
  assert.equal(out.effort, "high");
  assert.match(notes[0], /max에서 high로 낮춰/);

  const big: (string | undefined)[] = [];
  const res = await callAdaptive(async (effort) => {
    big.push(effort);
    if (big.length === 1) throw new CliFailure("codex", "output", "출력이 16MB를 넘었습니다");
    return ok(effort);
  }, "high", () => {});
  assert.deepEqual(big, ["high", "medium"]);
  assert.equal(res.effort, "medium");
  assert.equal(isVolumeFailure(new CliFailure("codex", "output", "구조화된 답변 형식이 다릅니다")), false);
});

test("overload retries keep the same effort; limits are not retried", async () => {
  const seen: (string | undefined)[] = [];
  await callAdaptive(async (effort) => {
    seen.push(effort);
    if (seen.length === 1) throw new CliFailure("claude", "transient", "529");
    return ok(effort);
  }, "high", () => {});
  assert.deepEqual(seen, ["high", "high"]);
  let calls = 0;
  await assert.rejects(callAdaptive(async () => { calls++; throw new CliFailure("codex", "limit"); }, "high", () => {}));
  assert.equal(calls, 1);
});

test("revisions merge by section: replace, append, key points, empty and full documents", async () => {
  const { mergeSections } = await import("../lib/engine");
  const doc = "### 핵심 요점\n- 옛 요점\n\n## 1. 배경\n옛 배경\n\n## 2. 방법\n옛 방법\n> ⚖️ 쟁점: A vs B";
  const patched = mergeSections(doc, "## 2. 방법\n새 방법 (RFC 8693)\n\n## 3. 한계\n새 섹션");
  assert.match(patched, /## 1\. 배경\n옛 배경/);
  assert.match(patched, /## 2\. 방법\n새 방법 \(RFC 8693\)/);
  assert.doesNotMatch(patched, /옛 방법|⚖️/);
  assert.ok(patched.indexOf("## 3. 한계") > patched.indexOf("## 2. 방법"));
  assert.match(patched, /### 핵심 요점\n- 옛 요점/);
  const keys = mergeSections(doc, "### 핵심 요점\n- **새 요점** 제26조");
  assert.match(keys, /새 요점/);
  assert.doesNotMatch(keys, /옛 요점/);
  assert.match(keys, /## 1\. 배경/);
  assert.equal(mergeSections(doc, "  "), doc);
  assert.equal(mergeSections(doc, doc), doc);
  assert.match(mergeSections(doc, "##   1.  배경\n다른 공백"), /다른 공백/);
});
