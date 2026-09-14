import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { clearAccountUsageCache } from "./account-usage";
import { briefs } from "./store";
import { execute, subscriptionEnv } from "./subscription";

// Sign in, sign out and switch accounts through the official CLIs, so nobody has
// to open a terminal. Credentials stay inside each CLI; this module only sees
// the browser sign-in URL and whether the flow finished.

export type Provider = "codex" | "claude";

export type AuthFlow = {
  state: "idle" | "pending" | "done" | "failed";
  /** Browser sign-in URL, for "브라우저가 안 열렸다면" links. */
  url?: string;
  error?: string;
  startedAt?: string;
};

type Running = AuthFlow & { child?: ChildProcess; cancel?: () => void };

const LOGIN_TIMEOUT_MS = 10 * 60_000;

// Next dev reloads modules on edit; keep in-flight logins across reloads.
const flows: Record<Provider, Running> = ((
  globalThis as { __accountAuthFlows?: Record<Provider, Running> }
).__accountAuthFlows ??= { codex: { state: "idle" }, claude: { state: "idle" } });

export function authStatus(): Record<Provider, AuthFlow> {
  const view = ({ state, url, error, startedAt }: Running) => ({ state, url, error, startedAt });
  return { codex: view(flows.codex), claude: view(flows.claude) };
}

/** Research that calls the subscriptions would fail mid-call if the account changed. */
export function subscriptionBusy() {
  return briefs().some(
    (p) =>
      p.mode === "subscription" &&
      (p.status === "running" || p.status === "queued" || Boolean(p.queuedTurnAt) || p.turnActive),
  );
}

function finish(provider: Provider, result: { ok: true } | { ok: false; error: string }) {
  const flow = flows[provider];
  if (flow.state !== "pending") return;
  flow.child?.kill("SIGTERM");
  flows[provider] = result.ok
    ? { state: "done", startedAt: flow.startedAt }
    : { state: "failed", error: result.error, startedAt: flow.startedAt };
  clearAccountUsageCache();
}

type JsonObject = Record<string, unknown>;

/** Speaks JSON-RPC to `codex app-server` over stdio. */
function codexServer() {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    cwd: os.tmpdir(),
    env: subscriptionEnv(),
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map<number, (message: JsonObject) => void>();
  const listeners: ((message: JsonObject) => void)[] = [];
  let nextId = 1;
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer = (buffer + String(chunk)).slice(-1_000_000);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      let message: JsonObject;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const id = typeof message.id === "number" ? message.id : undefined;
      if (id !== undefined && waiting.has(id)) {
        waiting.get(id)!(message);
        waiting.delete(id);
      } else listeners.forEach((listen) => listen(message));
    }
  });
  child.stdin!.on("error", () => {});
  const request = (method: string, params: JsonObject) =>
    new Promise<JsonObject>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error("Codex가 응답하지 않아요.")), 20_000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error("Codex가 요청을 거절했어요."));
        else resolve((message.result ?? {}) as JsonObject);
      });
      child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const ready = new Promise<void>((resolve, reject) => {
    child.on("error", () => reject(new Error("Codex CLI를 찾지 못했어요. 설치 상태를 확인해 주세요.")));
    request("initialize", {
      clientInfo: { name: "research-studio", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    }).then(() => {
      child.stdin!.write(`${JSON.stringify({ method: "initialized" })}\n`);
      resolve();
    }, reject);
  });
  return { child, ready, request, onNotification: (listen: (m: JsonObject) => void) => listeners.push(listen) };
}

