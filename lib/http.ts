import { NextResponse } from "next/server";

// The app is a single-user server bound to 127.0.0.1. Browsers can still reach
// it from other sites, so every state-changing route checks three things:
// - Host is loopback: blocks DNS rebinding, where evil.example resolves to
//   127.0.0.1 and Origin and Host then match each other.
// - Origin, when sent, equals Host: blocks ordinary cross-site requests.
// - JSON content type: a cross-site form or no-cors fetch cannot set it
//   without a CORS preflight, which this server never approves.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function isLoopbackHost(host: string | null) {
  return Boolean(host && LOOPBACK.test(host));
}

export function rejectUnsafe(req: Request, { json = true } = {}) {
  const host = req.headers.get("host");
  if (!isLoopbackHost(host))
    return NextResponse.json(
      { error: "로컬 주소(127.0.0.1 또는 localhost)로 접속해야 합니다." },
      { status: 403 },
    );
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost !== host)
      return NextResponse.json(
        { error: "다른 사이트의 요청은 허용되지 않습니다." },
        { status: 403 },
      );
  }
  if (json && !(req.headers.get("content-type") ?? "").includes("application/json"))
    return NextResponse.json({ error: "JSON 요청이 필요합니다." }, { status: 415 });
  return null;
}
