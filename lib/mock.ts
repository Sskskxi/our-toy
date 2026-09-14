import type { Request, Result, Answer } from "./types";
import { CliFailure } from "./cli-errors";
// MOCK_FAIL=stage[:actor[:kind[:times]]] makes mock runs fail like the real
// CLIs, to try retries and resume without spending usage. kind: limit | auth |
// transient | timeout (default limit). times: failures before succeeding
// (default: always). Example: MOCK_FAIL=revise:GPT:transient:1
const mockFailures = new Map<string, number>();
function injectFailure(request: Request) {
  const spec = process.env.MOCK_FAIL;
  if (!spec) return;
  const [stage, actor, kind = "limit", times] = spec.split(":");
  if (stage !== request.stage || (actor && actor !== "*" && actor !== request.actor)) return;
  // Counted per stage and model across rounds, so `times` means total failures.
  const key = `${request.stage}|${request.actor}`;
  const count = mockFailures.get(key) ?? 0;
  if (times && count >= Number(times)) return;
  mockFailures.set(key, count + 1);
  const kinds = ["limit", "auth", "transient", "timeout"] as const;
  const k = (kinds as readonly string[]).includes(kind) ? (kind as (typeof kinds)[number]) : "limit";
  throw new CliFailure(request.actor === "GPT" ? "codex" : "claude", k, `MOCK_FAIL 모의 실패 (${k})`);
}

