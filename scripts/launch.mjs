import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
const mode = process.argv[2] || "dev";
if (mode === "dev") process.env.WATCHPACK_POLLING ??= "1000";

// Must match lib/updater.ts.
const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const requestFile = path.join(dataDir, ".update-request.json");
const resultFile = path.join(dataDir, ".update-result.json");
fs.mkdirSync(dataDir, { recursive: true });
fs.rmSync(requestFile, { force: true });

let children = [];
let stopping = false;
let updating = false;

function start() {
  children = [
    spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        mode,
        "--hostname",
        "127.0.0.1",
        "--port",
        process.env.PORT || "3000",
        ...(mode === "dev" ? ["--webpack"] : []),
      ],
      { stdio: "inherit" },
    ),
    spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
      stdio: "inherit",
    }),
  ];
  children.forEach((c) => {
    c.on("error", () => !updating && stop(1));
    c.on("exit", (code) => !updating && stop(code ?? 1));
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((c) => c.kill("SIGTERM"));
  setTimeout(() => process.exit(code), 300).unref();
}

function stopChildren() {
  return Promise.all(
    children.map(
      (c) =>
        new Promise((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null) return resolve();
          const force = setTimeout(() => c.kill("SIGKILL"), 10000);
          c.once("exit", () => {
            clearTimeout(force);
            resolve();
          });
          c.kill("SIGTERM");
        }),
    ),
  );
}

// Fixed commands only; nothing from the request file is passed to them.
function run(command, args, timeout = 300000) {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    shell: process.platform === "win32",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0)
    throw new Error(
      `${command} ${args[0]} 실패: ${(r.stderr || r.stdout || "").trim().slice(-400)}`,
    );
  return (r.stdout || "").trim();
}

async function applyUpdate() {
  updating = true;
  fs.rmSync(requestFile, { force: true });
  console.log("\n[update] 업데이트를 적용합니다. 앱을 잠시 멈춥니다…");
  await stopChildren();
  const result = { state: "done", message: "", finishedAt: "", from: "", to: "" };
  try {
    result.from = run("git", ["rev-parse", "--short", "HEAD"]);
    if (run("git", ["status", "--porcelain", "--untracked-files=no"]))
      throw new Error("커밋하지 않은 코드 변경이 있어 업데이트를 중단했습니다.");
    run("git", ["pull", "--ff-only", "--no-rebase"], 120000);
    result.to = run("git", ["rev-parse", "--short", "HEAD"]);
    const changed = run("git", ["diff", "--name-only", result.from, result.to]).split("\n");
    if (changed.some((f) => f === "package-lock.json" || f === "package.json")) {
      console.log("[update] 의존성이 바뀌어 npm ci를 실행합니다…");
      run("npm", ["ci"], 600000);
    }
    if (mode === "start") {
      console.log("[update] 프로덕션 빌드를 다시 만듭니다…");
      run("npm", ["run", "build"], 600000);
    }
    result.message =
      result.from === result.to
        ? "이미 최신 버전입니다."
        : `${result.from} → ${result.to} 업데이트 완료`;
  } catch (e) {
    result.state = "failed";
    result.message = e instanceof Error ? e.message : "업데이트 실패";
  }
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(`[update] ${result.message}. 앱을 다시 시작합니다.`);
  updating = false;
  if (!stopping) start();
}

start();
setInterval(() => {
  if (!updating && !stopping && fs.existsSync(requestFile)) void applyUpdate();
}, 2000);
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
