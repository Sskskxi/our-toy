import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inputSchema, type Project, type Input } from "./types";
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
  fs.writeFileSync(temp, JSON.stringify(p, null, 2), { mode: 0o600 });
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
export function create(raw: Input) {
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
