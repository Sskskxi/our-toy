import dns from "node:dns/promises";
import net from "node:net";

// Fetches pages that models cited, so the worker can check quotes against the
// real text. This is a server-side request driven by model output, so it is
// locked down against SSRF: public http(s) only, every hop re-checked.
export type FetchedSource =
  | { status: "ok"; text: string; contentType: string; finalUrl: string }
  | { status: "pdf"; finalUrl: string }
  | { status: "blocked" | "unreachable" | "unsupported" | "too-large"; note: string };

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

export type FetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  lookup?: Lookup;
  fetchImpl?: typeof fetch;
};

const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true, verbatim: true });

/** Loopback, private, link-local, CGNAT, benchmark, multicast, unspecified and IPv6 equivalents. */
export function isPrivateAddress(address: string) {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  }
  return true;
}

async function checkUrl(raw: string, lookup: Lookup): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "올바른 URL이 아니에요";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "http(s) 주소만 확인해요";
  if (url.username || url.password) return "계정 정보가 들어간 주소는 확인하지 않아요";
  if (url.port && !["80", "443"].includes(url.port)) return "기본 포트가 아닌 주소는 확인하지 않아요";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
    return "내부 주소는 확인하지 않아요";
  let addresses: { address: string }[];
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await lookup(host);
  } catch {
    return null; // DNS failure ends up as "unreachable" in the fetch below.
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address)))
    return "내부·사설 네트워크 주소는 확인하지 않아요";
  return null;
}

export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export async function fetchSource(raw: string, options: FetchOptions = {}): Promise<FetchedSource> {
  const {
    timeoutMs = 8000,
    maxBytes = 1_500_000,
    maxRedirects = 3,
    lookup = defaultLookup,
    fetchImpl = fetch,
  } = options;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Re-checked on every hop so a public page cannot redirect into the LAN.
    const blocked = await checkUrl(current, lookup);
    if (blocked) return { status: "blocked", note: blocked };
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": "our-toy-citation-check/1.0",
          accept: "text/html,text/plain,application/pdf",
        },
      });
    } catch {
      return { status: "unreachable", note: "연결하지 못했거나 시간이 초과됐어요" };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { status: "unreachable", note: `리다이렉트 주소가 없어요 (${res.status})` };
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) return { status: "unreachable", note: `HTTP ${res.status}` };
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("application/pdf")) {
      res.body?.cancel().catch(() => {});
      return { status: "pdf", finalUrl: current };
    }
    if (!type.includes("text/html") && !type.includes("text/plain") && !type.includes("xhtml")) {
      res.body?.cancel().catch(() => {});
      return { status: "unsupported", note: `확인하지 않는 형식이에요 (${type || "알 수 없음"})` };
    }
    if (Number(res.headers.get("content-length")) > maxBytes) {
      res.body?.cancel().catch(() => {});
      return { status: "too-large", note: "원문이 너무 커요" };
    }
    const reader = res.body?.getReader();
    if (!reader) return { status: "unreachable", note: "본문이 없어요" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return { status: "unreachable", note: "본문을 읽는 중 끊겼어요" };
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        reader.cancel().catch(() => {});
        return { status: "too-large", note: "원문이 너무 커요" };
      }
      chunks.push(chunk.value);
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    return {
      status: "ok",
      text: type.includes("html") ? htmlToText(body) : body,
      contentType: type,
      finalUrl: current,
    };
  }
  return { status: "unreachable", note: "리다이렉트가 너무 많아요" };
}
