import { spawn } from "node:child_process";
import os from "node:os";
import { execute, subscriptionEnv } from "./subscription";

export type AccountUsageWindow = {
  label: string;
  remainingPercent: number;
  resetsAt?: number | null;
  resetLabel?: string;
};

export type AccountIdentity = {
  /** Login ID shown in the UI (the account email). */
  email?: string;
  plan?: string;
  method?: string;
};

export type ProviderAccountUsage = {
  status: "available" | "unavailable";
  short?: AccountUsageWindow;
  weekly?: AccountUsageWindow;
  account?: AccountIdentity;
};

export type AccountUsage = {
  codex: ProviderAccountUsage;
  claude: ProviderAccountUsage;
  fetchedAt: string;
};

type ReadOptions = {
  now?: () => number;
  readCodex?: () => Promise<ProviderAccountUsage>;
  readClaude?: () => Promise<ProviderAccountUsage>;
};

type JsonObject = Record<string, unknown>;

const CACHE_MS = 60_000;
let cached: { expiresAt: number; value: AccountUsage } | undefined;
let pending: Promise<AccountUsage> | undefined;

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function remaining(value: unknown, alreadyRemaining = false) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(
    100,
    Math.max(0, Math.round(alreadyRemaining ? number : 100 - number)),
  );
}

// Only these display fields leave the server; tokens, org IDs and config paths
// from the CLIs are dropped here.
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/;
const WORD = /^[A-Za-z0-9 ._+-]{1,40}$/;

export function identity(fields: {
  email?: unknown;
  plan?: unknown;
  method?: unknown;
}): AccountIdentity | undefined {
  const pick = (v: unknown, re: RegExp) =>
    typeof v === "string" && re.test(v.trim()) ? v.trim() : undefined;
  const result = {
    email: pick(fields.email, EMAIL),
    plan: pick(fields.plan, WORD),
    method: pick(fields.method, WORD),
  };
  return result.email || result.plan ? result : undefined;
}

export function parseCodexAccount(payload: unknown) {
  const account = record(record(payload)?.account);
  return identity({
    email: account?.email,
    plan: account?.planType,
    method: account?.type === "chatgpt" ? "ChatGPT" : account?.type,
  });
}

export function parseClaudeAuth(raw: string) {
  let status: JsonObject | undefined;
  try {
    status = record(JSON.parse(raw));
  } catch {
    return undefined;
  }
  if (!status?.loggedIn) return undefined;
  return identity({
    email: status.email,
    plan: status.subscriptionType,
    method: status.authMethod,
  });
}

function codexWindow(
  value: unknown,
  label: string,
): AccountUsageWindow | undefined {
  const window = record(value);
  const remainingPercent = remaining(window?.usedPercent);
  if (remainingPercent === undefined) return undefined;
  const resetsAt =
    typeof window?.resetsAt === "number" ? window.resetsAt : undefined;
  return { label, remainingPercent, resetsAt };
}

export function parseCodexRateLimits(payload: unknown): ProviderAccountUsage {
  const root = record(payload);
  const byId = record(root?.rateLimitsByLimitId);
  const buckets = byId ? Object.values(byId).map(record).filter(Boolean) : [];
  const snapshot =
    record(byId?.codex) ??
    buckets.find((bucket) => bucket?.limitId === "codex") ??
    record(root?.rateLimits);
  const short = codexWindow(snapshot?.primary, "5시간");
  const weekly = codexWindow(snapshot?.secondary, "주간");
  return short || weekly
    ? { status: "available", short, weekly }
    : { status: "unavailable" };
}

function resetLabel(section: string) {
  const match = section.match(/(?:resets?|초기화|재설정)\s*[:：]?\s*([^\n]+)/i);
  return match?.[1]?.trim();
}

function textWindow(section: string, label: string) {
  const match = section.match(
    /(\d+(?:\.\d+)?)\s*%\s*(used|사용|remaining|left|남음)/i,
  );
  if (!match) return undefined;
  const isRemaining = /remaining|left|남음/i.test(match[2]);
  const remainingPercent = remaining(match[1], isRemaining);
  if (remainingPercent === undefined) return undefined;
  return {
    label,
    remainingPercent,
    resetLabel: resetLabel(section),
  } satisfies AccountUsageWindow;
}

function structuredWindow(value: unknown, label: string) {
  const window = record(value);
  if (!window) return undefined;
  const direct = remaining(window.remainingPercent, true);
  const fromUsed = remaining(window.usedPercent);
  const remainingPercent = direct ?? fromUsed;
  if (remainingPercent === undefined) return undefined;
  return {
    label,
    remainingPercent,
    resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : undefined,
    resetLabel:
      typeof window.resetLabel === "string" ? window.resetLabel : undefined,
  } satisfies AccountUsageWindow;
}

