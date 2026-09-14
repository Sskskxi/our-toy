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

export function inboxVersion(id: string) {
  try {
    const st = fs.statSync(inboxFile(id));
    return `${st.ino}-${st.mtimeMs}-${st.size}`;
  } catch {
    return "0";
  }
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

const targetsOf = (note: Intervention): Actor[] =>
  note.target === "both" ? ["GPT", "Claude"] : [note.target];

function delivered(note: Intervention) {
  // Records from before per-model delivery count as delivered once applied.
  if (!note.deliveries) return note.appliedAt ? targetsOf(note) : [];
  return note.deliveries.map((d) => d.actor);
}

export function isPendingNote(note: Intervention) {
  if (note.expired) return false;
  const got = delivered(note);
  return targetsOf(note).some((a) => !got.includes(a));
}

/**
 * Worker side, at a stage boundary: deliver notes to the models taking part in
 * this stage. A note stays pending for any target model that has not run yet,
 * so a Claude-only note is never used up by a GPT-only stage.
 */
export function absorbInterventions(
  p: Project,
  stage: Stage,
  round: number,
  participants: Actor[] = ["GPT", "Claude"],
  inbox: Intervention[] = readInbox(p.id),
) {
  p.interventions ??= [];
  const known = new Map(p.interventions.map((i) => [i.id, i]));
  for (const item of inbox) if (!known.has(item.id)) {
    const copy = { ...item };
    p.interventions.push(copy);
    known.set(copy.id, copy);
  }
  const at = new Date().toISOString();
  const fresh: Intervention[] = [];
  for (const note of p.interventions) {
    if (!isPendingNote(note)) continue;
    const got = delivered(note);
    const now = targetsOf(note).filter((a) => participants.includes(a) && !got.includes(a));
    if (!now.length) continue;
    note.deliveries = [
      ...(note.deliveries ?? []),
      ...now.map((actor) => ({ actor, stage, round, at })),
    ];
    if (!note.appliedAt) {
      note.appliedAt = at;
      note.appliedStage = stage;
      note.appliedRound = round;
    }
    fresh.push(note);
  }
  return fresh;
}

/** When a run completes, notes that never reached a model are marked as such. */
export function expireUndelivered(p: Project, inbox: Intervention[] = readInbox(p.id)) {
  p.interventions ??= [];
  const known = new Set(p.interventions.map((i) => i.id));
  for (const item of inbox) if (!known.has(item.id)) p.interventions.push({ ...item });
  for (const note of p.interventions) if (isPendingNote(note)) note.expired = true;
}

/** Notes delivered to this model at this exact stage. */
export function guidanceFor(p: Project, actor: Actor, stage: Stage, round: number) {
  return (p.interventions ?? [])
    .filter((i) =>
      i.deliveries
        ? i.deliveries.some((d) => d.actor === actor && d.stage === stage && d.round === round)
        : i.appliedStage === stage &&
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
