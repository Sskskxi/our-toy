import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { get, save } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Turn off the automatic resume scheduled for a failed run. The run stays
// failed and can still be resumed by hand.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unsafe = rejectUnsafe(req, { json: false });
  if (unsafe) return unsafe;
  try {
    const p = get((await params).id);
    if (!p)
      return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    if (p.autoResume) {
      p.autoResume = undefined;
      if (p.status === "failed") p.stage = "오류로 중단 · 이어서 실행 가능";
      save(p);
    }
    return NextResponse.json({ id: p.id, status: p.status, autoResume: null });
  } catch {
    return NextResponse.json({ error: "자동 재개를 끄지 못했어요." }, { status: 400 });
  }
}
