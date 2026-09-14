import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAccountUsageCacheForTests,
  getAccountUsage,
  parseClaudeUsage,
  parseCodexRateLimits,
} from "../lib/account-usage";

test("Codex rate limits become short and weekly remaining percentages", () => {
  const parsed = parseCodexRateLimits({
    rateLimits: {},
    rateLimitsByLimitId: {
      codex: {
        primary: {
          usedPercent: 18,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 41,
          windowDurationMins: 10_080,
          resetsAt: 1_800_500_000,
        },
      },
    },
  });

  assert.equal(parsed.status, "available");
  assert.equal(parsed.short?.remainingPercent, 82);
  assert.equal(parsed.short?.label, "5시간");
  assert.equal(parsed.weekly?.remainingPercent, 59);
  assert.equal(parsed.weekly?.label, "주간");
});

test("Claude /usage text becomes session and weekly remaining percentages", () => {
  const parsed = parseClaudeUsage(
    JSON.stringify({
      subtype: "success",
      result:
        "Current session\n22% used\nResets Sep 13 at 6:00 PM\nCurrent week (all models)\n47% used\nResets Sep 16 at 9:00 AM",
    }),
  );

  assert.equal(parsed.status, "available");
  assert.equal(parsed.short?.remainingPercent, 78);
  assert.equal(parsed.short?.label, "세션");
  assert.match(parsed.short?.resetLabel ?? "", /Sep 13/);
  assert.equal(parsed.weekly?.remainingPercent, 53);
  assert.match(parsed.weekly?.resetLabel ?? "", /Sep 16/);
});

test("account usage is cached for 60 seconds and provider errors are sanitized", async () => {
  clearAccountUsageCacheForTests();
  let codexCalls = 0;
  let claudeCalls = 0;
  let now = 1_000;
  const options = {
    now: () => now,
    readCodex: async () => {
      codexCalls += 1;
      return {
        status: "available" as const,
        short: { label: "5시간", remainingPercent: 90 },
        weekly: { label: "주간", remainingPercent: 70 },
      };
    },
    readClaude: async () => {
      claudeCalls += 1;
      throw new Error("oauth-secret-should-never-reach-the-browser");
    },
  };

  const first = await getAccountUsage(options);
  const second = await getAccountUsage(options);
  assert.equal(codexCalls, 1);
  assert.equal(claudeCalls, 1);
  assert.deepEqual(second, first);
  assert.equal(first.claude.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(first), /oauth-secret/);

  now += 60_001;
  await getAccountUsage(options);
  assert.equal(codexCalls, 2);
  assert.equal(claudeCalls, 2);
});

test("logged-in account ID and plan are shown without leaking other auth fields", async () => {
  const { parseCodexAccount, parseClaudeAuth } = await import("../lib/account-usage");
  assert.deepEqual(
    parseCodexAccount({
      account: { type: "chatgpt", email: "me@example.com", planType: "plus", accessToken: "secret" },
      requiresOpenaiAuth: true,
    }),
    { email: "me@example.com", plan: "plus", method: "ChatGPT" },
  );
  const claude = parseClaudeAuth(
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "me@example.com",
      orgId: "org-123",
      configDirectory: "/Users/me/.claude",
      subscriptionType: "max",
    }),
  );
  assert.deepEqual(claude, { email: "me@example.com", plan: "max", method: "claude.ai" });
  assert.doesNotMatch(JSON.stringify(claude), /org-123|\.claude/);
  assert.equal(parseClaudeAuth(JSON.stringify({ loggedIn: false, email: "x@y.z" })), undefined);
  assert.equal(parseClaudeAuth("not json"), undefined);
  // Values that are not plain IDs or plan names are dropped.
  assert.deepEqual(
    parseCodexAccount({ account: { email: "<img src=x>@a", planType: "plus<script>" } }),
    undefined,
  );
});
