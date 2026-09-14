import type { Request, Result, Answer } from "./types";
export async function mock(request: Request): Promise<Result> {
  const { actor, stage, round, topic, questions } = request;
  await new Promise((r) =>
    setTimeout(r, Number(process.env.MOCK_DELAY_MS ?? 250)),
  );
  const answer: Answer = {
    questions: [],
    claims: [],
    critiques: [],
    unresolved: [],
    resolved: [],
    summary: "",
  };
  const gap = `${topic}: 실제 환경에서 효과를 검증할 지표와 실증 자료가 충분한가?`;
  const statement =
    actor === "GPT"
      ? `${topic}: 적용 범위와 성공 지표를 먼저 정의해야 한다.`
      : `${topic}: 대안 비교와 실패 조건을 함께 평가해야 한다.`;
  if (stage === "plan")
    answer.questions = [
      `${topic}: 핵심 개념과 적용 범위는 무엇인가?`,
      `${topic}: 기존 접근법의 근거와 한계는 무엇인가?`,
      gap,
    ];
  if (stage === "research" || stage === "rebuttal") {
    answer.claims = [
      {
        statement,
        sources: [
          {
            title: "시뮬레이션 근거 — 실제 자료 아님",
            url: `https://example.com/mock/${actor.toLowerCase()}`,
            excerpt: "흐름 검증을 위한 합성 예시입니다.",
          },
        ],
        confidence: 0.6,
      },
    ];
    if (round >= 2)
      answer.claims.push({
        statement: `${topic}: 실증 평가 전에는 효과를 단정할 수 없다.`,
        sources: [],
        confidence: 0.4,
      });
    answer.unresolved = [gap];
    answer.resolved = questions.filter((q) => q !== gap);
  }
  if (stage === "critique") {
    const peer =
      actor === "GPT"
        ? `${topic}: 대안 비교와 실패 조건을 함께 평가해야 한다.`
        : `${topic}: 적용 범위와 성공 지표를 먼저 정의해야 한다.`;
    answer.critiques = [
      {
        claim: peer,
        objection:
          "방향 제시는 타당하지만 실제 효과를 뒷받침할 실증 근거가 부족하다.",
      },
    ];
    answer.unresolved = [gap];
  }
  if (stage === "conversation") {
    answer.summary = `${actor} 답변 · ${questions[0] ?? "후속 질문"}\n\n저장된 연구 맥락을 바탕으로 검토했습니다.`;
  }
  if (stage === "conversation-synthesis") {
    answer.summary = `## 공동 정리\n\nGPT와 Claude의 답변을 비교해 공통점과 차이를 정리했습니다.\n\n${questions[0] ?? "후속 질문"}`;
  }
  answer.summary =
    stage === "synthesis"
      ? `# ${topic}\n\n> MOCK 시뮬레이션 보고서 — 실제 연구 결과가 아닙니다.\n\n## 연구 개요\n두 모델이 독립 조사, 상호비판, 반박 및 추가 조사를 수행했습니다.\n\n## 확인된 사실\n이 모드에서 검증된 외부 사실은 없습니다.\n\n## 잠정 결론\n적용 범위, 성공 지표, 비교 대상과 실패 조건을 명시한 실증 연구가 필요합니다.\n\n## 논쟁 및 미해결 질문\n${gap}\n\n## 연구·정책 공백\n정량적인 검증 자료와 책임 범위의 명확화가 필요합니다.\n\n## 제안과 반론\n작은 규모의 시범 평가를 제안합니다. 실제 환경의 대표성이 부족할 수 있다는 반론이 남습니다.\n\n## 다음 단계\n실제 API와 웹 검색을 연결하여 원문 근거를 수집하고 사람이 검토하세요.`
      : answer.summary || `${actor} · ${stage} · 라운드 ${round}: ${stage === "rebuttal" ? "비판을 수용하고 효과 단정을 유보합니다." : "자동 연구 흐름의 합성 예시입니다."}`;
  return {
    answer,
    observedUrls: [],
    tokens: 0,
    model: "mock-" + actor.toLowerCase(),
    sessionId:
      request.sessionId ??
      `mock-${actor.toLowerCase()}-${request.projectId ?? "project"}`,
  };
}
