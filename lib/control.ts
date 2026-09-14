import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./store";

// Stop requests from the web server to the worker. Like interventions they are
// separate files, so the web server never rewrites a project the worker holds.
function cancelFile(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid project ID");
  return path.join(dataDir(), id + ".cancel");
}

export class CancelledError extends Error {
  constructor() {
    super("사용자가 중지했습니다. 이어서 실행으로 멈춘 단계부터 계속할 수 있습니다.");
    this.name = "CancelledError";
  }
}

export function requestCancel(id: string) {
  fs.writeFileSync(cancelFile(id), new Date().toISOString(), { mode: 0o600 });
}

export function isCancelRequested(id: string) {
  try {
    return fs.existsSync(cancelFile(id));
  } catch {
    return false;
  }
}

export function clearCancel(id: string) {
  try {
    fs.rmSync(cancelFile(id), { force: true });
  } catch {}
}

export function throwIfCancelled(id: string) {
  if (isCancelRequested(id)) throw new CancelledError();
}

// Heartbeat so the UI can tell a stopped worker from a slow model.
export function heartbeatFile() {
  return path.join(dataDir(), "worker.heartbeat");
}

export function writeHeartbeat(current?: string) {
  try {
    fs.writeFileSync(
      heartbeatFile(),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, current }),
      { mode: 0o600 },
    );
  } catch {}
}

/**
 * true/false from a heartbeat, or undefined when no heartbeat was ever written
 * (e.g. a worker started before heartbeats existed): unknown is not "down".
 */
export function workerAlive(maxAgeMs = 20_000): boolean | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(heartbeatFile(), "utf8");
  } catch {
    return undefined;
  }
  try {
    return Date.now() - Date.parse(JSON.parse(raw).at) < maxAgeMs;
  } catch {
    return undefined;
  }
}