async function startCodexLogin() {
  const server = codexServer();
  flows.codex.child = server.child;
  server.child.on("close", () =>
    finish("codex", { ok: false, error: "로그인 창이 닫혔어요. 다시 시도해 주세요." }),
  );
  server.onNotification((message) => {
    if (message.method !== "account/login/completed") return;
    const params = (message.params ?? {}) as { success?: boolean };
    finish(
      "codex",
      params.success ? { ok: true } : { ok: false, error: "GPT 로그인을 마치지 못했어요. 다시 시도해 주세요." },
    );
  });
  await server.ready;
  // ChatGPT sign-in; the app-server keeps a local callback server open until it completes.
  const result = await server.request("account/login/start", { type: "chatgpt" });
  const loginId = typeof result.loginId === "string" ? result.loginId : undefined;
  if (typeof result.authUrl !== "string" || !result.authUrl.startsWith("https://"))
    throw new Error("GPT 로그인 주소를 받지 못했어요.");
  flows.codex.url = result.authUrl;
  flows.codex.cancel = () => {
    if (loginId) void server.request("account/login/cancel", { loginId }).catch(() => {});
    setTimeout(() => server.child.kill("SIGTERM"), 500);
  };
}

// `claude auth login` opens the browser itself and prints the URL as a fallback,
// wrapped in an OSC 8 terminal hyperlink.
const CLAUDE_URL = /https:\/\/[^\s"'<>]+/;

function startClaudeLogin() {
  const child = spawn("claude", ["auth", "login", "--claudeai"], {
    cwd: os.tmpdir(),
    env: subscriptionEnv(),
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  flows.claude.child = child;
  let output = "";
  const read = (chunk: Buffer) => {
    output = (output + String(chunk)).slice(-20_000);
    const url = output.match(CLAUDE_URL)?.[0];
    if (url && !flows.claude.url) flows.claude.url = url;
  };
  child.stdout!.on("data", read);
  child.stderr!.on("data", read);
  child.stdin!.on("error", () => {});
  child.on("error", () =>
    finish("claude", { ok: false, error: "Claude CLI를 찾지 못했어요. 설치 상태를 확인해 주세요." }),
  );
  child.on("close", (code) =>
    finish(
      "claude",
      code === 0 ? { ok: true } : { ok: false, error: "Claude 로그인을 마치지 못했어요. 다시 시도해 주세요." },
    ),
  );
  flows.claude.cancel = () => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {}
  };
}

/** Starts a browser sign-in. Used both to log in and to switch accounts. */
export async function startLogin(provider: Provider) {
  if (flows[provider].state === "pending") return authStatus()[provider];
  if (subscriptionBusy()) throw new Error("구독 모드 연구가 진행 중이라 지금은 계정을 바꿀 수 없어요.");
  const flow: Running = { state: "pending", startedAt: new Date().toISOString() };
  flows[provider] = flow;
  const timer = setTimeout(
    () => {
      if (flows[provider] !== flow) return;
      flow.cancel?.();
      finish(provider, { ok: false, error: "로그인 시간이 지났어요. 다시 시도해 주세요." });
    },
    LOGIN_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    if (provider === "codex") await startCodexLogin();
    else startClaudeLogin();
  } catch (e) {
    flow.cancel?.();
    finish(provider, { ok: false, error: e instanceof Error ? e.message : "로그인을 시작하지 못했어요." });
  }
  return authStatus()[provider];
}

export function cancelLogin(provider: Provider) {
  const flow = flows[provider];
  if (flow.state !== "pending") return authStatus()[provider];
  flows[provider] = { state: "idle" };
  flow.cancel?.();
  return authStatus()[provider];
}

/** Claude falls back to a pasted code when the browser callback cannot reach it. */
export function submitClaudeCode(code: string) {
  const flow = flows.claude;
  if (flow.state !== "pending" || !flow.child?.stdin?.writable)
    throw new Error("진행 중인 Claude 로그인이 없어요.");
  flow.child.stdin.write(`${code.trim()}\n`);
}

export async function logout(provider: Provider) {
  if (subscriptionBusy()) throw new Error("구독 모드 연구가 진행 중이라 지금은 로그아웃할 수 없어요.");
  cancelLogin(provider);
  if (provider === "claude") {
    await execute("claude", ["auth", "logout"], os.tmpdir(), "", 20_000);
  } else {
    const server = codexServer();
    try {
      await server.ready;
      await server.request("account/logout", {});
    } finally {
      server.child.kill("SIGTERM");
    }
  }
  flows[provider] = { state: "idle" };
  clearAccountUsageCache();
}
