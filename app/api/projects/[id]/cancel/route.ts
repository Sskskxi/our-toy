import { NextRequest, NextResponse } from "next/server";
import { requestCancel } from "@/lib/control";
import { rejectUnsafe } from "@/lib/http";
import { get } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ask the worker to stop the research or follow-up answer running for this
// project. Completed steps stay saved and can be resumed.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  try {
    const id = (await params).id;
    const p = get(id);
    if (!p) return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    const busyTurn = p.conversation.turns.some(
      (t) => t.status === "running" || t.status === "queued",
    );
    if (p.status !== "running" && p.status !== "queued" && !busyTurn)
      return NextResponse.json({ error: "진행 중인 작업이 없습니다." }, { status: 409 });
    requestCancel(id);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "중지 요청을 보내지 못했습니다." }, { status: 400 });
  }
}
