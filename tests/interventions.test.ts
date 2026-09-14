import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "intervention-tests-"));
process.env.MOCK_DELAY_MS = "0";
const { create, get, list } = await import("../lib/store");
const { run } = await import("../lib/engine");
const { mock } = await import("../lib/mock");
const {
  addIntervention,
  absorbInterventions,
  guidanceFor,
  readInbox,
  withPendingInterventions,
} = await import("../lib/interventions");
const { resolveModel, buildCodexArgs } = await import("../lib/subscription");
const { inputSchema, messageSchema, interventionSchema } = await import("../lib/types");
const { splitKeyPoints, firstLine } = await import("../app/debate");
import type { Provider, Request } from "../lib/types";

const input = {
  topic: "### 도시 녹지 정책\n- **열섬** 완화 효과",
  mode: "mock" as const,
  strategy: "debate" as const,
  maxRounds: 1,
  minRounds: 1,
  noveltyThreshold: 0.12,
};

test("interventions typed mid-run reach only the targeted model at the next stage", async () => {
  const p = create(input);
  const seen: Request[] = [];
  const spy: Provider = async (r) => {
    seen.push(structuredClone(r));
    // Simulate the user typing while research is in flight.
    if (r.stage === "research" && r.actor === "GPT")
      addIntervention(p.id, { text: "**비용** 측면을 더 보세요", target: "Claude" });
    return mock(r);
  };
  await run(p, spy);
  assert.equal(p.status, "complete");
  const critiques = seen.filter((r) => r.stage === "critique");
  const claude = critiques.find((r) => r.actor === "Claude")!;
  const gpt = critiques.find((r) => r.actor === "GPT")!;
  assert.deepEqual((claude.context as { humanGuidance?: string[] }).humanGuidance, [
    "**비용** 측면을 더 보세요",
  ]);
  assert.equal((gpt.context as { humanGuidance?: string[] }).humanGuidance, undefined);
  // Applied exactly once, and persisted on the project for the UI.
  const later = seen.filter((r) => r.stage === "rebuttal" || r.stage === "synthesis");
  assert.ok(later.every((r) => !(r.context as { humanGuidance?: unknown }).humanGuidance));
  const saved = get(p.id)!;
  assert.equal(saved.interventions?.length, 1);
  assert.equal(saved.interventions![0].appliedStage, "critique");
  assert.equal(saved.interventions![0].appliedRound, 1);
});

test("inbox is separate from the project file and pending notes show until absorbed", () => {
  const p = create(input);
  addIntervention(p.id, { text: "첫 메모" });
  assert.equal(list().filter((x) => x.id === p.id).length, 1);
  assert.equal(withPendingInterventions(get(p.id)!).interventions?.[0].appliedAt, undefined);
  const fresh = absorbInterventions(p, "research", 1);
  assert.equal(fresh.length, 1);
  assert.equal(absorbInterventions(p, "critique", 1).length, 0);
  assert.deepEqual(guidanceFor(p, "GPT", "research", 1), ["첫 메모"]);
  assert.deepEqual(guidanceFor(p, "GPT", "critique", 1), []);
  assert.equal(readInbox(p.id).length, 1);
});

test("intervention input is bounded", () => {
  assert.equal(interventionSchema.safeParse({ text: "   " }).success, false);
  assert.equal(interventionSchema.safeParse({ text: "x".repeat(4001) }).success, false);
  const p = create(input);
  for (let i = 0; i < 50; i++) addIntervention(p.id, { text: `메모 ${i}` });
  assert.throws(() => addIntervention(p.id, { text: "초과" }), /최대/);
  assert.throws(() => readInbox("../../etc/passwd"), /Invalid project ID/);
});

test("UI model choices override env defaults and are validated before reaching the CLI", () => {
  const env = { OPENAI_MODEL: "gpt-env", ANTHROPIC_EFFORT: "medium" };
  assert.deepEqual(resolveModel({ actor: "GPT" }, env), { model: "gpt-env", effort: "high" });
  assert.deepEqual(resolveModel({ actor: "Claude" }, env), {
    model: "claude-opus-5",
    effort: "medium",
  });
  assert.deepEqual(resolveModel({ actor: "GPT", model: "gpt-6-astra", effort: "low" }, env), {
    model: "gpt-6-astra",
    effort: "low",
  });
  // A model ID must not smuggle CLI flags or config.
  for (const model of ["--dangerously-bypass", "-c", "gpt 5", 'gpt";x', "a".repeat(81)])
    assert.throws(() => resolveModel({ actor: "GPT", model }, {}), /설정 오류/);
  assert.throws(() => resolveModel({ actor: "GPT", effort: "max" }, {}), /설정 오류/);
  assert.throws(() => resolveModel({ actor: "Claude", effort: 'low" --x' }, {}), /설정 오류/);
  assert.equal(
    inputSchema.safeParse({ ...input, models: { GPT: { model: "-rf" } } }).success,
    false,
  );
  assert.equal(
    messageSchema.safeParse({ message: "hi", target: "both", models: { Claude: { effort: "max" } } })
      .success,
    true,
  );
  const args = buildCodexArgs({
    model: "gpt-6-astra",
    effort: "low",
    search: false,
    schemaPath: "/s",
    output: "/o",
  });
  assert.equal(args[args.indexOf("--model") + 1], "gpt-6-astra");
});

test("engine passes the project's chosen models to each actor", async () => {
  const p = create({ ...input, models: { Claude: { model: "claude-sonnet-5", effort: "high" } } });
  const seen: Request[] = [];
  await run(p, async (r) => {
    seen.push(r);
    return mock(r);
  });
  assert.ok(
    seen
      .filter((r) => r.actor === "Claude")
      .every((r) => r.model === "claude-sonnet-5" && r.effort === "high"),
  );
  assert.ok(seen.filter((r) => r.actor === "GPT").every((r) => r.model === undefined));
});

test("key points split out of Markdown answers; titles strip Markdown", () => {
  const md = "# 제목\n\n### 핵심 요점\n- **A**: 하나\n- **B**: 둘\n\n### 세부\n본문";
  const { key, rest } = splitKeyPoints(md);
  assert.equal(key, "- **A**: 하나\n- **B**: 둘");
  assert.match(rest, /# 제목/);
  assert.match(rest, /### 세부\n본문/);
  assert.doesNotMatch(rest, /핵심 요점/);
  assert.deepEqual(splitKeyPoints("요점 없음"), { key: "", rest: "요점 없음" });
  assert.equal(firstLine("\n### **도시** 녹지 `정책`\n- 둘째 줄"), "도시 녹지 정책");
});
