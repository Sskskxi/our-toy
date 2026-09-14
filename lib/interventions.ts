import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./store";
import {
  interventionSchema,
  type Actor,
  type Intervention,
  type Project,
  type Stage,
} from "./types";

// The worker owns <id>.json and rewrites it whole while a run is in flight, so
// human notes go to a separate inbox that only the web server appends to. The
// worker copies new entries into the project at each stage boundary.
const MAX_INBOX = 50;

function inboxFile(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid project ID");
  return path.join(dataDir(), id + ".inbox.json");
}

export function readInbox(id: string): Intervention[] {
  const file = inboxFile(id);
  if (!fs.existsSync(file)) return [];
  try {
    const items = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

export function addIntervention(id: string, raw: unknown): Intervention {
  const input = interventionSchema.parse(raw);
  const items = readInbox(id);
  if (items.length >= MAX_INBOX)
    throw new Error(`개입은 프로젝트당 최대 ${MAX_INBOX}개까지 가능합니다.`);
  const item: Intervention = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const file = inboxFile(id),
    temp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify([...items, item], null, 2), {
    mode: 0o600,
  });
  fs.renameSync(temp, file);
  return item;
}

/** Worker side: move inbox entries not yet seen into the project as applied. */
export function absorbInterventions(
  p: Project,
  stage: Stage,
  round: number,
  inbox: Intervention[] = readInbox(p.id),
) {
  p.interventions ??= [];
  const known = new Set(p.interventions.map((i) => i.id));
  const fresh = inbox
    .filter((i) => !known.has(i.id))
    .map((i) => ({
      ...i,
      appliedAt: new Date().toISOString(),
      appliedRound: round,
      appliedStage: stage,
    }));
  p.interventions.push(...fresh);
  return fresh;
}

/** Notes applied at this exact stage that the given model should see. */
export function guidanceFor(p: Project, actor: Actor, stage: Stage, round: number) {
  return (p.interventions ?? [])
    .filter(
      (i) =>
        i.appliedStage === stage &&
        i.appliedRound === round &&
        (i.target === "both" || i.target === actor),
    )
    .map((i) => i.text);
}

/** Read side: show notes still waiting in the inbox alongside applied ones. */
export function withPendingInterventions(p: Project): Project {
  const known = new Set((p.interventions ?? []).map((i) => i.id));
  const pending = readInbox(p.id).filter((i) => !known.has(i.id));
  return { ...p, interventions: [...(p.interventions ?? []), ...pending] };
}
