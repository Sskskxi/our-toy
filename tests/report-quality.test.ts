import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { create, save } from "../lib/store";
import { run } from "../lib/engine";
import { mock } from "../lib/mock";
import type { Request } from "../lib/types";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "report-quality-tests-"));
process.env.MOCK_DELAY_MS = "0";

const input = {
  topic: "공공 에이전트 권한 관리 정책 검증",
  mode: "mock" as const,
  strategy: "debate" as const,
  maxRounds: 1,
  minRounds: 1,
  noveltyThreshold: 0.12,
};

test("real runs check cited pages, find contradictions and append numbered references", async () => {
  const p = create(input);
  p.mode = "subscription"; // real-run path, driven by the mock provider
  const fetched: string[] = [];
  const seen: Request[] = [];
  const fetcher = async (url: string) => {
    fetched.push(url);
    return url.endsWith("/gpt")
      ? { status: "ok" as const, text: "적용 범위와 성공 지표를 먼저 정의해야 한다", contentType: "text/html", finalUrl: url }
      : { status: "unreachable" as const, note: "HTTP 404" };
  };
  await run(p, async (r) => { seen.push(r); return mock(r); }, () => save(p), { fetcher });
  assert.equal(p.status, "complete");
  assert.ok(fetched.length >= 1, "cited pages were fetched through the injected fetcher");
  const sources = p.claims.flatMap((c) => c.sources);
  assert.ok(sources.every((s) => s.check && s.grade), "every source has a check and a grade");
  assert.ok(sources.some((s) => s.check?.status === "unreachable"));
  assert.ok(p.claims.every((c) => c.grade === 3));
  assert.equal(p.contradictions?.length, 1);
  assert.equal(p.contradictions?.[0].actor, "GPT");
  const order = seen.map((r) => r.stage);
  assert.ok(order.indexOf("contradictions") < order.indexOf("synthesis"));
  const synthesis = seen.find((r) => r.stage === "synthesis")!;
  assert.match(JSON.stringify(synthesis), /contradictions/);
  assert.match(JSON.stringify(synthesis), /reportTemplate/);
  assert.match(p.report!, /## 참고문헌\n1\. .+ — <https:\/\/example\.com\/mock\/.+> \(기타 자료 · .+\)/);
});

test("mock runs skip page fetching but still grade sources; VERIFY_SOURCES=off skips checks", async () => {
  let fetched = 0;
  const fetcher = async () => { fetched++; return { status: "unreachable" as const, note: "x" }; };
  const p = create(input);
  await run(p, mock, () => save(p), { fetcher });
  assert.equal(fetched, 0);
  assert.ok(p.claims.flatMap((c) => c.sources).every((s) => s.grade && !s.check));
  process.env.VERIFY_SOURCES = "off";
  try {
    const q = create(input);
    q.mode = "subscription";
    await run(q, mock, () => save(q), { fetcher });
    assert.equal(fetched, 0);
  } finally {
    delete process.env.VERIFY_SOURCES;
  }
});

test("contest template is passed to the report and a single claim skips the contradiction call", async () => {
  const seen: Request[] = [];
  const p = create({ ...input, reportTemplate: "contest" as const });
  await run(p, async (r) => {
    seen.push(r);
    const result = await mock(r);
    if (r.stage === "research" || r.stage === "rebuttal") result.answer.claims = result.answer.claims.slice(0, 1).map((c) => ({ ...c, statement: "공통 주장: 권한 범위를 먼저 정의해야 한다." }));
    return result;
  }, () => save(p));
  assert.equal(p.status, "complete");
  assert.equal(p.claims.length, 1);
  assert.ok(!seen.some((r) => r.stage === "contradictions"));
  assert.match(JSON.stringify(seen.find((r) => r.stage === "synthesis")), /"reportTemplate":"contest"/);
});

test("reports export to a Word file with headings, bullets and references", async () => {
  const { markdownParagraphs, markdownToDocx } = await import("../lib/docx-export");
  const md = "# 제목\n\n### 핵심 요점\n- **굵게** 요점 `코드`\n  - 하위\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n## 참고문헌\n1. 법령 — <https://law.go.kr/x> (1차 자료 · 원문 일치)";
  assert.equal(markdownParagraphs(md).length, 8, "table separator and rule are dropped");
  const buffer = await markdownToDocx(md, "제목");
  assert.equal(buffer.subarray(0, 2).toString(), "PK", "a .docx is a zip file");
  assert.ok(buffer.length > 2000);
});

test("answer-first report rules flag a buried conclusion and pass a decision report", async () => {
  const { reportProblems } = await import("../lib/engine");
  const { REPORT_RULES, DECISION_RULES } = await import("../lib/provider");
  assert.match(REPORT_RULES, /\*\*결론\*\*/);
  assert.match(REPORT_RULES, /## 바로 할 일/);
  assert.match(DECISION_RULES, /decision/);
  const buried = "### 핵심 요점\n- **조건 확인됨**: 팀 2~7인, 마감 10월 11일 (C-1527c0f2, C-27d61677, C-d6c81584)\n- **추천 주제는 A**: 표준 필드 조합 (C-a2d49298)\n\n### 1. 근거로 뒷받침되는 사실\n확인이 필요합니다. 미확인. 불확실합니다. 단정할 수 없습니다. 검토가 필요합니다.";
  const found = reportProblems(buried);
  assert.ok(found.some((m) => m.includes("**결론**")));
  assert.ok(found.some((m) => m.includes("## 결론")));
  assert.ok(found.some((m) => m.includes("바로 할 일")));
  assert.ok(found.some((m) => m.includes("주장 ID")));
  assert.ok(found.some((m) => m.includes("유보 표현")));
  const p = create(input);
  await run(p, mock, () => save(p));
  assert.deepEqual(reportProblems(p.report!), [], "the mock report follows the rules, so no edit call runs");
  assert.ok(!p.calls.some((c) => c.stage === "report-edit"));
});

test("a report that buries the answer is edited by the other model and kept only if it is better", async () => {
  const bad = "### 핵심 요점\n- **사실 정리**: 여러 조건이 있어요.\n\n## 사실\n내용";
  const seen: Request[] = [];
  const provider = (editReply: (r: Request) => string) => async (r: Request) => {
    seen.push(r);
    const result = await mock(r);
    if (r.stage === "synthesis") result.answer.summary = bad;
    if (r.stage === "report-edit") result.answer.summary = editReply(r);
    return result;
  };
  const good = await mock({ ...seen[0], actor: "GPT", stage: "synthesis", round: 1, questions: [], topic: "공모전 주제" } as Request);
  const p = create(input);
  await run(p, provider(() => good.answer.summary), () => save(p));
  const edit = seen.find((r) => r.stage === "report-edit")!;
  assert.ok(edit, "edit call ran");
  const synth = seen.find((r) => r.stage === "synthesis")!;
  assert.notEqual(edit.actor, synth.actor, "the other model edits");
  assert.match(JSON.stringify(edit), /problems/);
  assert.match(p.report!, /\*\*결론\*\*: /);
  assert.match(p.report!, /## 참고문헌|## 실행 기록/);

  seen.length = 0;
  const q = create(input);
  await run(q, provider(() => "짧은 글"), () => save(q));
  assert.ok(q.report!.startsWith(bad), "a worse edit is discarded");

  seen.length = 0;
  const failing = create(input);
  await run(failing, async (r) => { if (r.stage === "report-edit") throw new Error("boom"); return provider(() => "")(r); }, () => save(failing));
  assert.equal(failing.status, "complete", "a failed edit keeps the draft report");

  process.env.REPORT_EDIT = "off";
  try {
    seen.length = 0;
    const off = create(input);
    await run(off, provider(() => good.answer.summary), () => save(off));
    assert.ok(!seen.some((r) => r.stage === "report-edit"));
  } finally {
    delete process.env.REPORT_EDIT;
  }
});

test("rewriting a finished report replays research and calls only the report stages", async () => {
  const p = create(input);
  await run(p, mock, () => save(p));
  const researchCalls = p.calls.filter((c) => c.stage !== "synthesis").length;
  // Same steps as POST /api/projects/[id]/rewrite.
  p.reportHistory = [{ createdAt: p.updatedAt, markdown: p.report! }];
  p.calls = p.calls.filter((c) => c.stage !== "synthesis" && c.stage !== "report-edit");
  p.report = undefined;
  p.status = "queued";
  const live: Request[] = [];
  await run(p, async (r) => { live.push(r); return mock(r); }, () => save(p));
  assert.equal(p.status, "complete");
  assert.deepEqual(live.map((r) => r.stage), ["synthesis"]);
  assert.equal(p.calls.filter((c) => c.replayed).length, researchCalls);
  assert.equal(p.reportHistory.length, 1);
  assert.ok(p.report);
});

test("references list only the sources the report uses, in order of use", async () => {
  const { referencesAppendix, reportProblems } = await import("../lib/engine");
  const src = (url: string) => ({ url, title: url, excerpt: "", provenance: "provider-cited" as const, grade: 1 as const });
  const p = create(input);
  p.claims = [
    { id: "C-aaaaaaaa", statement: "a", confidence: 0.5, actors: ["GPT"], sources: [src("https://a.go.kr/")], status: "source-linked", objections: [], rounds: [1] },
    { id: "C-bbbbbbbb", statement: "b", confidence: 0.5, actors: ["GPT"], sources: [src("https://b.go.kr/")], status: "source-linked", objections: [], rounds: [1] },
    { id: "C-cccccccc", statement: "c", confidence: 0.5, actors: ["GPT"], sources: [src("https://unused.go.kr/")], status: "source-linked", objections: [], rounds: [1] },
  ];
  const refs = referencesAppendix(p, "## 근거\n- B 사실 (https://b.go.kr/)\n- A 사실 (C-aaaaaaaa)");
  assert.match(refs, /1\. https:\/\/b\.go\.kr\/[\s\S]*2\. https:\/\/a\.go\.kr\//);
  assert.doesNotMatch(refs, /unused/);
  assert.match(refs, /쓰지 않은 출처 1개/);
  assert.match(referencesAppendix(p, "인용 없음"), /unused/, "a report without citations lists everything");
  const long = "### 핵심 요점\n- **결론**: " + "가".repeat(200) + "\n- a\n- b\n- c\n- d\n- e\n\n## 결론: x\n## 바로 할 일\n1. y";
  const found = reportProblems(long);
  assert.ok(found.some((m) => m.includes("6개")));
  assert.ok(found.some((m) => m.includes("170자")));
});

test("grades follow the rules on every run and jargon in the one-line answer is flagged", async () => {
  const { gradeSource } = await import("../lib/verify");
  const { reportProblems } = await import("../lib/engine");
  assert.equal(gradeSource("https://cse.cau.ac.kr/sub05/board.php", "공모전 안내"), 2, "a university board is not a primary source");
  assert.equal(gradeSource("https://www.law.go.kr/x"), 1);
  const plain = "### 핵심 요점\n- **결론**: KISIA 공모전에 공공기관 AI 부품 목록 기준을 제안하세요.\n\n## 결론: x\n## 바로 할 일\n1. y";
  assert.deepEqual(reportProblems(plain), []);
  const jargon = plain.replace("공공기관 AI 부품 목록 기준", "CycloneDX 기반 AI-BOM 최소 프로파일");
  assert.ok(reportProblems(jargon).some((m) => m.includes("영문 전문용어")));
});

for (const strategy of ["codraft", "relay", "debate"] as const)
  test(`${strategy}: a follow-up question reopens the research for new rounds and a new report`, async () => {
    const { startFollowUp } = await import("../lib/followup");
    const p = create({ ...input, strategy, maxRounds: 2, minRounds: 1 });
    await run(p, mock, () => save(p));
    assert.equal(p.status, "complete");
    const doneRounds = p.rounds.length;
    const reportStages = ["contradictions", "synthesis", "report-edit"];
    const doneResearch = p.calls.filter((c) => !reportStages.includes(c.stage)).length;
    const firstReport = p.report!;
    const question = "2025년 수상작과 겹치지 않으려면 무엇을 바꿔야 하나요?";
    assert.equal(startFollowUp(p, { question, rounds: 2 }), null);
    assert.equal(p.status, "queued");
    const live: Request[] = [];
    await run(p, async (r) => { live.push(r); return mock(r); }, () => save(p));
    assert.equal(p.status, "complete");
    assert.ok(p.rounds.length > doneRounds, "new rounds ran");
    assert.ok(p.rounds.length <= doneRounds + 2);
    assert.equal(p.calls.filter((c) => c.replayed).length, doneResearch, "research calls replay");
    assert.ok(!live.some((r) => r.round <= doneRounds && ["draft", "merge", "revise", "explore", "research", "critique", "rebuttal", "plan"].includes(r.stage)), "no saved research step runs again");
    const roundCalls = live.filter((r) => r.round > doneRounds && !["contradictions", "synthesis", "report-edit"].includes(r.stage));
    assert.ok(roundCalls.length >= 2, "both models worked in the new rounds");
    assert.ok(roundCalls.every((r) => (r.context as { followUp?: { question: string } }).followUp?.question === question));
    const synthesis = live.find((r) => r.stage === "synthesis")!;
    assert.match(JSON.stringify(synthesis.context), /followUpPolicy/);
    assert.ok(p.questions.includes(question));
    assert.equal(p.reportHistory?.at(-1)?.markdown, firstReport);
    assert.ok(p.report && p.report !== undefined);
    assert.equal(p.followUps?.length, 1);
  });

test("follow-up input is validated and a second follow-up builds on the first", async () => {
  const { startFollowUp } = await import("../lib/followup");
  const p = create({ ...input, strategy: "codraft", maxRounds: 1, minRounds: 1 });
  assert.match(startFollowUp(p, { question: "질문" })!, /보고서가 나온/);
  await run(p, mock, () => save(p));
  assert.match(startFollowUp(p, { question: "  " })!, /입력/);
  assert.match(startFollowUp(p, { question: "질문", rounds: 7 })!, /1~6/);
  assert.match(startFollowUp(p, { question: "질문", rounds: 1.5 })!, /1~6/);
  assert.match(startFollowUp(p, { question: "x".repeat(4001) })!, /4,000자/);
  assert.equal(p.status, "complete", "rejected input changes nothing");
  assert.equal(startFollowUp(p, { question: "첫 후속", rounds: 1 }), null);
  await run(p, mock, () => save(p));
  const afterFirst = p.rounds.length;
  assert.equal(startFollowUp(p, { question: "두 번째 후속", rounds: 1 }), null);
  const live: Request[] = [];
  await run(p, async (r) => { live.push(r); return mock(r); }, () => save(p));
  const revise = live.find((r) => r.stage === "revise")!;
  assert.equal(revise.round, afterFirst + 1);
  const ctx = revise.context as { followUp: { question: string; earlier: string[] } };
  assert.equal(ctx.followUp.question, "두 번째 후속");
  assert.deepEqual(ctx.followUp.earlier, ["첫 후속"]);
  assert.equal(p.reportHistory?.length, 2);
});
