import type { Claim, Evidence } from "./types";
import type { FetchedSource } from "./fetch-source";

// Checks each cited source against its real text: do the claim's checkable
// anchors (numbers, article numbers, standard IDs, names) and the excerpt's
// words actually appear there? This catches invented or misattributed
// citations without trusting the model's own summary of the page.

export type SourceCheck = {
  status: "match" | "partial" | "mismatch" | "unreachable" | "skipped";
  checkedAt: string;
  note: string;
};
export type Grade = 1 | 2 | 3;
export type CheckedEvidence = Evidence & { check?: SourceCheck; grade?: Grade };
export type CheckedClaim = Omit<Claim, "sources"> & { sources: CheckedEvidence[]; grade?: Grade };

const ANCHOR_PATTERNS = [
  /제\s?\d+\s?조(?:의\s?\d+)?(?:\s?제\s?\d+\s?항)?/g,
  /\bRFC\s?\d{3,5}\b/gi,
  /\bISO(?:\/IEC)?\s?\d{3,5}(?:-\d+)?\b/gi,
  /\bNIST\s?(?:SP\s?)?\d{3}(?:-\d+[A-Za-z]?)?\b/gi,
  /\bCVE-\d{4}-\d{4,}\b/gi,
  /\b(?:19|20)\d{2}\b/g,
  /\d[\d,.]*\s?%/g,
  /\b\d{2,}(?:[.,]\d+)?\b/g,
  /\b[A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*\b/g, // acronyms and CamelCase names
];

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export function extractAnchors(text: string) {
  const found = new Set<string>();
  for (const pattern of ANCHOR_PATTERNS)
    for (const m of text.matchAll(pattern)) {
      const v = squash(m[0]).replace(/[.,]$/, "");
      if (v.length >= 2) found.add(v);
    }
  // "8693" and "rfc" are parts of "rfc8693"; count each anchor once.
  const all = [...found];
  return all.filter((a) => !all.some((b) => b !== a && b.includes(a)));
}

function words(text: string) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 2),
    ),
  ];
}

export function judgeCitation(
  sourceText: string,
  claim: string,
  excerpt = "",
): { status: "match" | "partial" | "mismatch"; note: string; score: number } {
  const hay = sourceText.toLowerCase();
  const hayTight = squash(sourceText);
  const anchors = extractAnchors(`${claim} ${excerpt}`);
  const anchorHits = anchors.filter((a) => hayTight.includes(a));
  const terms = words(excerpt || claim);
  const termHits = terms.filter((w) => hay.includes(w));
  const anchorRatio = anchors.length ? anchorHits.length / anchors.length : undefined;
  const termRatio = terms.length ? termHits.length / terms.length : 0;
  const score = anchorRatio === undefined ? termRatio : 0.6 * anchorRatio + 0.4 * termRatio;
  const missing = anchors.filter((a) => !anchorHits.includes(a)).slice(0, 3);
  const note =
    anchorRatio === undefined
      ? `핵심어 ${termHits.length}/${terms.length}개가 원문에 있어요`
      : `근거 표지 ${anchorHits.length}/${anchors.length}개, 핵심어 ${termHits.length}/${terms.length}개가 원문에 있어요${missing.length ? ` · 원문에 없음: ${missing.join(", ")}` : ""}`;
  if (score >= 0.7) return { status: "match", note, score };
  if (score >= 0.35) return { status: "partial", note, score };
  return { status: "mismatch", note, score };
}

