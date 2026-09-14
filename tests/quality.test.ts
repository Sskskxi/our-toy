import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchSource, htmlToText, isPrivateAddress } from "../lib/fetch-source";
import { checkEvidence, extractAnchors, gradeSource, judgeCitation, verifyClaims, type CheckedClaim } from "../lib/verify";
import { collectStats, estimateRun } from "../lib/estimate";
import type { Project } from "../lib/types";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("private, loopback and link-local addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.2.3.4", "172.20.1.1", "192.168.0.8", "169.254.169.254", "100.100.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("SSRF: blocked schemes, ports, credentials and private hosts never get fetched", async () => {
  let fetched = 0;
  const fetchImpl = (async () => { fetched++; return new Response("x"); }) as typeof fetch;
  for (const url of ["file:///etc/passwd", "ftp://example.com/a", "http://user:pw@example.com/", "http://example.com:8080/", "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data"]) {
    const r = await fetchSource(url, { fetchImpl, lookup: publicLookup });
    assert.equal(r.status, "blocked", url);
  }
  const r = await fetchSource("https://rebind.example/", { fetchImpl, lookup: async () => [{ address: "10.0.0.5", family: 4 }] });
  assert.equal(r.status, "blocked");
  assert.equal(fetched, 0);
});

test("SSRF: a redirect into a private address is re-checked and blocked", async () => {
  const fetchImpl = (async (url: string) =>
    String(url).includes("public.example")
      ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:80/admin" } })
      : new Response("secret", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  const r = await fetchSource("https://public.example/page", { fetchImpl, lookup: publicLookup });
  assert.equal(r.status, "blocked");
});

test("size limit, content types and html extraction", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/big") { res.writeHead(200, { "content-type": "text/html" }); res.end("a".repeat(5000)); }
    else if (req.url === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF"); }
    else if (req.url === "/img") { res.writeHead(200, { "content-type": "image/png" }); res.end("x"); }
    else { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<html><script>x()</script><p>개인정보 보호법 제26조&nbsp;위탁</p></html>"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  // The test server is on loopback, so route requests to it through a fake public lookup + fetch.
  const fetchImpl = ((url: string, init: RequestInit) => fetch(String(url).replace("https://site.example", `http://127.0.0.1:${port}`), init)) as typeof fetch;
  const opts = { fetchImpl, lookup: publicLookup, maxBytes: 1000 };
  try {
    assert.equal((await fetchSource("https://site.example/big", opts)).status, "too-large");
    assert.equal((await fetchSource("https://site.example/pdf", opts)).status, "pdf");
    assert.equal((await fetchSource("https://site.example/img", opts)).status, "unsupported");
    const ok = await fetchSource("https://site.example/law", opts);
    assert.equal(ok.status, "ok");
    assert.equal(ok.status === "ok" && ok.text, "개인정보 보호법 제26조 위탁");
  } finally {
    server.close();
  }
  assert.equal(htmlToText("<style>a{}</style><b>A&amp;B</b>"), "A&B");
});

test("citation judgement uses anchors like article numbers, standards and figures", () => {
  assert.deepEqual(extractAnchors("RFC 8693과 개인정보 보호법 제26조 제5항, 2026년 37%").sort(), ["2026", "37%", "rfc8693", "제26조제5항"].sort());
  const page = "개인정보 보호법 제26조 제5항은 수탁자가 위탁받은 업무 범위를 초과하여 개인정보를 이용해서는 안 된다고 규정한다. OAuth Token Exchange는 RFC 8693에 정의되어 있다.";
  assert.equal(judgeCitation(page, "개인정보 보호법 제26조 제5항은 수탁자의 목적 외 이용을 금지한다", "위탁받은 업무 범위를 초과하여 이용 금지").status, "match");
  assert.equal(judgeCitation(page, "RFC 9396은 authorization_details 비교가 없다고 명시한다", "RFC 9396 비교 규칙 없음").status, "mismatch");
});

test("sources are graded primary, institutional or other", () => {
  assert.equal(gradeSource("https://www.law.go.kr/법령/개인정보보호법"), 1);
  assert.equal(gradeSource("https://www.rfc-editor.org/rfc/rfc8693"), 1);
  assert.equal(gradeSource("https://arxiv.org/abs/2512.11147"), 1);
  assert.equal(gradeSource("https://learn.microsoft.com/azure/agents"), 2);
  assert.equal(gradeSource("https://www.kisa.or.kr/report"), 2);
  assert.equal(gradeSource("https://someblog.tistory.com/12"), 3);
  assert.equal(gradeSource("not a url"), 3);
});

test("verification marks checks, skips mock sources, asks the model only for partial matches", async () => {
  const claims: CheckedClaim[] = [
    { id: "C-1", statement: "RFC 8693은 토큰 교환을 정의한다", confidence: 0.9, actors: ["GPT"], rounds: [1], status: "source-linked", objections: [], sources: [
      { url: "https://www.rfc-editor.org/rfc/rfc8693", title: "RFC 8693", excerpt: "OAuth 2.0 Token Exchange", provenance: "provider-cited" },
      { url: "https://down.example/x", title: "down", excerpt: "", provenance: "unverified" },
    ] },
    { id: "C-2", statement: "합성", confidence: 0.5, actors: ["Claude"], rounds: [1], status: "needs-evidence", objections: [], sources: [
      { url: "https://example.com/mock", title: "mock", excerpt: "", provenance: "mock" },
    ] },
  ];
  let confirms = 0;
  const fetcher = async (url: string) =>
    url.includes("down") ? ({ status: "unreachable", note: "HTTP 404" } as const) : ({ status: "ok", text: "RFC 8693 OAuth 2.0 Token Exchange 토큰 교환", contentType: "text/html", finalUrl: url } as const);
  const n = await verifyClaims(claims, fetcher, { confirm: async () => { confirms++; return "match"; } });
  assert.equal(n, 3);
  assert.equal(claims[0].sources[0].check?.status, "match");
  assert.equal(claims[0].sources[1].check?.status, "unreachable");
  assert.equal(claims[1].sources[0].check?.status, "skipped");
  assert.equal(claims[0].grade, 1);
  assert.equal(confirms, 0);
  // Already-checked sources are not fetched again.
  assert.equal(await verifyClaims(claims, fetcher), 0);
  const partial = await checkEvidence({ statement: "RFC 8693은 2019년 토큰 교환 표준 위임 체인 규칙 감사 로그" }, { url: "https://x.example", title: "", excerpt: "", provenance: "unverified" }, fetcher, async () => "mismatch");
  assert.equal(partial.status, "mismatch");
  assert.match(partial.note, /모델 대조/);
});

test("estimate learns from past live calls and scales defaults by effort", () => {
  const call = (stage: string, sec: number, tokens: number) => ({ actor: "Claude", stage, round: 1, status: "complete", startedAt: "2026-09-14T00:00:00.000Z", finishedAt: new Date(Date.parse("2026-09-14T00:00:00.000Z") + sec * 1000).toISOString(), result: { tokens, answer: {}, observedUrls: [], model: "m" } });
  const projects = [{ mode: "subscription", models: { Claude: { effort: "max" } }, calls: [call("draft", 1744, 169000), call("draft", 1000, 100000), { ...call("revise", 600, 1), status: "failed" }] }] as unknown as Project[];
  const stats = collectStats(projects);
  assert.equal(stats.get("draft|max")?.n, 2);
  assert.equal(stats.has("revise|max"), false, "failed calls are not learned from");
  const deep = estimateRun({ strategy: "codraft", minRounds: 1, maxRounds: 4, models: { Claude: { effort: "max" } } }, stats);
  const fast = estimateRun({ strategy: "codraft", minRounds: 1, maxRounds: 4 }, stats);
  assert.ok(deep.basedOn >= 2);
  assert.ok(deep.minutes[1] > fast.minutes[1]);
  assert.deepEqual(fast.calls, [8, 14]);
  const capped = estimateRun({ strategy: "codraft", minRounds: 1, maxRounds: 4, models: { Claude: { effort: "max" } }, effortFor: (stage, e) => (stage === "revise" && e === "max" ? "high" : e) }, stats);
  assert.ok(capped.minutes[1] < deep.minutes[1], "capping revise effort lowers the estimate");
});
