import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "specificity-tests-"));
process.env.MOCK_DELAY_MS = "0";
const { create } = await import("../lib/store");
const { run, editsOf } = await import("../lib/engine");
const { mock } = await import("../lib/mock");
const { SPECIFICITY_RULES, MARKDOWN_STYLE } = await import("../lib/provider");
import type { Result } from "../lib/types";

test("prompts require concrete anchors instead of status-only key points", () => {
  assert.match(SPECIFICITY_RULES, /checkable anchor/);
  assert.match(SPECIFICITY_RULES, /기반은 견고함/);
  assert.match(SPECIFICITY_RULES, /conditional analysis/);
  assert.doesNotMatch(MARKDOWN_STYLE, /short bullets/);
});

test("replies to the other model are dialogue, not edits", () => {
  const result = {
    answer: {
      questions: [],
      claims: [],
      resolved: [],
      unresolved: [],
      summary: "",
      critiques: [
        { claim: "응답: N2SF는 등급만 있고 구획이 없다", objection: "부분 수용: 부록1 권한 영역 확인" },
        { claim: "  응답:  ⚖️ 쟁점", objection: "반박" },
      ],
    },
    observedUrls: [],
    tokens: 0,
    model: "mock",
  } satisfies Result;
  assert.equal(editsOf(result).length, 0);
  result.answer.critiques.push({ claim: "원문 문장", objection: "A → B" });
  assert.equal(editsOf(result).length, 1);
});

test("co-draft still settles when a round only has replies", async () => {
  const p = create({ topic: "구체성 점검 주제입니다", mode: "mock", strategy: "codraft", maxRounds: 4, minRounds: 1 });
  await run(p, async (r) => {
    const res = await mock(r);
    if (r.stage !== "revise") return res;
    const doc = (r.context as { stageContext: { document: string } }).stageContext.document;
    return {
      ...res,
      answer: {
        ...res.answer,
        summary: doc,
        claims: [],
        critiques: [{ claim: "응답: 이전 변경", objection: "수용" }],
      },
    };
  });
  assert.equal(p.status, "complete");
  assert.equal(p.rounds.length, 1);
  assert.match(p.stopReason!, /더 고칠 부분이 없다/);
});
