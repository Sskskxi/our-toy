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
