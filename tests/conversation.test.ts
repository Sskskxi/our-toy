import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { create, get, save } from "../lib/store";
import { enqueueMessage, runConversation } from "../lib/conversation";
import { mock } from "../lib/mock";
import type { Project, Provider, Request } from "../lib/types";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-tests-"));
process.env.MOCK_DELAY_MS = "0";

function completedProject(): Project {
  const p = create({
    topic: "공공 에이전트 권한 정책의 후속 검토",
    referenceText: "후속 대화 참고 원문",
    attachments: [{ name: "private.md", text: "첨부 원문" }],
    mode: "mock",
    maxRounds: 1,
    minRounds: 1,
    noveltyThreshold: 0.12,
  });
  p.status = "complete";
  p.report = "# 저장된 연구 보고서\n핵심 결론";
  p.providerSessions = { GPT: "mock-gpt-session", Claude: "mock-claude-session" };
  save(p);
  return p;
}

test("one project conversation can target GPT, Claude, or both without resuming CLI sessions", async () => {
  const p = completedProject();
  const seen: Request[] = [];
  const spy: Provider = async (request) => {
    seen.push(structuredClone(request));
    return mock(request);
  };

  const gptTurn = enqueueMessage(p, { message: "GPT 관점만 설명해줘", target: "GPT" });
  await runConversation(p, gptTurn.id, spy, () => {});
  assert.equal(gptTurn.status, "complete");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].actor, "GPT");
  // Legacy saved sessions are ignored: every call is self-contained.
  assert.equal(seen[0].sessionId, undefined);
  const ctx = seen[0].context as { projectReport: string; userReferences?: { files: unknown[] } };
  assert.match(ctx.projectReport, /저장된 연구 보고서/);
  assert.equal(ctx.userReferences?.files.length, 1);

  const bothTurn = enqueueMessage(p, { message: "두 모델이 각각 반론을 제시해줘", target: "both" });
  await runConversation(p, bothTurn.id, spy, () => {});
  const bothCalls = seen.slice(1);
  assert.deepEqual(bothCalls.map((r) => r.actor), ["GPT", "Claude", "GPT"]);
  assert.equal(bothCalls[0].stage, "conversation");
  assert.equal(bothCalls[1].stage, "conversation");
  assert.equal(bothCalls[2].stage, "conversation-synthesis");
  assert.ok(bothTurn.responses.GPT);
  assert.ok(bothTurn.responses.Claude);
  assert.ok(bothTurn.synthesis);
  assert.ok(bothTurn.answer);

  // Without resumed sessions, follow-ups carry the saved report and capped
  // references; the synthesis step merges drafts and needs no raw references.
  for (const request of bothCalls) {
    const context = JSON.stringify(request.context);
    assert.match(context, /저장된 연구 보고서/);
    if (request.stage === "conversation") assert.match(context, /후속 대화 참고 원문/);
    else assert.doesNotMatch(context, /첨부 원문/);
  }
});

test("conversation persists after reload, serializes messages, and retries failed partial turns", async () => {
  const p = completedProject();
  const first = enqueueMessage(p, { message: "첫 질문", target: "Claude" });
  await runConversation(p, first.id, mock, save);
  const reloaded = get(p.id)!;
  assert.equal(reloaded.conversation.turns[0].userText, "첫 질문");
  assert.equal(reloaded.conversation.turns[0].status, "complete");

  const failed = enqueueMessage(reloaded, { message: "둘에게 묻기", target: "both" });
  let failClaude = true;
  const flaky: Provider = async (request) => {
    if (failClaude && request.actor === "Claude") throw new Error("Claude unavailable");
    return mock(request);
  };
  await runConversation(reloaded, failed.id, flaky, () => {});
  assert.equal(failed.status, "failed");
  assert.ok(failed.responses.GPT);
  assert.equal(failed.responses.Claude, undefined);

  failClaude = false;
  failed.status = "queued";
  await runConversation(reloaded, failed.id, flaky, () => {});
  assert.equal(failed.status, "complete");
  assert.equal(failed.attempts, 2);
  assert.ok(failed.responses.GPT);
  assert.ok(failed.responses.Claude);
});

test("message validation and legacy project migration are safe", () => {
  const p = completedProject();
  assert.throws(() => enqueueMessage(p, { message: " ", target: "GPT" }));
  assert.throws(() => enqueueMessage(p, { message: "x".repeat(20001), target: "Claude" }));

  delete (p as Partial<Project>).conversation;
  delete (p as Partial<Project>).providerSessions;
  save(p);
  const migrated = get(p.id)!;
  assert.ok(migrated.conversation.id);
  assert.deepEqual(migrated.conversation.turns, []);
  assert.deepEqual(migrated.providerSessions, {});
});

test.after(() => {
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});
