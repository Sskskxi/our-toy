// Manual quality check over saved research: how concrete the claims are and
// how many citations held up. Compare the table before and after a prompt
// change. Read-only; never runs models.
//   npm run eval:quality            # latest 10 finished real runs
//   npm run eval:quality -- 30 all  # latest 30, mock runs included
import { list } from "../lib/store";
import { extractAnchors } from "../lib/verify";

const limit = Number(process.argv[2] ?? 10);
const includeMock = process.argv[3] === "all";
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "-");

const rows = list()
  .filter((p) => p.status === "complete" && (includeMock || p.mode !== "mock"))
  .slice(0, limit)
  .map((p) => {
    const sources = p.claims.flatMap((c) => c.sources);
    const checked = sources.filter((s) => s.check && s.check.status !== "skipped");
    return {
      날짜: p.createdAt.slice(0, 10),
      방식: p.strategy ?? "debate",
      주제: (p.title ?? p.topic.split("\n")[0]).slice(0, 24),
      주장: p.claims.length,
      "구체적 주장": pct(p.claims.filter((c) => extractAnchors(c.statement).length).length, p.claims.length),
      "근거 있는 주장": pct(p.claims.filter((c) => c.sources.length).length, p.claims.length),
      "원문 일치": pct(checked.filter((s) => s.check!.status === "match").length, checked.length),
      "원문 불일치": pct(checked.filter((s) => s.check!.status === "mismatch").length, checked.length),
      "1차 자료": pct(sources.filter((s) => s.grade === 1).length, sources.length),
      모순: p.contradictions?.length ?? "-",
      토큰: p.tokens,
    };
  });

if (!rows.length) console.log("비교할 완료된 연구가 없어요. 'all'을 붙이면 mock 실행도 포함해요.");
else console.table(rows);
