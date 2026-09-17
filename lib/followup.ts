import { randomUUID } from "node:crypto";
import type { Project } from "./types";

// Follow-up research: a question asked after the final report reopens the
// research itself. The engine replays every saved call, runs `rounds` new
// research rounds focused on the question (web search, edits, replies to the
// other model), then re-checks sources, contradictions and writes a new report.

export const FOLLOW_UP_MAX_ROUNDS = 6;
const ROUND_LIMIT = 30;

export type FollowUpInput = { question: string; rounds?: number };

/** Validates and queues a follow-up; returns an error message (해요체) or null. */
export function startFollowUp(p: Project, input: FollowUpInput): string | null {
  const question = input.question?.trim() ?? "";
  if (!question) return "후속 질문을 입력해 주세요.";
  if (question.length > 20000) return "후속 질문은 20,000자 이내로 써 주세요.";
  const rounds = input.rounds ?? 2;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > FOLLOW_UP_MAX_ROUNDS)
    return `추가 라운드는 1~${FOLLOW_UP_MAX_ROUNDS} 사이로 정해 주세요.`;
  // A follow-up whose run stopped (failed or interrupted) can take another
  // question: its rounds are added after the rounds already planned.
  const unfinished = (p.status === "failed" || p.status === "interrupted") && Boolean(p.followUps?.length);
  if (!(p.status === "complete" && p.report) && !unfinished)
    return "보고서가 나온 연구에서만 후속 심층 조사를 할 수 있어요.";
  if (p.mode === "live") return "직접 API 기록은 다시 실행할 수 없습니다.";
  if (p.conversation.turns.some((t) => t.status === "running" || t.status === "queued"))
    return "후속 대화 답변이 끝난 뒤 시작할 수 있어요.";
  const fromRound = unfinished ? Math.max(p.maxRounds, p.rounds.length) : p.rounds.length;
  if (fromRound + rounds > ROUND_LIMIT)
    return `라운드는 모두 ${ROUND_LIMIT}회까지예요. 지금 ${fromRound}회를 했어요.`;
  const now = new Date().toISOString();
  if (p.report)
    p.reportHistory = [...(p.reportHistory ?? []), { createdAt: p.updatedAt, markdown: p.report }].slice(-5);
  p.followUps = [...(p.followUps ?? []), { id: randomUUID(), question, createdAt: now, fromRound, rounds }];
  // New rounds must run even if the saved rounds had converged; stop rules
  // may end the follow-up early only after its first round.
  p.maxRounds = fromRound + rounds;
  p.minRounds = fromRound + 1;
  p.report = undefined;
  p.stopReason = undefined;
  p.status = "queued";
  p.stage = "후속 심층 조사 대기";
  p.error = undefined;
  p.autoResume = undefined;
  return null;
}

/** Follow-ups a call in `round` should work on, newest last. */
export function followUpsFor(p: Project, round: number) {
  return (p.followUps ?? []).filter((f) => round > f.fromRound);
}

const REPORT_STAGE_NAMES = ["synthesis", "report-edit"];

/**
 * Queue a new final report from the saved research: research calls replay and
 * only the report stages run again. Used by "보고서 다시 쓰기" and after a
 * follow-up chat answer, so the report keeps up with what the owner asked for.
 */
export function queueReportRefresh(p: Project, stage: string) {
  if (p.status !== "complete" || !p.report) return false;
  p.reportHistory = [...(p.reportHistory ?? []), { createdAt: p.updatedAt, markdown: p.report }].slice(-5);
  p.calls = p.calls.filter((c) => !REPORT_STAGE_NAMES.includes(c.stage));
  // The old report stays readable (and answerable) until the new one lands.
  p.status = "queued";
  p.stage = stage;
  p.error = undefined;
  p.autoResume = undefined;
  return true;
}
