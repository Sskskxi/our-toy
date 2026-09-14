import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inputSchema, type Project, type InputRaw } from "./types";
export function dataDir() {
  const dir = path.resolve(process.env.DATA_DIR || "./data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function file(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid project ID");
  return path.join(dataDir(), id + ".json");
}
// Titles live in <id>.title so a rename never races the worker's saves.
function titleFile(id: string) {
  return file(id).replace(/\.json$/, ".title");
}
export function readTitle(id: string) {
  try {
    return fs.readFileSync(titleFile(id), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
export function setTitle(id: string, title: string) {
  const target = titleFile(id);
  if (!title.trim()) return fs.rmSync(target, { force: true });
  const temp = target + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temp, title.trim(), { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** Remove a project and its side files. Callers must check it is idle. */
export function remove(id: string) {
  const base = file(id).replace(/\.json$/, "");
  for (const ext of [".json", ".inbox.json", ".title", ".cancel"])
    fs.rmSync(base + ext, { force: true });
  fs.rmSync(path.join(dataDir(), ".sessions", id), { recursive: true, force: true });
}

export function save(p: Project) {
  p.updatedAt = new Date().toISOString();
  const { title: _title, ...stored } = p;
  const target = file(p.id),
    temp = target + "." + randomUUID() + ".tmp";
  // Compact JSON: projects are rewritten after every call and can reach
  // hundreds of KB, so indentation only costs write and parse time.
  fs.writeFileSync(temp, JSON.stringify(stored), { mode: 0o600 });
  fs.renameSync(temp, target);
}
export function get(id: string): Project | undefined {
  const f = file(id);
  let p: Project;
  try {
    p = JSON.parse(fs.readFileSync(f, "utf8")) as Project;
  } catch (e) {
    // Missing, or truncated/corrupt (disk full, manual edit): skip it rather
    // than breaking the project list and the worker for every project.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(`[store] 읽을 수 없는 프로젝트 파일을 건너뜁니다: ${id}.json`);
    return undefined;
  }
  p.title = readTitle(id);
  p.providerSessions ??= {};
  p.conversation ??= {
    id: randomUUID(),
    createdAt: p.createdAt,
    memory: "",
    turns: [],
  };
  p.conversation.memory ??= "";
  p.conversation.turns ??= [];
  return p;
}
export function list(): Project[] {
  return fs
    .readdirSync(dataDir())
    .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
    .map((f) => get(f.slice(0, -5)))
    .filter((p): p is Project => Boolean(p))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function create(raw: InputRaw) {
  const input = inputSchema.parse(raw);
  const now = new Date().toISOString();
  const p: Project = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "queued",
    stage: "대기",
    calls: [],
    rounds: [],
    claims: [],
    questions: [],
    unresolved: [],
    tokens: 0,
    providerSessions: {},
    conversation: {
      id: randomUUID(),
      createdAt: now,
      memory: "",
      turns: [],
    },
  };
  save(p);
  return p;
}

export type ProjectBrief = Pick<
  Project,
  "id" | "topic" | "status" | "mode" | "createdAt" | "updatedAt" | "stage"
> & {
  title?: string;
  /** Oldest queued follow-up turn, used by the worker queue. */
  queuedTurnAt?: string;
  queuedTurnId?: string;
  /** A follow-up answer is queued or running. */
  turnActive: boolean;
  /** Next automatic resume of a failed run (ISO time), used by the worker scheduler. */
  autoResumeAt?: string;
  /** Earliest automatic retry of a failed follow-up turn (ISO time). */
  turnRetryAt?: string;
  /** Changes whenever the project file changes; clients poll with it. */
  version: string;
};

// Polling and the worker loop only need a few fields. Re-parse a project file
// only when its mtime or size changed.
const briefCache = new Map<string, { stamp: string; brief: ProjectBrief }>();

export function projectVersion(id: string) {
  try {
    const st = fs.statSync(file(id));
    let title = "";
    try {
      title = String(fs.statSync(titleFile(id)).mtimeMs);
    } catch {}
    return `${st.ino}-${st.mtimeMs}-${st.size}-${title}`;
  } catch {
    return undefined;
  }
}

export function briefs(): ProjectBrief[] {
  const seen = new Set<string>();
  const out: ProjectBrief[] = [];
  for (const name of fs.readdirSync(dataDir())) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const id = name.slice(0, -5);
    seen.add(id);
    const stamp = projectVersion(id);
    if (!stamp) continue;
    const cached = briefCache.get(id);
    if (cached?.stamp === stamp) {
      out.push(cached.brief);
      continue;
    }
    const p = get(id);
    if (!p) continue;
    const queued = (p.conversation?.turns ?? [])
      .filter((t) => t.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const brief: ProjectBrief = {
      id: p.id,
      topic: p.topic,
      title: p.title,
      status: p.status,
      mode: p.mode,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      stage: p.stage,
      queuedTurnAt: queued?.createdAt,
      queuedTurnId: queued?.id,
      turnActive: (p.conversation?.turns ?? []).some(
        (t) => t.status === "running" || t.status === "queued",
      ),
      autoResumeAt: p.status === "failed" ? p.autoResume?.at : undefined,
      turnRetryAt: (p.conversation?.turns ?? [])
        .filter((t) => t.status === "failed" && t.autoRetry?.at)
        .map((t) => t.autoRetry!.at)
        .sort()[0],
      version: stamp,
    };
    briefCache.set(id, { stamp, brief });
    out.push(brief);
  }
  for (const id of briefCache.keys()) if (!seen.has(id)) briefCache.delete(id);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
