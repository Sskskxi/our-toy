import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir, list } from "./store";

// The web server only checks for updates and writes a request file. The
// launcher (scripts/launch.mjs), which is not restarted, stops the app, runs a
// fixed fast-forward pull and restarts it. No request data reaches a command.
export const UPDATE_REQUEST = ".update-request.json";
export const UPDATE_RESULT = ".update-result.json";
const FETCH_EVERY_MS = 10 * 60 * 1000;
const REF = /^[A-Za-z0-9._\/-]{1,100}$/;

export type UpdateStatus = {
  enabled: boolean;
  supported: boolean;
  current?: string;
  upstream?: string;
  behind: number;
  commits: { sha: string; subject: string }[];
  dirty: boolean;
  runningResearch: number;
  canUpdate: boolean;
  reason?: string;
  pending: boolean;
  checkedAt: string;
  lastResult?: {
    state: "done" | "failed";
    message: string;
    finishedAt: string;
    from?: string;
    to?: string;
  };
};

function git(args: string[], timeout = 20000) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      args,
      {
        cwd: process.cwd(),
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    ),
  );
}

let lastFetch = 0;

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function updateStatus({ refresh = false } = {}): Promise<UpdateStatus> {
  const base: UpdateStatus = {
    enabled: process.env.ENABLE_SELF_UPDATE !== "false",
    supported: false,
    behind: 0,
    commits: [],
    dirty: false,
    runningResearch: list().filter((p) => p.status === "running").length,
    canUpdate: false,
    pending: fs.existsSync(path.join(dataDir(), UPDATE_REQUEST)),
    checkedAt: new Date().toISOString(),
    lastResult: readJson(path.join(dataDir(), UPDATE_RESULT)),
  };
  if (!base.enabled) return { ...base, reason: "ENABLE_SELF_UPDATE=false 로 꺼져 있습니다." };
  try {
    if ((await git(["rev-parse", "--is-inside-work-tree"])) !== "true") throw new Error();
  } catch {
    return { ...base, reason: "git으로 받은 폴더가 아니라 자동 업데이트를 쓸 수 없습니다." };
  }
  let upstream = "";
  try {
    upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    return { ...base, reason: "추적 중인 원격 브랜치가 없습니다." };
  }
  const slash = upstream.indexOf("/");
  const remote = upstream.slice(0, slash),
    branch = upstream.slice(slash + 1);
  if (slash < 1 || !REF.test(remote) || !REF.test(branch) || remote.startsWith("-"))
    return { ...base, reason: "원격 브랜치 이름을 확인할 수 없습니다." };
  const status: UpdateStatus = { ...base, supported: true, upstream };
  if (refresh || Date.now() - lastFetch > FETCH_EVERY_MS) {
    try {
      await git(["fetch", "--quiet", "--no-tags", "--", remote, branch], 30000);
      lastFetch = Date.now();
    } catch {
      status.reason = "원격 저장소에 연결하지 못했습니다.";
    }
  }
  status.current = await git(["rev-parse", "--short", "HEAD"]);
  status.behind = Number(await git(["rev-list", "--count", "HEAD..@{u}"])) || 0;
  if (status.behind)
    status.commits = (await git(["log", "--format=%h%x09%s", "-n", "10", "HEAD..@{u}"]))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...rest] = line.split("\t");
        return { sha, subject: rest.join("\t") };
      });
  status.dirty = Boolean(await git(["status", "--porcelain", "--untracked-files=no"]));
  status.reason ??= status.dirty
    ? "코드에 커밋하지 않은 변경이 있어 자동 업데이트를 할 수 없습니다."
    : status.runningResearch
      ? "진행 중인 연구가 끝난 뒤 업데이트할 수 있습니다."
      : status.pending
        ? "업데이트를 적용하는 중입니다."
        : undefined;
  status.canUpdate = status.behind > 0 && !status.reason;
  return status;
}

export async function requestUpdate() {
  const status = await updateStatus({ refresh: true });
  if (!status.canUpdate) throw new Error(status.reason ?? "이미 최신 버전입니다.");
  fs.writeFileSync(
    path.join(dataDir(), UPDATE_REQUEST),
    JSON.stringify({ requestedAt: new Date().toISOString(), from: status.current }),
    { mode: 0o600, flag: "wx" },
  );
  return status;
}
