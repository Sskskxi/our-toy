import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
const { briefs, dataDir, get, list, save } = await import("../lib/store");
const { stopSubscriptionCalls } = await import("../lib/subscription");
const { clearCancel, isCancelRequested, writeHeartbeat } = await import("../lib/control");
const { run } = await import("../lib/engine");
const { runConversation } = await import("../lib/conversation");
const fs = await import("node:fs");
const path = await import("node:path");
const lock = path.join(dataDir(), "worker.lock");
// A lock is live only if it names a real, other, running process. An empty or
// garbage lock (pid 0 would match our own process group) is stale.
function lockHolderAlive() {
  let pid = NaN;
  try {
    pid = Number(fs.readFileSync(lock, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
try {
  fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
} catch {
  if (lockHolderAlive()) throw new Error("다른 worker가 실행 중입니다.");
  fs.rmSync(lock, { force: true });
  fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
}
const cleanup = () => {
  try {
    if (fs.readFileSync(lock, "utf8") === String(process.pid))
      fs.unlinkSync(lock);
  } catch {}
};
process.on("exit", cleanup);
process.on("SIGTERM", () => {
  stopSubscriptionCalls();
  process.exit(0);
});
process.on("SIGINT", () => {
  stopSubscriptionCalls();
  process.exit(0);
});
for (const p of list()) {
  if (p.status === "running") {
    p.status = "interrupted";
    p.stage = "서버 재시작으로 중단 · 이어서 실행 가능";
    p.error =
      "서버가 재시작되어 연구가 멈췄습니다. '이어서 실행'을 누르면 완료된 단계는 다시 호출하지 않고 멈춘 단계부터 계속합니다.";
    for (const c of p.calls)
      if (c.status === "running") {
        c.status = "failed";
        c.error = "Worker interrupted";
        c.finishedAt = new Date().toISOString();
      }
    save(p);
  }
  let changed = false;
  for (const turn of p.conversation?.turns ?? [])
    if (turn.status === "running") {
      turn.status = "failed";
      turn.error = "서버가 재시작되어 답변이 중단되었습니다. 다시 시도할 수 있습니다.";
      turn.updatedAt = new Date().toISOString();
      changed = true;
    }
  if (changed) {
    p.stage = "대화 응답 중단 · 재시도 가능";
    for (const c of p.calls)
      if (c.status === "running") {
        c.status = "failed";
        c.error = "Worker interrupted";
        c.finishedAt = new Date().toISOString();
      }
    save(p);
  }
}
// Stop requests left from a previous run would otherwise stop the next one.
for (const p of list()) clearCancel(p.id);
console.log("Research worker ready (one local worker, persistent queue)");
// Heartbeat for the UI, and stop requests for whatever is running now.
let current: string | undefined;
writeHeartbeat();
setInterval(() => writeHeartbeat(current), 5000).unref();
setInterval(() => {
  if (current && isCancelRequested(current)) stopSubscriptionCalls();
}, 1000).unref();

while (true) {
  try {
    // Scan cheap briefs; load a full project only when there is work for it.
    const projects = briefs();
    const next = [...projects].reverse().find((p) => p.status === "queued");
    const project = next && get(next.id);
    if (project && project.status === "queued") {
      current = project.id;
      await run(project);
    } else {
      const turn = projects
        .filter((p) => p.queuedTurnAt)
        .sort((a, b) => a.queuedTurnAt!.localeCompare(b.queuedTurnAt!))[0];
      const withTurn = turn && get(turn.id);
      if (withTurn && turn.queuedTurnId) {
        current = withTurn.id;
        await runConversation(withTurn, turn.queuedTurnId);
      } else await new Promise((r) => setTimeout(r, 700));
    }
  } catch (error) {
    // One bad project must not stop the queue for every other project.
    console.error("[worker] 작업 처리 중 오류:", error instanceof Error ? error.message : error);
    await new Promise((r) => setTimeout(r, 2000));
  } finally {
    current = undefined;
  }
}
