import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codraft-tests-"));
process.env.MOCK_DELAY_MS = "0";
const { create, get } = await import("../lib/store");
const { run } = await import("../lib/engine");
const { mock } = await import("../lib/mock");
const { addIntervention } = await import("../lib/interventions");
import type { Provider, Request } from "../lib/types";

const input = {
  topic: "도시 녹지 정책의 열섬 완화 효과",
  mode: "mock" as const,
  maxRounds: 4,
  minRounds: 1,
  noveltyThreshold: 0.12,
};

test("shared draft: independent drafts, one merge, alternating edits, stop when both have no changes", async () => {
  const p = create(input);
  assert.equal(p.strategy, "codraft");
  const seen: Request[] = [];
  await run(p, async (r) => {
    seen.push(structuredClone(r));
    return mock(r);
  });
  assert.equal(p.status, "complete");
  const order = seen.map((r) => `${r.actor}:${r.stage}:${r.round}`);
  assert.deepEqual(
    order.slice(0, 4).sort(),
    ["Claude:draft:1", "GPT:draft:1", "GPT:merge:1", "GPT:plan:0"].sort(),
  );
  // Drafts are independent: neither sees the other.
  assert.ok(
    seen
      .filter((r) => r.stage === "draft")
      .every((r) => (r.context as { stageContext: unknown }).stageContext === null),
  );
  // Claude edits the GPT merge first, then GPT; each edit sees the latest version.
  assert.deepEqual(
    order.filter((o) => o.includes("revise")),
    ["Claude:revise:1", "GPT:revise:1", "Claude:revise:2", "GPT:revise:2"],
  );
  const gptTurn1 = seen.find((r) => r.actor === "GPT" && r.stage === "revise" && r.round === 1)!;
  const ctx = (gptTurn1.context as { stageContext: { document: string; lastEditor: string } })
    .stageContext;
  assert.match(ctx.document, /Claude 보강/);
  assert.equal(ctx.lastEditor, "Claude");
  // Round 2 had no changes from either model, so the loop stopped before maxRounds.
  assert.equal(p.rounds.length, 2);
  assert.match(p.stopReason!, /더 고칠 부분이 없다/);
  // A different model from the aggregator writes the final report, from the shared document.
  const synth = seen.find((r) => r.stage === "synthesis")!;
  assert.equal(synth.actor, "Claude");
  assert.match(JSON.stringify(synth.context), /⚖️ 쟁점/);
  // Every version is kept with its author and change list.
  const docs = get(p.id)!.documents!;
  assert.deepEqual(
    docs.map((d) => `${d.version}:${d.author}:${d.stage}`),
    [
      "1:GPT:draft",
      "2:Claude:draft",
      "3:GPT:merge",
      "4:Claude:revise",
      "5:GPT:revise",
      "6:Claude:revise",
      "7:GPT:revise",
    ],
  );
  assert.equal(docs[3].changes.length, 1);
  assert.equal(docs[5].changes.length, 0);
  assert.equal(docs[6].markdown, docs[4].markdown, "an unchanged turn keeps the text");
});

test("interrupted run resumes from its last completed step without re-calling models", async () => {
  const p = create(input);
  const failing: Provider = async (r) => {
    if (r.stage === "revise" && r.actor === "GPT" && r.round === 1)
      throw new Error("codex: 구독 사용량 제한에 도달했습니다.");
    return mock(r);
  };
  await run(p, failing);
  assert.equal(p.status, "failed");
  // plan, 2 drafts, merge, Claude's revision
  assert.equal(p.calls.filter((c) => c.status === "complete").length, 5);

  // The user steers while it is paused; the note must reach the first live step.
  addIntervention(p.id, { text: "비용도 비교해 주세요" });
  const live: Request[] = [];
  const resumed = get(p.id)!;
  resumed.status = "queued";
  await run(resumed, async (r) => {
    live.push(structuredClone(r));
    return mock(r);
  });
  assert.equal(resumed.status, "complete");
  assert.equal(`${live[0].actor}:${live[0].stage}:${live[0].round}`, "GPT:revise:1");
  assert.deepEqual((live[0].context as { humanGuidance?: string[] }).humanGuidance, [
    "비용도 비교해 주세요",
  ]);
  assert.ok(!live.some((r) => ["plan", "draft", "merge"].includes(r.stage)));
  assert.equal(resumed.calls.filter((c) => c.replayed).length, 5);
  assert.equal(resumed.interventions![0].appliedStage, "revise");
  // Rebuilt state matches a clean run: versions are not duplicated.
  assert.deepEqual(
    resumed.documents!.map((d) => d.version),
    resumed.documents!.map((_, i) => i + 1),
  );
  assert.ok(resumed.report);
});

test("a timed-out call is retried once automatically", async () => {
  const p = create({ ...input, maxRounds: 1 });
  let attempts = 0;
  await run(p, async (r) => {
    if (r.stage === "merge" && attempts++ === 0)
      throw new Error("codex: 응답 시간 제한. 중간 기록을 보존했습니다.");
    return mock(r);
  });
  assert.equal(p.status, "complete");
  assert.equal(attempts, 2);
  assert.equal(p.calls.find((c) => c.stage === "merge")!.error, undefined);
});
