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
export function save(p: Project) {
  p.updatedAt = new Date().toISOString();
  const target = file(p.id),
    temp = target + "." + randomUUID() + ".tmp";
  // Compact JSON: projects are rewritten after every call and can reach
  // hundreds of KB, so indentation only costs write and parse time.
  fs.writeFileSync(temp, JSON.stringify(p), { mode: 0o600 });
  fs.renameSync(temp, target);
}
export function get(id: string): Project | undefined {
  const f = file(id);
  if (!fs.existsSync(f)) return undefined;
  const p = JSON.parse(fs.readFileSync(f, "utf8")) as Project;
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
    .map((f) => get(f.slice(0, -5))!)
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
  /** Oldest queued follow-up turn, used by the worker queue. */
  queuedTurnAt?: string;
  queuedTurnId?: string;
  /** Changes whenever the project file changes; clients poll with it. */
  version: string;
};

// Polling and the worker loop only need a few fields. Re-parse a project file
// only when its mtime or size changed.
const briefCache = new Map<string, { stamp: string; brief: ProjectBrief }>();

export function projectVersion(id: string) {
  try {
    const st = fs.statSync(file(id));
    return `${st.ino}-${st.mtimeMs}-${st.size}`;
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
      status: p.status,
      mode: p.mode,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      stage: p.stage,
      queuedTurnAt: queued?.createdAt,
      queuedTurnId: queued?.id,
      version: stamp,
    };
    briefCache.set(id, { stamp, brief });
    out.push(brief);
  }
  for (const id of briefCache.keys()) if (!seen.has(id)) briefCache.delete(id);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