export async function mock(request: Request): Promise<Result> {
  injectFailure(request);
  const { actor, stage, round, questions } = request;
  // Topics may be Markdown; mock sentences use a plain one-line title.
  const topic =
    (request.topic.split("\n").find((l) => l.trim()) ?? request.topic)
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+)/, "")
      .replace(/(\*\*|__|`)/g, "")
      .trim();
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
  // Shared-draft stages: two drafts, a merge with one open issue, then edits
  // that taper off so the "no more changes" stop rule can fire.
  const peerName = actor === "GPT" ? "Claude" : "GPT";
  if (stage === "draft") {
    answer.claims = [{ statement, sources: [{ title: "시뮬레이션 근거 — 실제 자료 아님", url: `https://example.com/mock/${actor.toLowerCase()}`, excerpt: "흐름 검증을 위한 합성 예시입니다." }], confidence: 0.6 }];
    answer.unresolved = [gap];
    answer.summary = `### 핵심 요점\n- **${actor} 초안**: ${statement.replace(`${topic}: `, "")}\n\n${questions.map((q) => `## ${q}\n${actor}의 합성 초안 문단입니다.`).join("\n\n")}`;
  }
  if (stage === "merge") {
    answer.claims = [
      { statement: `${topic}: 적용 범위와 성공 지표를 먼저 정의해야 한다.`, sources: [], confidence: 0.6 },
      { statement: `${topic}: 대안 비교와 실패 조건을 함께 평가해야 한다.`, sources: [], confidence: 0.6 },
    ];
    answer.critiques = [{ claim: "두 초안의 구조", objection: "질문별 섹션으로 통일하고 양쪽 근거를 모두 남겼습니다." }];
    answer.unresolved = [`⚖️ ${topic}: 지표 정의와 실패 조건 중 무엇을 먼저 볼 것인가`];
    answer.summary = `### 핵심 요점\n- **공통 결론**: 실증 근거가 부족합니다.\n- **쟁점 1개**: 우선순위가 갈립니다.\n\n${questions.map((q) => `## ${q}\n두 초안을 합친 합성 문단입니다.`).join("\n\n")}\n\n> ⚖️ 쟁점: GPT는 성공 지표 정의가 먼저, Claude는 실패 조건 평가가 먼저라고 봅니다.`;
  }
  if (stage === "revise") {
    const doc = ((request.context as { stageContext?: { document?: string } } | null)?.stageContext?.document ?? "");
    const quiet = round >= 2;
    answer.critiques = quiet ? [] : [{ claim: "⚖️ 쟁점", objection: `${peerName}의 입장을 유지한 채 ${actor} 근거를 덧붙였습니다.` }];
    answer.unresolved = quiet ? [] : [`⚖️ ${topic}: 지표 정의와 실패 조건 중 무엇을 먼저 볼 것인가`];
    if (!quiet) answer.claims = [{ statement: `${topic}: ${actor}는 ${round}라운드에 실패 사례 비교를 추가했다.`, sources: [], confidence: 0.5 }];
    answer.summary = quiet ? doc : `${doc}\n\n### ${actor} 보강 (라운드 ${round})\n- **추가**: 실패 사례 비교 관점`;
  }
  if (stage === "explore") {
    const ctx = (request.context as { stageContext?: { previousTurn?: { claims?: { statement: string }[] } | null } } | null)?.stageContext;
    const prevClaims = ctx?.previousTurn?.claims ?? [];
    answer.claims = [
      {
        statement: `${topic}: ${actor}가 ${round}라운드에 ${round === 1 ? "기초 자료" : "빈틈 보완 자료"}를 찾았다.`,
        sources: [{ title: "시뮬레이션 근거 — 실제 자료 아님", url: `https://example.com/mock/${actor.toLowerCase()}/${round}`, excerpt: "흐름 검증을 위한 합성 예시입니다." }],
        confidence: 0.55,
      },
    ];
    // From the second round on, drop the peer's latest finding as off-topic.
    if (prevClaims[0] && round >= 2)
      answer.critiques = [{ claim: prevClaims[0].statement, objection: "연구 질문의 범위와 맞지 않아 제외했습니다." }];
    answer.questions = round >= 2 ? [] : [`${topic}: 비용 대비 효과 흐름`];
    answer.unresolved = round >= 2 ? [] : [gap];
    answer.summary = `### 핵심 요점\n- **${actor} ${round}라운드 탐색**: 새 자료 1건\n\n### 보완한 부분\n- 이전 차례의 빈틈을 채웠습니다.\n\n### 제외한 자료\n${answer.critiques.length ? "- 범위 밖 자료 1건" : "- 없음"}\n\n### 더 파고든 흐름\n- 비용 대비 효과\n\n### 다음 탐색 제안\n${answer.questions.map((q) => `- ${q}`).join("\n") || "- 더 파고들 흐름 없음"}`;
  }
  if (stage === "conversation") {
    answer.summary = `### 핵심 요점\n- **${actor} 답변**: 저장된 연구 맥락을 바탕으로 검토했습니다.\n- **근거 한계**: 합성 데이터라 실제 사실 확인은 없습니다.\n\n### 받은 질문\n> ${(questions[0] ?? "후속 질문").split("\n")[0]}`;
  }
  if (stage === "conversation-synthesis") {
    answer.summary = `### 핵심 요점\n- **공통점**: 두 모델 모두 실증 근거 부족을 지적했습니다.\n- **차이**: GPT는 지표 정의, Claude는 실패 조건을 강조했습니다.\n\n### 비교\n| 관점 | GPT | Claude |\n|---|---|---|\n| 우선순위 | 성공 지표 | 대안·실패 조건 |`;
  }
  const guidance = (request.context as { humanGuidance?: string[] } | null)
    ?.humanGuidance;
  const guidanceNote = guidance?.length
    ? `\n\n### 사람 개입 반영\n${guidance.map((g) => `- ${g.split("\n")[0]}`).join("\n")}`
    : "";
  const stageNote: Partial<Record<typeof stage, string>> = {
    plan: `### 핵심 요점\n- **질문 3개로 분해**: 개념·범위, 기존 근거, 실증 공백\n- **우선순위**: 실증 자료가 충분한지부터 확인`,
    research: `### 핵심 요점\n- **${actor} 관점**: ${statement.replace(`${topic}: `, "")}\n- **남은 공백**: 실증 지표와 자료 부족\n\n### 세부\n합성 예시 근거 1건을 연결했습니다.`,
    critique: `### 핵심 요점\n- **상대 주장은 방향이 타당함**\n- **하지만 실증 근거가 부족함**: 효과를 단정하기 어렵습니다.`,
    rebuttal: `### 핵심 요점\n- **비판 수용**: 효과 단정을 유보합니다.\n- **유지하는 주장**: ${statement.replace(`${topic}: `, "")}`,
  };
  answer.summary =
    stage === "synthesis"
      ? `# ${topic}\n\n> MOCK 시뮬레이션 보고서 — 실제 연구 결과가 아닙니다.\n\n### 핵심 요점\n- **검증된 외부 사실 없음**: 합성 데이터 실행입니다.\n- **잠정 결론**: 범위·지표·실패 조건을 명시한 실증 연구가 필요합니다.\n- **남은 논쟁**: 실제 효과를 뒷받침할 자료 부족${guidanceNote}\n\n## 연구 개요\n두 모델이 독립 조사, 상호비판, 반박 및 추가 조사를 수행했습니다.\n\n## 확인된 사실\n이 모드에서 검증된 외부 사실은 없습니다.\n\n## 잠정 결론\n적용 범위, 성공 지표, 비교 대상과 실패 조건을 명시한 실증 연구가 필요합니다.\n\n## 논쟁 및 미해결 질문\n${gap}\n\n## 연구·정책 공백\n정량적인 검증 자료와 책임 범위의 명확화가 필요합니다.\n\n## 제안과 반론\n작은 규모의 시범 평가를 제안합니다. 실제 환경의 대표성이 부족할 수 있다는 반론이 남습니다.\n\n## 다음 단계\n실제 API와 웹 검색을 연결하여 원문 근거를 수집하고 사람이 검토하세요.`
      : stage === "revise" && !answer.summary
        ? ""
        : (answer.summary || stageNote[stage] || `${actor} · ${stage} · 라운드 ${round}`) +
          guidanceNote;
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
