import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { CliFailure, classifyFailure, cliFailure, reportedErrors, sanitizeDetail, stageTimeout, effortTimeFactor } from "./cli-errors";
import { answerSchema, modelsSchema, SEARCH_STAGES, type Request, type Result } from "./types";

// Only OS runtime variables reach the official clients. Never inherit API keys,
// provider overrides, OAuth tokens, project dotenv, or alternate auth directories.
export function subscriptionEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const k of [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "WINDIR",
  ])
    if (source[k]) env[k] = source[k];
  env.PATH = [path.join(os.homedir(), ".local/bin"), source.PATH || ""].join(
    path.delimiter,
  );
  return env;
}
const children = new Set<ReturnType<typeof spawn>>();
function terminate(p: ReturnType<typeof spawn>) {
  try {
    if (p.pid && process.platform !== "win32") process.kill(-p.pid, "SIGTERM");
    else p.kill("SIGTERM");
  } catch {}
}
export function stopSubscriptionCalls() {
  for (const p of children) terminate(p);
}
export function execute(
  command: string,
  args: string[],
  cwd: string,
  input = "",
  timeout = 180000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, {
      cwd,
      env: subscriptionEnv(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(p);
    let stdout = "",
      stderr = "",
      failure: CliFailure | undefined;
    const timer = setTimeout(() => {
      failure = new CliFailure(command, "timeout", `${Math.round(timeout / 1000)}초 초과`);
      terminate(p);
    }, timeout);
    p.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > 16_000_000) {
        failure = new CliFailure(command, "output", "출력이 16MB를 넘었습니다");
        terminate(p);
      }
    });
    p.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-20000);
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
    p.on("error", () => {
      clearTimeout(timer);
      children.delete(p);
      reject(
        new CliFailure(command, "cli", "공식 CLI를 찾지 못했습니다. 설치와 PATH를 확인하세요"),
      );
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      children.delete(p);
      if (failure) reject(failure);
      else if (code !== 0) reject(cliFailure(command, stdout, stderr));
      else resolve(stdout);
    });
  });
}
export function wireSchema() {
  return JSON.stringify(z.toJSONSchema(answerSchema), (key, value) =>
    ["format", "$schema"].includes(key) ? undefined : value,
  );
}
export function decodeClaude(raw: string, model: string): Result {
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new CliFailure("claude", "output", "JSON이 아닌 출력");
  }
  if (d.is_error || d.subtype !== "success") {
    const text = reportedErrors(JSON.stringify({ ...d, is_error: true }), "");
    const kind = classifyFailure(text);
    throw new CliFailure("claude", kind === "unknown" ? "output" : kind, sanitizeDetail(text));
  }
  let answer;
  try {
    answer = answerSchema.parse(d.structured_output ?? JSON.parse(d.result));
  } catch {
    throw new CliFailure("claude", "output", "구조화된 답변 형식이 다릅니다");
  }
  return {
    answer,
    model,
    observedUrls: [],
    // Cached prompt tokens still count toward subscription limits and latency.
    tokens:
      (d.usage?.input_tokens || 0) +
      (d.usage?.cache_read_input_tokens || 0) +
      (d.usage?.cache_creation_input_tokens || 0) +
      (d.usage?.output_tokens || 0),
    sessionId: typeof d.session_id === "string" ? d.session_id : undefined,
  };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function checkedSession(id: string | undefined) {
  if (!id) return undefined;
  if (!UUID.test(id)) throw new Error("저장된 모델 세션 ID가 올바르지 않습니다.");
  return id;
}
function sessionWorkdir(r: Request, fallback: string) {
  if (!r.projectId || !UUID.test(r.projectId)) return fallback;
  const dir = path.join(
    path.resolve(process.env.DATA_DIR || "./data"),
    ".sessions",
    r.projectId,
    r.actor.toLowerCase(),
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
type EnvSource = Record<string, string | undefined>;
export function modelDefaults(source: EnvSource = process.env) {
  return {
    GPT: {
      model: source.OPENAI_MODEL || "gpt-5.6-sol",
      effort: source.OPENAI_REASONING_EFFORT || "high",
    },
    Claude: {
      model: source.ANTHROPIC_MODEL || "claude-opus-5",
      effort: source.ANTHROPIC_EFFORT || "high",
    },
  };
}
// UI choices win over .env defaults. Both are re-validated here because the
// values become CLI arguments.
export function resolveModel(
  r: Pick<Request, "actor" | "model" | "effort">,
  source: EnvSource = process.env,
) {
  const fallback = modelDefaults(source)[r.actor];
  const model = r.model || fallback.model;
  const effort = r.effort || fallback.effort;
  if (!modelsSchema.safeParse({ [r.actor]: { model, effort } }).success)
    throw new Error("모델 또는 추론 수준 설정 오류");
  return { model, effort };
}
export function buildCodexArgs(options: {
  model: string;
  effort: string;
  search: boolean;
  schemaPath: string;
  output: string;
  sessionId?: string;
}) {
  const common = [
    "--model",
    options.model,
    "-c",
    `model_reasoning_effort="${options.effort}"`,
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    "features.shell_tool=false",
    "-c",
    `web_search="${options.search ? "live" : "disabled"}"`,
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--output-schema",
    options.schemaPath,
    "--output-last-message",
    options.output,
    "--json",
  ];
  return options.sessionId
    ? [
        "exec",
        "resume",
        ...common,
        "-c",
        'sandbox_mode="read-only"',
        options.sessionId,
        "-",
      ]
    : ["exec", ...common, "--ephemeral", "--sandbox", "read-only", "-"];
}
export function buildClaudeArgs(options: {
  model: string;
  effort: string;
  search: boolean;
  schema: string;
  /** Only for resuming legacy project sessions; new calls keep no session. */
  sessionId?: string;
  resume?: boolean;
}) {
  const args = [
    "-p",
    "--model",
    options.model,
    "--effort",
    options.effort,
    "--output-format",
    "json",
    "--json-schema",
    options.schema,
    "--tools",
    options.search ? "WebSearch,WebFetch" : "",
    "--safe-mode",
    "--strict-mcp-config",
    ...(options.resume && options.sessionId
      ? ["--resume", options.sessionId]
      : ["--no-session-persistence"]),
  ];
  if (options.search) args.push("--allowedTools", "WebSearch,WebFetch");
  return args;
}
function parseCodexAnswer(file: string) {
  try {
    return answerSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    throw new CliFailure("codex", "output", "구조화된 답변 파일이 없거나 형식이 다릅니다");
  }
}
export async function subscription(
  r: Request,
  prompt: string,
): Promise<Result> {
  const { model, effort } = resolveModel(r);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-call-"));
  const open = r.actor === "GPT";
  const search =
    SEARCH_STAGES.includes(r.stage) &&
    process.env.ENABLE_WEB_SEARCH !== "false";
  const previousSession = checkedSession(r.sessionId);
  // Each call is self-contained: the prompt carries the document, ledger and
  // recent turns, so resuming a CLI thread would only resend its whole history.
  const cwd = previousSession ? sessionWorkdir(r, dir) : dir;
  try {
    const schema = wireSchema();
    let result: Result;
    if (open) {
      const schemaPath = path.join(dir, "schema.json"),
        output = path.join(dir, "answer.json");
      fs.writeFileSync(schemaPath, schema);
      const args = buildCodexArgs({
        model,
        effort,
        search,
        schemaPath,
        output,
        sessionId: previousSession,
      });
      const raw = await execute(
        "codex",
        args,
        cwd,
        prompt,
        stageTimeout(r.stage, process.env, (r.timeoutScale ?? 1) * effortTimeFactor(effort)),
      );
      const events = raw.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      if (events.some((e) => e.type === "turn.failed" || e.type === "error"))
        throw cliFailure("codex", raw, "");
      const usage = [...events]
        .reverse()
        .find((e) => e.type === "turn.completed")?.usage;
      const sessionId = previousSession;
      result = {
        answer: parseCodexAnswer(output),
        model,
        observedUrls: [],
        tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
        sessionId,
      };
    } else {
      // A slow or failing status check must not block the call; only a clear
      // "not logged in / not a subscription" answer does.
      const auth = await execute("claude", ["auth", "status"], dir, "", 30000)
        .then((out) => JSON.parse(out))
        .catch(() => undefined);
      if (auth && (!auth.loggedIn || auth.authMethod !== "claude.ai"))
        throw new CliFailure(
          "claude",
          "auth",
          auth.loggedIn ? "claude.ai 구독 로그인이 아닙니다" : "claude auth login 필요",
        );
      const args = buildClaudeArgs({
        model,
        effort,
        search,
        schema,
        sessionId: previousSession,
        resume: Boolean(previousSession),
      });
      result = decodeClaude(
        await execute(
          "claude",
          args,
          cwd,
          prompt,
          stageTimeout(r.stage, process.env, (r.timeoutScale ?? 1) * effortTimeFactor(effort)),
        ),
        model,
      );
      result.sessionId = previousSession;
    }
    if (r.stage === "plan" && !result.answer.questions.length)
      throw new Error("연구 질문 분해 결과가 비어 있습니다.");
    if (r.stage === "synthesis" && !result.answer.summary.trim())
      throw new Error("최종 보고서가 비어 있습니다.");
    // CLI-authored source URLs are not independently verified citations.
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
