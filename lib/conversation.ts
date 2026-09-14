import { randomUUID } from "node:crypto";
import { messageSchema, type Actor, type MessageInput, type Project, type Provider, type Result, type Stage } from "./types";
import { provider } from "./provider";
import { referenceContext, retryNote, timeoutScaleFor, withRetry } from "./engine";
import { planTurnRetry, TURN_RETRIES } from "./auto-resume";
import { get, save } from "./store";
import { CancelledError, clearCancel, isCancelRequested, throwIfCancelled } from "./control";

const now = () => new Date().toISOString();

export function enqueueMessage(p: Project, raw: MessageInput) {
  const input = messageSchema.parse(raw);
  p.conversation ??= {
    id: randomUUID(),
    createdAt: p.createdAt,
    memory: "",
    turns: [],
  };
  const turn: Project["conversation"]["turns"][number] = {
    id: randomUUID(),
    target: input.target,
    userText: input.message,
    status: "queued",
    attempts: 0,
    createdAt: now(),
    updatedAt: now(),
    ...(input.models ? { models: input.models } : {}),
    responses: {},
  };
  p.conversation.turns.push(turn);
  return turn;
}

/** Pull turns added or retried on disk into the in-memory project. */
export function mergeTurnsFromDisk(p: Project, activeTurnId: string) {
  let disk: Project | undefined;
  try {
    disk = get(p.id);
  } catch {
    return;
  }
  if (!disk) return;
  const mine = new Map(p.conversation.turns.map((t) => [t.id, t]));
  for (const turn of disk.conversation?.turns ?? []) {
    const current = mine.get(turn.id);
    if (!current) p.conversation.turns.push(turn);
    else if (turn.id !== activeTurnId && turn.updatedAt > current.updatedAt)
      Object.assign(current, turn);
  }
  p.conversation.turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function buildConversationContext(
  p: Project,
  turnId: string,
  { references = true } = {},
) {
  const turns = p.conversation?.turns ?? [];
  const current = turns.find((turn) => turn.id === turnId);
  return {
    projectReport: (p.report ?? "최종 보고서 없음 (연구가 중간에 멈춤)").slice(0, 16000),
    // A stopped co-draft still has its latest shared document.
    ...(!p.report && p.documents?.length
      ? { latestSharedDocument: p.documents.at(-1)!.markdown.slice(0, 16000) }
      : {}),
    projectStatus: p.status,
    claimLedger: p.claims.slice(0, 40).map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      confidence: claim.confidence,
      status: claim.status,
    })),
    unresolvedQuestions: p.unresolved.slice(0, 20),
    rollingMemory: (p.conversation?.memory ?? "").slice(-12000),
    recentConversation: turns
      .filter((turn) => turn.id !== turnId && turn.status === "complete")
      .slice(-6)
      .map((turn) => ({
        target: turn.target,
        user: turn.userText.slice(0, 4000),
        assistant: (turn.answer ?? "").slice(0, 8000),
      })),
    currentMessage: current?.userText ?? "",
    continuity:
      "This continues one locally persisted project conversation. Each call starts without prior model memory: rely on the report, ledger, rolling memory, recent turns and user references given here.",
    ...(references ? referenceContext(p, "conversation", 20000) : {}),
  };
}

function refreshMemory(p: Project) {
  p.conversation.memory = p.conversation.turns
    .filter((turn) => turn.status === "complete")
    .slice(-6)
    .map(
      (turn) =>
        `사용자(${turn.target}): ${turn.userText.slice(0, 2000)}\n답변: ${(turn.answer ?? "").slice(0, 5000)}`,
    )
    .join("\n\n")
    .slice(-12000);
}

export async function runConversation(
  p: Project,
  turnId: string,
  callProvider: Provider = provider,
  persist: (p: Project) => void = save,
) {
  const turn = p.conversation?.turns.find((item) => item.id === turnId);
  if (!turn || turn.status !== "queued") return p;
  const activeTurn = turn;
  const record = () => {
    activeTurn.updatedAt = now();
    // The web server may have queued new messages or retries while this turn
    // ran; merge them in so this save does not overwrite them.
    if (persist === save) mergeTurnsFromDisk(p, activeTurn.id);
    persist(p);
  };

  async function call(actor: Actor, stage: Stage, context: unknown): Promise<Result> {
    const entry: Project["calls"][number] = {
      actor,
      stage,
      round: p.rounds.length,
      status: "running",
      startedAt: now(),
    };
    p.calls.push(entry);
    record();
    try {
      const result = await withRetry((attempt) => callProvider({
        actor,
        stage,
        round: p.rounds.length,
        topic: p.topic,
        questions: [activeTurn.userText],
        context,
        model: activeTurn.models?.[actor]?.model ?? p.models?.[actor]?.model,
        effort: activeTurn.models?.[actor]?.effort ?? p.models?.[actor]?.effort,
        mode: p.mode,
        projectId: p.id,
        timeoutScale: timeoutScaleFor(attempt),
      }), (attempt, error, total) => {
        entry.error = retryNote(attempt, total, error);
        record();
      });
      entry.error = undefined;
      entry.result = result;
      entry.status = "complete";
      p.tokens += result.tokens;
      return result;
    } catch (error) {
      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : "후속 대화 호출 실패";
      throw error;
    } finally {
      entry.finishedAt = now();
      record();
    }
  }

  try {
    turn.status = "running";
    turn.attempts += 1;
    turn.error = undefined;
    p.stage = "후속 대화 응답 중";
    record();
    throwIfCancelled(p.id);
    const actors: Actor[] =
      turn.target === "both" ? ["GPT", "Claude"] : [turn.target];
    const missing = actors.filter((actor) => !turn.responses[actor]);
    const context = buildConversationContext(p, turn.id);
    const settled = await Promise.allSettled(
      missing.map(async (actor) => {
        const result = await call(actor, "conversation", context);
        turn.responses[actor] = result;
      }),
    );
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;

    if (turn.target === "both") {
      if (!turn.synthesis) {
        p.stage = "두 모델 답변 공동 정리 중";
        record();
        turn.synthesis = await call("GPT", "conversation-synthesis", {
          ...buildConversationContext(p, turn.id, { references: false }),
          drafts: {
            GPT: turn.responses.GPT?.answer,
            Claude: turn.responses.Claude?.answer,
          },
        });
      }
      turn.answer = turn.synthesis.answer.summary;
    } else {
      turn.answer = turn.responses[turn.target]?.answer.summary;
    }
    if (!turn.answer?.trim()) {
      // Drop the empty responses so a retry calls the models again.
      turn.responses = {};
      turn.synthesis = undefined;
      throw new Error("후속 대화 답변이 비어 있습니다.");
    }
    turn.status = "complete";
    turn.autoRetry = undefined;
    refreshMemory(p);
    p.stage = "연구 완료 · 대화 가능";
  } catch (error) {
    turn.status = "failed";
    const cancelled = error instanceof CancelledError || isCancelRequested(p.id);
    turn.error = cancelled
      ? "사용자가 중지했습니다. 다시 시도할 수 있습니다."
      : error instanceof Error
        ? error.message
        : "후속 대화 실행 실패";
    turn.autoRetry = cancelled ? undefined : planTurnRetry(turn, error, new Date());
    p.stage = cancelled
      ? "대화 중지 · 재시도 가능"
      : turn.autoRetry
        ? `대화 응답 오류 · 잠시 뒤 자동으로 다시 시도해요 (${turn.autoRetry.attempts}/${TURN_RETRIES})`
        : "대화 응답 오류 · 재시도 가능";
  }
  clearCancel(p.id);
  record();
  return p;
}
