import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { create, get, save } from "../lib/store";
import { run, merge } from "../lib/engine";
import { mock } from "../lib/mock";
import { live, parseAnswer, observedUrls } from "../lib/provider";
import type { Provider, Request, Result } from "../lib/types";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "research-tests-"),
);
process.env.MOCK_DELAY_MS = "0";
const input = {
  topic: "공공 에이전트 권한 관리 정책 검증",
  mode: "mock" as const,
  strategy: "debate" as const,
  maxRounds: 6,
  minRounds: 1,
  noveltyThreshold: 0.12,
};
const req: Request = {
  actor: "GPT",
  stage: "research",
  round: 1,
  topic: input.topic,
  questions: [],
  context: null,
  mode: "subscription",
};
test("full flow: independent parallel research, critique routing, evidence queue, novelty termination, persisted report", async () => {
  const p = create(input);
  const seen: Request[] = [];
  let active = 0,
    maxActive = 0;
  const spy: Provider = async (r) => {
    seen.push(structuredClone(r));
    active++;
    maxActive = Math.max(active, maxActive);
    try {
      return await mock(r);
    } finally {
      active--;
    }
  };
  await run(p, spy);
  assert.equal(p.status, "complete");
  assert.equal(p.rounds.length, 4);
  assert.match(p.stopReason!, /새 정보/);
  assert.ok(maxActive >= 2);
  const independent = seen.filter(
    (r) => r.stage === "research" && r.round === 1,
  );
  assert.equal(independent.length, 2);
  assert.ok(independent.every((r) => (r.context as {stageContext: unknown}).stageContext === null));
  const critique = seen.find(
    (r) => r.actor === "GPT" && r.stage === "critique",
  )!;
  assert.match(JSON.stringify(critique.context), /대안 비교/);
  const rebuttal = seen.find(
    (r) => r.actor === "GPT" && r.stage === "rebuttal",
  )!;
  assert.match(JSON.stringify(rebuttal.context), /실증 근거/);
  assert.ok(p.rounds[1].questions.includes(p.rounds[0].requeued[0]));
  assert.ok(p.unresolved.some((q) => q.startsWith("근거 검토:")));
  assert.ok(p.claims.some((c) => c.status === "contested"));
  assert.ok(
    p.claims.every((c) => c.sources.every((s) => s.provenance === "mock")),
  );
  assert.match(get(p.id)!.report!, /MOCK/);
  assert.equal(p.calls.length, 26);
  assert.ok(p.calls.every((c) => c.status === "complete"));
});
test("max rounds always bounds execution", async () => {
  const p = create({ ...input, maxRounds: 1 });
  await run(p, mock);
  assert.equal(p.rounds.length, 1);
  assert.equal(p.stopReason, "최대 라운드 도달");
  assert.equal(p.calls.length, 8);
  assert.ok(p.unresolved.length);
});
test("one provider fails: wait for peer, persist failure, never synthesize", async () => {
  const p = create(input);
  await run(p, async (r) => {
    if (r.actor === "Claude" && r.stage === "research")
      throw Error("provider offline");
    return mock(r);
  });
  assert.equal(p.status, "failed");
  assert.equal(p.error, "provider offline");
  assert.ok(!p.report);
  assert.ok(!p.calls.some((c) => c.status === "running"));
  assert.equal(get(p.id)!.status, "failed");
});
test("claim dedup and provenance: model-written URL does not become provider evidence", async () => {
  const p = create({ ...input, mode: "subscription" });
  const result = await mock(req);
  merge(p, [{ actor: "GPT", result }], 1);
  assert.equal(p.claims[0].sources[0].provenance, "unverified");
  merge(
    p,
    [
      {
        actor: "Claude",
        result: {
          ...result,
          observedUrls: [result.answer.claims[0].sources[0].url],
        },
      },
    ],
    2,
  );
  assert.equal(p.claims.length, 1);
  assert.equal(p.claims[0].sources[0].provenance, "provider-cited");
  assert.equal(p.claims[0].actors.length, 2);
});
test("both models may close an evidenced question; convergence preserves correct reason", async () => {
  const p = create({ ...input, mode: "subscription" });
  const proved: Provider = async (r) => {
    const result = await mock(r);
    result.answer.unresolved = [];
    result.answer.critiques = [];
    result.answer.claims = result.answer.claims.filter(
      (c) => c.sources.length > 0,
    );
    result.answer.resolved = r.questions;
    result.observedUrls = result.answer.claims.flatMap((c) =>
      c.sources.map((s) => s.url),
    );
    return result;
  };
  await run(p, proved);
  assert.equal(p.status, "complete");
  assert.equal(p.unresolved.length, 0);
  assert.match(p.stopReason!, /미해결 질문 없음/);
});
test("strict output validation and URL scheme protection", () => {
  assert.throws(() => parseAnswer('{"summary":"hello"}'));
  assert.throws(() => parseAnswer("not json"));
  assert.deepEqual(
    observedUrls({
      text: '{"url":"https://invented.test"}',
      annotations: [{ url: "https://real.test" }],
    }),
    ["https://real.test"],
  );
});
test("OpenAI adapter uses Responses with search and reads citation metadata", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  const fixture = await mock(req);
  let body: Record<string, unknown> = {};
  const fake: typeof fetch = async (_url, init) => {
    body = JSON.parse(init!.body as string);
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(fixture.answer),
              annotations: [
                { type: "url_citation", url: "https://source.test" },
              ],
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  };
  const result = await live(req, fake);
  assert.equal(result.tokens, 30);
  assert.deepEqual(result.observedUrls, ["https://source.test"]);
  assert.ok(body.tools);
  assert.equal(body.store, false);
  assert.equal(body.model,"gpt-5.6-sol");
  assert.deepEqual(body.reasoning,{effort:"high"});
});
test("Anthropic adapter request and citation metadata", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const fixture = await mock(req);
  const fake: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    const body = JSON.parse(init!.body as string);
    assert.equal(body.tools[0].name, "web_search");
    assert.equal(body.model,"claude-opus-5");
    assert.equal(body.output_config.effort,"high");
    assert.equal(body.thinking.type,"adaptive");
    return Response.json({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify(fixture.answer),
          citations: [{ url: "https://claude-source.test" }],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 5 },
    });
  };
  const r = await live({ ...req, actor: "Claude" }, fake);
  assert.equal(r.tokens, 9);
  assert.equal(r.observedUrls[0], "https://claude-source.test");
});
test("API errors and incomplete JSON fail closed", async () => {
  await assert.rejects(
    live(
      req,
      async () => new Response("secret provider detail", { status: 401 }),
    ),
    /HTTP 401/,
  );
  await assert.rejects(
    live(req, async () => Response.json({ status: "incomplete" })),
    /완결/,
  );
  await assert.rejects(
    live(req, async () => Response.json({ status: "completed", output: [] })),
    /JSON/,
  );
});
test("storage validation blocks invalid IDs and invalid project inputs", () => {
  assert.throws(() => get("../../etc/passwd"));
  assert.throws(() => create({ ...input, maxRounds: 100 }));
  const p = create(input);
  p.stage = "checkpoint";
  save(p);
  assert.equal(get(p.id)!.stage, "checkpoint");
});
test("minimum rounds prevents premature convergence and allows 30 rounds", async () => {
  const p = create({ ...input, minRounds: 8, maxRounds: 12 });
  await run(p, mock);
  assert.equal(p.status, "complete");
  assert.equal(p.rounds.length, 8);
  const full = create({ ...input, minRounds: 30, maxRounds: 30 });
  await run(full, mock, () => {});
  assert.equal(full.rounds.length, 30);
  assert.equal(full.status, "complete");
  assert.throws(() => create({ ...input, minRounds: 7, maxRounds: 6 }));
});
test.after(() => {
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});


