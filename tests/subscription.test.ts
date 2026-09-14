import test from "node:test";
import assert from "node:assert/strict";
import { subscriptionEnv, decodeClaude, wireSchema, buildCodexArgs, buildClaudeArgs } from "../lib/subscription";
import { provider } from "../lib/provider";
import { mock } from "../lib/mock";
test("subscription child environment excludes keys and alternate auth/provider settings", () => {
  const e = subscriptionEnv({
    NODE_ENV: "test",
    HOME: "/home/test",
    PATH: "/bin",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_AUTH_TOKEN: "secret",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    OPENAI_BASE_URL: "https://other.invalid",
    CODEX_HOME: "/other",
    CLAUDE_CONFIG_DIR: "/other",
  });
  for (const k of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_BASE_URL",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ])
    assert.equal(e[k], undefined);
});
test("legacy API mode cannot invoke paid fallback", async () => {
  await assert.rejects(
    provider({
      actor: "GPT",
      stage: "plan",
      round: 0,
      topic: "test",
      questions: [],
      context: null,
      mode: "live",
    }),
    /비활성화/,
  );
});
test("Claude structured response validated and sources remain unverified", async () => {
  const r = await mock({
    actor: "Claude",
    stage: "research",
    round: 1,
    topic: "test",
    questions: [],
    context: null,
    mode: "mock",
  });
  const result = decodeClaude(
    JSON.stringify({
      subtype: "success",
      structured_output: r.answer,
      usage: { input_tokens: 1, output_tokens: 2 },
      session_id: "123e4567-e89b-42d3-a456-426614174000",
    }),
    "claude-opus-5",
  );
  assert.equal(result.tokens, 3);
  const cached = decodeClaude(
    JSON.stringify({ subtype: "success", structured_output: r.answer, usage: { input_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 9 } }),
    "claude-opus-5",
  );
  assert.equal(cached.tokens, 1000, "cached prompt tokens are counted");
  assert.equal(result.sessionId, "123e4567-e89b-42d3-a456-426614174000");
  assert.deepEqual(result.observedUrls, []);
  assert.throws(() =>
    decodeClaude(
      JSON.stringify({ subtype: "error_max_turns", is_error: true }),
      "claude-opus-5",
    ),
  );
});

test("subscription CLI calls keep no session unless resuming a legacy one", () => {
  const initial = buildCodexArgs({
    model: "gpt-5.6-sol",
    effort: "high",
    search: false,
    schemaPath: "/tmp/schema.json",
    output: "/tmp/output.json",
  });
  assert.equal(initial.includes("--ephemeral"), true);
  assert.ok(initial.includes("gpt-5.6-sol"));
  assert.ok(initial.includes('model_reasoning_effort="high"'));
  const resumed = buildCodexArgs({
    model: "gpt-5.6-sol",
    effort: "high",
    search: false,
    schemaPath: "/tmp/schema.json",
    output: "/tmp/output.json",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
  });
  assert.deepEqual(resumed.slice(0, 2), ["exec", "resume"]);
  assert.ok(resumed.includes("123e4567-e89b-42d3-a456-426614174000"));

  const claude = buildClaudeArgs({
    model: "claude-opus-5",
    effort: "low",
    search: false,
    schema: "{}",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    resume: true,
  });
  assert.ok(claude.includes("--resume"));
  assert.equal(claude.includes("--no-session-persistence"), false);
  const fresh = buildClaudeArgs({ model: "claude-opus-5", effort: "high", search: false, schema: "{}" });
  assert.ok(fresh.includes("--no-session-persistence"));
  assert.equal(fresh.includes("--resume") || fresh.includes("--session-id"), false);
});

test("wire schema works across CLI dialects while local validation remains strict", () => {
  const raw = wireSchema();
  assert.ok(!raw.includes("$schema"));
  assert.ok(!raw.includes('"format"'));
  assert.equal(JSON.parse(raw).additionalProperties, false);
});
