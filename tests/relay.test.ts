import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tests-"));
process.env.MOCK_DELAY_MS = "0";
const { create, get } = await import("../lib/store");
const { run, applyExclusions } = await import("../lib/engine");
const { mock } = await import("../lib/mock");
import type { Request, Result } from "../lib/types";

const input = {
  topic: "재택근무와 생산성",
  mode: "mock" as const,
  strategy: "relay" as const,
  maxRounds: 5,
  minRounds: 1,
  noveltyThreshold: 0.9,
};

test("relay: Claude explores first, each leg builds on the previous one, then GPT reports", async () => {
  const p = create(input);
  const seen: Request[] = [];
  await run(p, async (r) => {
    seen.push(structuredClone(r));
    return mock(r);
  });
  assert.equal(p.status, "complete");
  const legs = seen.filter((r) => r.stage === "explore").map((r) => `${r.actor}:${r.round}`);
  assert.deepEqual(legs.slice(0, 4), ["Claude:1", "GPT:1", "Claude:2", "GPT:2"]);
  const first = seen.find((r) => r.stage === "explore")!;
  assert.equal((first.context as { stageContext: { previousTurn: unknown } }).stageContext.previousTurn, null);
  const gpt1 = seen.find((r) => r.stage === "explore" && r.actor === "GPT" && r.round === 1)!;
  const ctx = (gpt1.context as { stageContext: { previousTurn: { actor: string; threads: string[] }; researchMap: { keptClaims: unknown[] } } }).stageContext;
  assert.equal(ctx.previousTurn.actor, "Claude");
  assert.equal(ctx.previousTurn.threads.length, 1, "Claude's threads are handed over");
  assert.equal(ctx.researchMap.keptClaims.length, 1);
  // Round 2 proposed no more threads, so the relay stopped before maxRounds.
  assert.equal(p.rounds.length, 2);
  assert.match(p.stopReason!, /더 파고들 흐름이 없다/);
  const synth = seen.find((r) => r.stage === "synthesis")!;
  assert.equal(synth.actor, "GPT");
  assert.ok((synth.context as { stageContext: { researchMap?: unknown } }).stageContext.researchMap);
  // Exclusions in round 2 removed the peer's claim and were recorded with a reason.
  const saved = get(p.id)!;
  assert.ok(saved.exclusions!.length >= 1);
  assert.ok(saved.exclusions!.every((e) => e.reason && e.actor && e.round === 2));
  assert.ok(saved.claims.every((c) => !saved.exclusions!.some((e) => e.target === c.statement)));
  assert.match(saved.report!, /탐색 릴레이/);
});

test("excluded material stays out even when a later leg finds it again", async () => {
  const p = create({ ...input, maxRounds: 2, noveltyThreshold: 0 });
  const offTopic = "재택근무와 생산성: 범위 밖 주장";
  await run(p, async (r) => {
    const res: Result = await mock(r);
    if (r.stage !== "explore") return res;
    const answer = { ...res.answer, questions: ["계속"], critiques: [] as { claim: string; objection: string }[] };
    if (r.actor === "Claude") answer.claims = [...answer.claims, { statement: offTopic, sources: [], confidence: 0.3 }];
    if (r.actor === "GPT" && r.round === 1) answer.critiques = [{ claim: offTopic, objection: "범위 밖" }];
    return { ...res, answer };
  });
  const saved = get(p.id)!;
  assert.equal(saved.claims.some((c) => c.statement === offTopic), false);
  assert.equal(saved.exclusions!.filter((e) => e.target === offTopic).length, 1);
});

test("a source URL can be excluded without dropping its claim", () => {
  const p = create(input);
  p.claims = [
    {
      id: "C-1",
      statement: "주장",
      confidence: 0.5,
      actors: ["Claude"],
      rounds: [1],
      status: "source-linked",
      objections: [],
      sources: [
        { url: "https://bad.example/x", title: "나쁜 출처", excerpt: "", provenance: "unverified" },
        { url: "https://good.example/y", title: "좋은 출처", excerpt: "", provenance: "unverified" },
      ],
    },
  ];
  applyExclusions(p, "GPT", 2, {
    answer: { questions: [], claims: [], critiques: [{ claim: "https://bad.example/x", objection: "오래된 자료" }], unresolved: [], resolved: [], summary: "" },
    observedUrls: [],
    tokens: 0,
    model: "mock",
  });
  assert.equal(p.claims.length, 1);
  assert.deepEqual(p.claims[0].sources.map((s) => s.url), ["https://good.example/y"]);
  assert.equal(p.exclusions![0].reason, "오래된 자료");
});
