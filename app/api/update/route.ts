import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { requestUpdate, updateStatus } from "@/lib/updater";

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
