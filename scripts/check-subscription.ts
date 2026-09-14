import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
const { save } = await import("../lib/store");
const { create } = await import("../lib/store");
const { run } = await import("../lib/engine");
const p = create({
  topic:
    "웹 연구 보고서에서 사실과 추론을 구분하고 출처를 검증하는 방법. 공식 문서 1~2개를 확인해 간결히 조사하세요.",
  mode: "subscription",
  maxRounds: 1,
  minRounds: 1,
  noveltyThreshold: 0.12,
});
console.log("Subscription check project: " + p.id);
let last = "";
await run(p, undefined, (state) => {
  save(state);
  if (state.stage !== last) {
    console.log(state.stage);
    last = state.stage;
  }
});
save(p);
console.log(
  JSON.stringify({
    id: p.id,
    status: p.status,
    error: p.error,
    calls: p.calls.map((c) => ({
      actor: c.actor,
      stage: c.stage,
      status: c.status,
      model: c.result?.model,
    })),
    claims: p.claims.length,
    report: !!p.report,
  }),
);
if (p.status !== "complete") process.exitCode = 1;