export function parseClaudeUsage(raw: string): ProviderAccountUsage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    envelope = raw;
  }
  const root = record(envelope);
  const structured =
    record(root?.structured_output) ?? record(root?.usage_limits);
  const shortStructured = structuredWindow(
    structured?.session ?? structured?.currentSession ?? structured?.short,
    "세션",
  );
  const weeklyStructured = structuredWindow(
    structured?.weekly ?? structured?.currentWeek ?? structured?.week,
    "주간",
  );
  if (shortStructured || weeklyStructured)
    return {
      status: "available",
      short: shortStructured,
      weekly: weeklyStructured,
    };

  const text =
    typeof root?.result === "string"
      ? root.result
      : typeof envelope === "string"
        ? envelope
        : "";
  const weekIndex = text.search(/current\s+week|이번\s*주|주간/i);
  const sessionSection = weekIndex >= 0 ? text.slice(0, weekIndex) : text;
  const weeklySection = weekIndex >= 0 ? text.slice(weekIndex) : "";
  let short: AccountUsageWindow | undefined = textWindow(
    sessionSection,
    "세션",
  );
  let weekly: AccountUsageWindow | undefined = textWindow(
    weeklySection,
    "주간",
  );

  if (!short || !weekly) {
    const matches = [
      ...text.matchAll(
        /(\d+(?:\.\d+)?)\s*%\s*(used|사용|remaining|left|남음)/gi,
      ),
    ];
    if (!short && matches[0]) {
      const isRemaining = /remaining|left|남음/i.test(matches[0][2]);
      const value = remaining(matches[0][1], isRemaining);
      if (value !== undefined)
        short = { label: "세션", remainingPercent: value };
    }
    if (!weekly && matches[1]) {
      const isRemaining = /remaining|left|남음/i.test(matches[1][2]);
      const value = remaining(matches[1][1], isRemaining);
      if (value !== undefined)
        weekly = { label: "주간", remainingPercent: value };
    }
  }

  return short || weekly
    ? { status: "available", short, weekly }
    : { status: "unavailable" };
}

export function readCodexAccountUsage(): Promise<ProviderAccountUsage> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: os.tmpdir(),
      env: subscriptionEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, result?: ProviderAccountUsage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(result ?? { status: "unavailable" });
    };
    const timer = setTimeout(
      () => finish(new Error("Codex usage read timed out")),
      20_000,
    );
    const send = (message: JsonObject) =>
      child.stdin.write(`${JSON.stringify(message)}\n`);
    let usage: ProviderAccountUsage | undefined;
    let account: AccountIdentity | undefined;
    let accountDone = false;
    const maybeFinish = () => {
      if (usage && accountDone) finish(undefined, { ...usage, account });
    };

    child.on("error", () => finish(new Error("Codex app-server unavailable")));
    child.stdin.on("error", () =>
      finish(new Error("Codex app-server input unavailable")),
    );
    child.on("close", () =>
      finish(new Error("Codex app-server closed before usage response")),
    );
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 1_000_000)
        return finish(new Error("Codex usage response too large"));
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let message: JsonObject | undefined;
        try {
          message = record(JSON.parse(line));
        } catch {
          continue;
        }
        if (message?.id === 1 && message.result) {
          send({ method: "initialized" });
          send({
            id: 2,
            method: "account/rateLimits/read",
            params: {
              excludeResetCreditDetails: true,
              supportsLunaReserve: false,
            },
          });
          send({ id: 3, method: "account/read", params: { refreshToken: false } });
        }
        if (message?.id === 2) {
          if (message.error) return finish(new Error("Codex usage request failed"));
          usage = parseCodexRateLimits(message.result);
          maybeFinish();
        }
        if (message?.id === 3) {
          // Account info is optional; a failure still shows usage.
          if (!message.error) account = parseCodexAccount(message.result);
          accountDone = true;
          maybeFinish();
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "research-studio",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export async function readClaudeAccountUsage(): Promise<ProviderAccountUsage> {
  const auth = execute("claude", ["auth", "status"], os.tmpdir(), "", 15_000)
    .then(parseClaudeAuth)
    .catch(() => undefined);
  const raw = await execute(
    "claude",
    [
      "-p",
      "/usage",
      "--output-format",
      "json",
      "--safe-mode",
      "--no-session-persistence",
      "--tools",
      "",
    ],
    os.tmpdir(),
    "",
    20_000,
  );
  return { ...parseClaudeUsage(raw), account: await auth };
}

export async function getAccountUsage(
  options: ReadOptions = {},
): Promise<AccountUsage> {
  const now = options.now ?? Date.now;
  const currentTime = now();
  if (cached && currentTime < cached.expiresAt) return cached.value;
  if (pending) return pending;

  const readCodex = options.readCodex ?? readCodexAccountUsage;
  const readClaude = options.readClaude ?? readClaudeAccountUsage;
  pending = (async () => {
    const [codexResult, claudeResult] = await Promise.allSettled([
      readCodex(),
      readClaude(),
    ]);
    const value: AccountUsage = {
      codex:
        codexResult.status === "fulfilled"
          ? codexResult.value
          : { status: "unavailable" },
      claude:
        claudeResult.status === "fulfilled"
          ? claudeResult.value
          : { status: "unavailable" },
      fetchedAt: new Date(currentTime).toISOString(),
    };
    cached = { expiresAt: currentTime + CACHE_MS, value };
    return value;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

export function clearAccountUsageCacheForTests() {
  cached = undefined;
  pending = undefined;
}