test("reference files persist and seed each model session once", async () => {
  const references = { referenceText: "연구 배경 메모", attachments: [{ name: "policy.md", text: "검토 대상 정책 내용" }] };
  const p = create({ ...input, ...references, maxRounds: 1, minRounds: 1 });
  const seen: Request[] = [];
  await run(p, async r => { seen.push(r); return mock(r); }, () => save(p));
  assert.equal(p.status, "complete");
  assert.equal(seen.length, 8);
  const withReferences = seen.filter((r) =>
    Boolean((r.context as { userReferences?: unknown }).userReferences),
  );
  assert.deepEqual(withReferences.map((r) => [r.actor, r.stage]), [
    ["GPT", "plan"],
    ["Claude", "research"],
  ]);
  for (const r of withReferences)
    assert.deepEqual((r.context as { userReferences: unknown }).userReferences, {
      text: references.referenceText,
      files: references.attachments,
    });
  assert.deepEqual(get(p.id)!.attachments, references.attachments);
  // PDFs arrive as text extracted in the browser; other binaries stay rejected.
  assert.ok(create({...input, attachments: [{name: "file.pdf", text: "[1쪽]\n추출된 텍스트"}]}));
  assert.throws(() => create({...input, attachments: [{name: "file.exe", text: "unsupported"}]}));
  assert.throws(() => create({...input, attachments: [{name: "file.txt", text: "a".repeat(40001)}]}));
  assert.throws(() => create({...input, referenceText: "a".repeat(20000), attachments: [{name: "a.txt", text: "a".repeat(40000)}, {name: "b.txt", text: "b"}]}));
});
