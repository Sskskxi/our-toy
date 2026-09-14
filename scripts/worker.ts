import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
const { briefs, dataDir, get, list, save } = await import("../lib/store");
const { stopSubscriptionCalls } = await import("../lib/subscription");
const { clearCancel, isCancelRequested, writeHeartbeat } = await import("../lib/control");
const { run } = await import("../lib/engine");
const { runConversation } = await import("../lib/conversation");
const { planRestartResume } = await import("../lib/auto-resume");
const { tickAutoResume } = await import("../lib/auto-resume-scheduler");
const { getAccountUsage } = await import("../lib/account-usage");
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
// Work cut by a restart continues on its own: completed calls are replayed and
// the running ones are marked failed so they are called again.
const RESTART_TURN_ATTEMPTS = 5;
for (const p of list()) {
  const markRunningCallsFailed = () => {
    for (const c of p.calls)
      if (c.status === "running") {
        c.status = "failed";
        c.error = "Worker interrupted";
        c.finishedAt = new Date().toISOString();
      }
  };
  if (p.status === "running") {
    const plan = p.mode === "live" ? undefined : planRestartResume(p.autoResume, p.calls, new Date());
    if (plan) {
      p.status = "queued";
      p.stage = plan.note;
      p.error = undefined;
      p.autoResume = plan;
    } else {
      // Repeated restarts without progress: leave it to the user.
      p.status = "interrupted";
      p.stage = "서버 재시작으로 중단 · 이어서 실행 가능";
      p.error =
        "서버가 여러 번 다시 켜지는 동안 연구가 앞으로 나아가지 못했어요. '이어서 실행'을 누르면 완료된 단계는 다시 호출하지 않고 멈춘 단계부터 계속해요.";
      p.autoResume = undefined;
    }
    markRunningCallsFailed();
    save(p);
  }
  let changed = false;
  for (const turn of p.conversation?.turns ?? [])
    if (turn.status === "running") {
      if (turn.attempts < RESTART_TURN_ATTEMPTS) {
        turn.status = "queued";
        turn.error = undefined;
      } else {
        turn.status = "failed";
        turn.error = "서버가 다시 켜지며 답변이 여러 번 중단됐어요. 다시 시도해 주세요.";
        turn.autoRetry = undefined;
      }
      turn.updatedAt = new Date().toISOString();
      changed = true;
    }
  if (changed) {
    p.stage = "서버가 다시 켜져 대화 응답을 자동으로 다시 요청해요";
    markRunningCallsFailed();
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

// Automatic resumes and turn retries are checked at most every 30 seconds.
const SCHEDULE_MS = 30_000;
const unavailableUsage = new Map<string, number>();
let lastSchedule = 0;
async function scheduleAutoResumes() {
  if (Date.now() - lastSchedule < SCHEDULE_MS) return;
  lastSchedule = Date.now();
  try {
    const resumed = await tickAutoResume({
      briefs,
      get,
      save,
      usage: () => getAccountUsage(),
      unavailable: unavailableUsage,
    });
    if (resumed.length) console.log(`[worker] 자동으로 이어서 실행: ${resumed.join(", ")}`);
  } catch (error) {
    console.error("[worker] 자동 재개 확인 중 오류:", error instanceof Error ? error.message : error);
  }
}

while (true) {
  await scheduleAutoResumes();
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
