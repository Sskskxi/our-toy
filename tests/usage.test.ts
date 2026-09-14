import test from "node:test";
import assert from "node:assert/strict";
import { projectUsage } from "../lib/usage";
import type { Project } from "../lib/types";

test("project subscription usage is split by model and call state", () => {
  const calls: Project["calls"] = [
    {
      actor: "GPT",
      stage: "plan",
      round: 0,
      status: "complete",
      startedAt: "2026-01-01T00:00:00Z",
      result: {
        model: "gpt-test",
        tokens: 120,
        observedUrls: [],
        answer: {
          questions: [],
          claims: [],
          critiques: [],
          unresolved: [],
          resolved: [],
          summary: "",
        },
      },
    },
    {
      actor: "GPT",
      stage: "research",
      round: 1,
      status: "running",
      startedAt: "2026-01-01T00:00:01Z",
    },
    {
      actor: "Claude",
      stage: "research",
      round: 1,
      status: "failed",
      startedAt: "2026-01-01T00:00:01Z",
    },
  ];
  const usage = projectUsage({ calls } as Project);
  assert.deepEqual(usage.GPT, {
    actor: "GPT",
    completedCalls: 1,
    runningCalls: 1,
    failedCalls: 0,
    tokens: 120,
    models: ["gpt-test"],
  });
  assert.equal(usage.Claude.failedCalls, 1);
  assert.equal(usage.Claude.tokens, 0);
});
