import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { requestUpdate, setAutoUpdate, updateStatus } from "@/lib/updater";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const unsafe = rejectUnsafe(req, { json: false });
  if (unsafe) return unsafe;
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  try {
    return NextResponse.json(await updateStatus({ refresh }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "업데이트 상태를 확인하지 못했습니다." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  try {
    return NextResponse.json(await requestUpdate(), { status: 202 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "업데이트를 요청하지 못했습니다." },
      { status: 409 },
    );
  }
}

// Turn automatic updates on or off. The launcher polls this setting.
export async function PUT(req: NextRequest) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  const body = await req.json().catch(() => null);
  if (typeof body?.auto !== "boolean")
    return NextResponse.json({ error: "auto 값(true/false)이 필요해요." }, { status: 400 });
  setAutoUpdate(body.auto);
  return NextResponse.json(await updateStatus(), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
