import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { get, save } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Requeue a failed or interrupted run. The worker replays completed calls and
// continues from the first step that has no saved result.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  try {
    const p = get((await params).id);
    if (!p)
      return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    if (p.status !== "failed" && p.status !== "interrupted")
      return NextResponse.json(
        { error: "오류로 멈춘 연구만 이어서 실행할 수 있습니다." },
        { status: 409 },
      );
    if (p.conversation.turns.some((t) => t.status === "running" || t.status === "queued"))
      return NextResponse.json(
        { error: "후속 대화 답변이 끝난 뒤 이어서 실행할 수 있습니다." },
        { status: 409 },
      );
    if (p.mode === "live")
      return NextResponse.json(
        { error: "직접 API 기록은 다시 실행할 수 없습니다." },
        { status: 409 },
      );
    p.status = "queued";
    p.stage = "이어서 실행 대기";
    p.error = undefined;
    save(p);
    return NextResponse.json({ id: p.id, status: p.status }, { status: 202 });
  } catch {
    return NextResponse.json(
      { error: "이어서 실행하지 못했습니다." },
      { status: 400 },
    );
  }
}
