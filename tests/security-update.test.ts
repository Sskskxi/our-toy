import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "update-tests-"));
const { rejectUnsafe, isLoopbackHost } = await import("../lib/http");
const { updateStatus, requestUpdate } = await import("../lib/updater");

const req = (headers: Record<string, string>) =>
  new Request("http://127.0.0.1:3000/api/x", { method: "POST", headers });

test("state-changing requests must come from this local app", async () => {
  const json = { "content-type": "application/json" };
  assert.equal(rejectUnsafe(req({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", ...json })), null);
  assert.equal(rejectUnsafe(req({ host: "localhost:3000", ...json })), null);
  // DNS rebinding: attacker domain resolving to 127.0.0.1, Origin matches Host.
  assert.equal(
    rejectUnsafe(req({ host: "evil.example:3000", origin: "http://evil.example:3000", ...json }))?.status,
    403,
  );
  assert.equal(
    rejectUnsafe(req({ host: "127.0.0.1:3000", origin: "http://evil.example", ...json }))?.status,
    403,
  );
  assert.equal(rejectUnsafe(req({ host: "127.0.0.1:3000", origin: "null", ...json }))?.status, 403);
  // Cross-site forms cannot send JSON without a preflight.
  assert.equal(
    rejectUnsafe(req({ host: "127.0.0.1:3000", "content-type": "text/plain" }))?.status,
    415,
  );
  assert.equal(rejectUnsafe(req({ host: "127.0.0.1:3000" }), { json: false }), null);
  assert.equal(isLoopbackHost("127.0.0.1.evil.example"), false);
  assert.equal(isLoopbackHost("localhost.evil.example:3000"), false);
});

test("update check reports new upstream commits and refuses unsafe states", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-git-"));
  const g = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const remote = path.join(root, "remote.git"),
    app = path.join(root, "app"),
    other = path.join(root, "other");
  g(root, "init", "--bare", "-b", "main", remote);
  g(root, "clone", "-q", remote, app);
  for (const dir of [app]) {
    g(dir, "config", "user.email", "t@example.com");
    g(dir, "config", "user.name", "t");
  }
  fs.writeFileSync(path.join(app, "a.txt"), "1");
  g(app, "add", ".");
  g(app, "commit", "-qm", "first");
  g(app, "push", "-q", "-u", "origin", "main");
  g(root, "clone", "-q", remote, other);
  g(other, "config", "user.email", "t@example.com");
  g(other, "config", "user.name", "t");
  fs.writeFileSync(path.join(other, "a.txt"), "2");
  g(other, "commit", "-qam", "새 기능 추가");
  g(other, "push", "-q");

  const cwd = process.cwd();
  process.chdir(app);
  try {
    const status = await updateStatus({ refresh: true });
    assert.equal(status.supported, true);
    assert.equal(status.upstream, "origin/main");
    assert.equal(status.behind, 1);
    assert.equal(status.commits[0].subject, "새 기능 추가");
    assert.equal(status.canUpdate, true);

    fs.writeFileSync(path.join(app, "a.txt"), "local edit");
    const dirty = await updateStatus();
    assert.equal(dirty.canUpdate, false);
    assert.match(dirty.reason!, /커밋하지 않은 변경/);
    await assert.rejects(requestUpdate(), /커밋하지 않은 변경/);
    g(app, "checkout", "--", "a.txt");

    await requestUpdate();
    assert.ok(fs.existsSync(path.join(process.env.DATA_DIR!, ".update-request.json")));
    // A second click while one is pending is refused.
    await assert.rejects(requestUpdate(), /적용하는 중/);
  } finally {
    process.chdir(cwd);
  }
});

test("folders without git report unsupported instead of failing", async () => {
  const cwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "nogit-")));
  try {
    const status = await updateStatus();
    assert.equal(status.supported, false);
    assert.equal(status.canUpdate, false);
  } finally {
    process.chdir(cwd);
  }
});
