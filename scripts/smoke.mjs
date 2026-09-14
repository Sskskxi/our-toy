import assert from "node:assert/strict";
const base = process.env.TEST_URL || "http://127.0.0.1:3000";
const payload = {
  topic: "Smoke test: 도시 녹지 정책의 실증 근거",
  mode: "mock",
  maxRounds: 1,
  noveltyThreshold: 0.12,
};
const post = (data, origin = base) =>
  fetch(base + "/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(data),
  });
assert.equal((await post(payload, "https://foreign.invalid")).status, 403);
assert.equal((await post({ ...payload, maxRounds: 99 })).status, 400);
const created = await post(payload);
assert.equal(created.status, 201);
const project = await created.json();
let result;
for (let i = 0; i < 45; i++) {
  const response = await fetch(base + "/api/projects/" + project.id);
  assert.equal(response.status, 200);
  result = await response.json();
  if (["complete", "failed", "interrupted"].includes(result.status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.equal(result.status, "complete");
assert.equal(result.rounds.length, 1);
assert.ok(result.report.includes("MOCK"));
assert.equal(result.calls.length, 8);
assert.ok(result.unresolved.length > 0);
const listed = await (await fetch(base + "/api/projects")).json();
assert.ok(listed.projects.some((p) => p.id === project.id));
console.log(
  "HTTP smoke passed: origin protection, validation, create, worker, persistence, report. Project: " +
    project.id,
);
