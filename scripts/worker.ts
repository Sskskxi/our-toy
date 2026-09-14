import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
const { dataDir, list, save } = await import("../lib/store");
const { stopSubscriptionCalls } = await import("../lib/subscription");
const { run } = await import("../lib/engine");
const { runConversation } = await import("../lib/conversation");
const fs = await import("node:fs");
const path = await import("node:path");
const lock = path.join(dataDir(), "worker.lock");
try {
  fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
} catch {
  const pid = Number(fs.readFileSync(lock, "utf8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
  }
  if (alive) throw new Error("다른 worker가 실행 중입니다.");
  fs.unlinkSync(lock);
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
    p.stage = "서버 재시작으로 중단";
    p.error =
      "이전 실행이 중단되었습니다. 기존 기록을 확인한 뒤 새 프로젝트로 다시 실행하세요.";
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
console.log("Research worker ready (one local worker, persistent queue)");
while (true) {
  const projects = list();
  const next = [...projects]
    .reverse()
    .find((p) => p.status === "queued");
  if (next) await run(next);
  else {
    const queuedTurn = projects
      .flatMap((project) =>
        (project.conversation?.turns ?? [])
          .filter((turn) => turn.status === "queued")
          .map((turn) => ({ project, turn })),
      )
      .sort((a, b) => a.turn.createdAt.localeCompare(b.turn.createdAt))[0];
    if (queuedTurn)
      await runConversation(queuedTurn.project, queuedTurn.turn.id);
    else await new Promise((r) => setTimeout(r, 700));
  }
}
