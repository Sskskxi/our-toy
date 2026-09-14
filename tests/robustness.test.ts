import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "robust-tests-"));
process.env.MOCK_DELAY_MS = "0";
const { briefs, create, get, list, remove, save, setTitle } = await import("../lib/store");
const { run } = await import("../lib/engine");
const { enqueueMessage, runConversation } = await import("../lib/conversation");
const { mock } = await import("../lib/mock");
const { addIntervention, isPendingNote } = await import("../lib/interventions");
const { requestCancel, isCancelRequested } = await import("../lib/control");
import type { Provider } from "../lib/types";

const base = { topic: "견고성 점검 주제입니다", mode: "mock" as const, maxRounds: 1, minRounds: 1, noveltyThreshold: 0.12 };

test("a message posted while a follow-up answer runs is not overwritten", async () => {
  const p = create(base);
  await run(p, mock);
  const first = enqueueMessage(p, { message: "첫 질문", target: "GPT" });
  save(p);
  const slow: Provider = async (r) => {
    // The web server saves a second message while the worker is mid-answer.
    const disk = get(p.id)!;
    enqueueMessage(disk, { message: "도중에 보낸 질문", target: "Claude" });
    save(disk);
    return mock(r);
  };
  await runConversation(get(p.id)!, first.id, slow);
  const turns = get(p.id)!.conversation.turns;
  assert.deepEqual(turns.map((t) => [t.userText, t.status]), [
    ["첫 질문", "complete"],
    ["도중에 보낸 질문", "queued"],
  ]);
});

test("an empty follow-up answer is called again on retry", async () => {
  const p = create(base);
  await run(p, mock);
  const turn = enqueueMessage(p, { message: "빈 답 시험", target: "GPT" });
  let calls = 0;
  const empty: Provider = async (r) => {
    calls++;
    const res = await mock(r);
    return calls === 1 ? { ...res, answer: { ...res.answer, summary: "" } } : res;
  };
  await runConversation(p, turn.id, empty, () => {});
  assert.equal(turn.status, "failed");
  turn.status = "queued";
  await runConversation(p, turn.id, empty, () => {});
  assert.equal(turn.status, "complete");
  assert.equal(calls, 2);
});

test("an empty merge is a failed call, so resume calls it again", async () => {
  const p = create({ ...base, strategy: "codraft" });
  let merges = 0;
  const provider: Provider = async (r) => {
    const res = await mock(r);
    if (r.stage === "merge" && ++merges === 1) return { ...res, answer: { ...res.answer, summary: "  " } };
    return res;
  };
  await run(p, provider);
  assert.equal(p.status, "failed");
  assert.equal(p.calls.find((c) => c.stage === "merge")?.status, "failed");
  const again = get(p.id)!;
  again.status = "queued";
  await run(again, provider);
  assert.equal(again.status, "complete");
  assert.equal(merges, 2);
});

test("a corrupt project file is skipped instead of breaking the list", () => {
  const good = create(base);
  const badId = "11111111-1111-4111-8111-111111111111";
  fs.writeFileSync(path.join(process.env.DATA_DIR!, `${badId}.json`), '{"id": "trunc');
  assert.equal(get(badId), undefined);
  assert.ok(list().some((p) => p.id === good.id));
  assert.ok(briefs().some((b) => b.id === good.id));
  fs.rmSync(path.join(process.env.DATA_DIR!, `${badId}.json`));
});

test("a Claude-only note is not used up by a GPT-only stage", async () => {
  const p = create({ ...base, strategy: "codraft" });
  addIntervention(p.id, { text: "Claude에게만", target: "Claude" });
  const seen: { actor: string; stage: string; guidance?: string[] }[] = [];
  await run(p, async (r) => {
    seen.push({ actor: r.actor, stage: r.stage, guidance: (r.context as { humanGuidance?: string[] }).humanGuidance });
    return mock(r);
  });
  const got = seen.filter((s) => s.guidance?.includes("Claude에게만"));
  assert.deepEqual(got.map((s) => `${s.actor}:${s.stage}`), ["Claude:draft"]);
  assert.equal(isPendingNote(get(p.id)!.interventions![0]), false);
});

test("a note for both models reaches each model at its next stage; late notes expire", async () => {
  const p = create({ ...base, strategy: "codraft" });
  let injected = false;
  const seen: string[] = [];
  await run(p, async (r) => {
    const g = (r.context as { humanGuidance?: string[] }).humanGuidance ?? [];
    if (g.length) seen.push(`${r.actor}:${r.stage}`);
    if (r.stage === "revise" && r.actor === "Claude" && !injected) {
      injected = true;
      addIntervention(p.id, { text: "둘 다에게" });
    }
    if (r.stage === "synthesis") addIntervention(p.id, { text: "너무 늦은 메모", target: "GPT" });
    return mock(r);
  });
  // GPT gets it on its next turn; Claude (already past its revise) gets it
  // when it writes the final report.
  assert.deepEqual(seen, ["GPT:revise", "Claude:synthesis"]);
  const notes = get(p.id)!.interventions!;
  const both = notes.find((n) => n.text === "둘 다에게")!;
  assert.equal(both.expired, undefined);
  assert.deepEqual(both.deliveries?.map((d) => `${d.actor}:${d.stage}`), ["GPT:revise", "Claude:synthesis"]);
  assert.equal(notes.find((n) => n.text === "너무 늦은 메모")?.expired, true);
});

test("co-draft keeps going while models still edit, even without new claims", async () => {
  const p = create({ ...base, strategy: "codraft", maxRounds: 4, minRounds: 1, noveltyThreshold: 0.5 });
  await run(p, async (r) => {
    const res = await mock(r);
    if (r.stage !== "revise") return res;
    // Real edits every turn in rounds 1-3, but no ledger claims at all.
    const edit = r.round <= 3;
    return {
      ...res,
      answer: {
        ...res.answer,
        claims: [],
        critiques: edit ? [{ claim: "섹션", objection: `라운드 ${r.round} 수정` }] : [],
        summary: `${(r.context as { stageContext: { document: string } }).stageContext.document}${edit ? `\n- ${r.actor} ${r.round}` : ""}`,
      },
    };
  });
  assert.equal(p.status, "complete");
  assert.equal(p.rounds.length, 4);
  assert.match(p.stopReason!, /더 고칠 부분이 없다/);
});

test("stopping a run marks it interrupted and resumable", async () => {
  const p = create({ ...base, strategy: "codraft" });
  await run(p, async (r) => {
    if (r.stage === "merge") requestCancel(p.id);
    return mock(r);
  });
  assert.equal(p.status, "interrupted");
  assert.match(p.error!, /중지/);
  assert.equal(isCancelRequested(p.id), false, "the stop request is cleared");
  const again = get(p.id)!;
  again.status = "queued";
  await run(again, mock);
  assert.equal(again.status, "complete");
});

test("rename is stored beside the project and survives worker saves; delete removes side files", () => {
  const p = create(base);
  setTitle(p.id, "  내 이름  ");
  save(get(p.id)!);
  assert.equal(get(p.id)!.title, "내 이름");
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR!, `${p.id}.json`), "utf8")).title, undefined);
  addIntervention(p.id, { text: "메모" });
  remove(p.id);
  assert.equal(get(p.id), undefined);
  assert.equal(fs.readdirSync(process.env.DATA_DIR!).some((f) => f.startsWith(p.id)), false);
});
