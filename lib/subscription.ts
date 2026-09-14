import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
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
      failure = "";
    const timer = setTimeout(() => {
      failure = "응답 시간 제한. 중간 기록을 보존했습니다.";
      terminate(p);
    }, timeout);
    p.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > 4000000) {
        failure = "응답 크기 제한";
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
        new Error(
          `${command}: 공식 CLI를 실행하지 못했습니다. 설치와 PATH를 확인하세요.`,
        ),
      );
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      children.delete(p);
      if (code !== 0 || failure) {
        const msg = stdout + " " + stderr;
        const reason =
          failure ||
          (/rate.limit|usage.limit|limit.reached|quota/i.test(msg)
            ? "구독 사용량 제한에 도달했습니다. 한도가 초기화된 뒤 이어서 실행하세요."
            : /auth|log.?in|token|401/i.test(msg)
              ? "구독 인증을 확인하세요. 터미널에서 다시 로그인해야 할 수 있습니다."
              : "CLI 실행 실패. 터미널에서 공식 도구의 상태를 확인하세요.");
        reject(new Error(`${command}: ${reason} (API 자동 전환 없음)`));
      } else resolve(stdout);
    });
  });
}
export function wireSchema() {
  return JSON.stringify(z.toJSONSchema(answerSchema), (key, value) =>
    ["format", "$schema"].includes(key) ? undefined : value,
  );
}
export function decodeClaude(raw: string, model: string): Result {
  const d = JSON.parse(raw);
  if (d.is_error || d.subtype !== "success")
    throw new Error(
      "Claude 구독 실행이 완료되지 않았습니다. API로 전환하지 않습니다.",
    );
  const answer = answerSchema.parse(
    d.structured_output ?? JSON.parse(d.result),
  );
  return {
    answer,
    model,
    observedUrls: [],
    tokens: (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0),
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
    : ["exec", ...common, "--sandbox", "read-only", "-"];
}
export function buildClaudeArgs(options: {
  model: string;
  effort: string;
  search: boolean;
  schema: string;
  sessionId: string;
  resume: boolean;
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
    options.resume ? "--resume" : "--session-id",
    options.sessionId,
  ];
  if (options.search) args.push("--allowedTools", "WebSearch,WebFetch");
  return args;
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
  const cwd = sessionWorkdir(r, dir);
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
      );
      const events = raw.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      if (events.some((e) => e.type === "turn.failed" || e.type === "error"))
        throw new Error("Codex 응답 실패. API로 전환하지 않습니다.");
      const usage = [...events]
        .reverse()
        .find((e) => e.type === "turn.completed")?.usage;
      const sessionId =
        previousSession ??
        events.find((e) => e.type === "thread.started")?.thread_id;
      if (!sessionId || !UUID.test(sessionId))
        throw new Error("Codex 대화 세션을 저장하지 못했습니다.");
      result = {
        answer: answerSchema.parse(JSON.parse(fs.readFileSync(output, "utf8"))),
        model,
        observedUrls: [],
        tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
        sessionId,
      };
    } else {
      const auth = JSON.parse(
        await execute("claude", ["auth", "status"], dir, "", 15000),
      );
      if (!auth.loggedIn || auth.authMethod !== "claude.ai")
        throw new Error("Claude 구독 로그인이 필요합니다: claude auth login");
      const claudeSession = previousSession ?? randomUUID();
      const args = buildClaudeArgs({
        model,
        effort,
        search,
        schema,
        sessionId: claudeSession,
        resume: Boolean(previousSession),
      });
      result = decodeClaude(await execute("claude", args, cwd, prompt), model);
      result.sessionId ??= claudeSession;
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