/** 1 = primary (law, government, standards, scholarly), 2 = institutional or docs, 3 = other. */
export function gradeSource(url: string, title = ""): Grade {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 3;
  }
  const primary = [
    /(^|\.)go\.kr$/,
    /(^|\.)gov(\.[a-z]{2})?$/,
    /(^|\.)europa\.eu$/,
    /(^|\.)(legislation\.gov\.uk|federalregister\.gov|ecfr\.gov)$/,
    /(^|\.)(rfc-editor\.org|ietf\.org|iso\.org|w3\.org|etsi\.org|itu\.int)$/,
    /(^|\.)(doi\.org|arxiv\.org|acm\.org|ieee\.org|springer\.com|sciencedirect\.com|nature\.com|usenix\.org|jstor\.org)$/,
  ];
  if (primary.some((re) => re.test(host))) return 1;
  if (
    // University sites are mostly notices and reposts (a department board
    // reposting a contest notice outranked the organiser's own page).
    /(^|\.)(or\.kr|re\.kr|ac\.kr|edu|org|int)$/.test(host) ||
    /^(docs|developer|developers|learn|support)\./.test(host) ||
    /(보고서|백서|white ?paper|report|guideline|가이드라인)/i.test(title)
  )
    return 2;
  return 3;
}

export type Fetcher = (url: string) => Promise<FetchedSource>;
export type Confirm = (input: {
  claim: string;
  excerpt: string;
  passage: string;
}) => Promise<"match" | "mismatch" | undefined>;

/** Text around the first anchor or word found, for a short model confirmation. */
export function passageFor(sourceText: string, claim: string, excerpt = "", radius = 1500) {
  const lower = sourceText.toLowerCase();
  const probe = [...extractAnchors(`${claim} ${excerpt}`), ...words(excerpt || claim)].find((w) =>
    lower.includes(w),
  );
  const at = probe ? lower.indexOf(probe) : 0;
  return sourceText.slice(Math.max(0, at - radius), at + radius);
}

export async function checkEvidence(
  claim: Pick<Claim, "statement">,
  source: CheckedEvidence,
  fetcher: Fetcher,
  confirm?: Confirm,
): Promise<SourceCheck> {
  const checkedAt = new Date().toISOString();
  if (source.provenance === "mock")
    return { status: "skipped", checkedAt, note: "합성 예시라 확인하지 않았어요" };
  const page = await fetcher(source.url);
  if (page.status === "pdf")
    return { status: "skipped", checkedAt, note: "PDF 원문은 자동으로 대조하지 않았어요" };
  if (page.status !== "ok")
    return {
      status: page.status === "blocked" || page.status === "unsupported" ? "skipped" : "unreachable",
      checkedAt,
      note: page.note,
    };
  const judged = judgeCitation(page.text, claim.statement, source.excerpt);
  if (judged.status === "partial" && confirm) {
    const verdict = await confirm({
      claim: claim.statement,
      excerpt: source.excerpt,
      passage: passageFor(page.text, claim.statement, source.excerpt),
    }).catch(() => undefined);
    if (verdict)
      return {
        status: verdict,
        checkedAt,
        note: `${judged.note} · 모델 대조: ${verdict === "match" ? "뒷받침해요" : "뒷받침하지 않아요"}`,
      };
  }
  return { status: judged.status, checkedAt, note: judged.note };
}

/** Check sources without a result yet, a few at a time, then grade every claim. */
export async function verifyClaims(
  claims: CheckedClaim[],
  fetcher: Fetcher,
  {
    confirm,
    concurrency = 4,
    maxChecks = 24,
  }: { confirm?: Confirm; concurrency?: number; maxChecks?: number } = {},
) {
  const queue = claims
    .flatMap((claim) => claim.sources.map((source) => ({ claim, source })))
    .filter(({ source }) => !source.check)
    .slice(0, maxChecks);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (next < queue.length) {
        const item = queue[next++];
        try {
          item.source.check = await checkEvidence(item.claim, item.source, fetcher, confirm);
        } catch {
          item.source.check = {
            status: "unreachable",
            checkedAt: new Date().toISOString(),
            note: "확인 중 오류가 났어요",
          };
        }
      }
    }),
  );
  for (const claim of claims) {
    for (const source of claim.sources) source.grade = gradeSource(source.url, source.title);
    claim.grade = claim.sources.length
      ? (Math.min(...claim.sources.map((s) => s.grade ?? 3)) as Grade)
      : undefined;
  }
  return queue.length;
}
