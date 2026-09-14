import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { get, save } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; turnId: string }> },
) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  try {
    const { id, turnId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(turnId)) throw new Error("invalid turn");
    const p = get(id);
    if (!p)
      return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    const turn = p.conversation.turns.find((item) => item.id === turnId);
    if (!turn)
      return NextResponse.json({ error: "대화가 없습니다." }, { status: 404 });
    if (turn.status !== "failed")
      return NextResponse.json(
        { error: "오류가 난 답변만 다시 시도할 수 있습니다." },
        { status: 409 },
      );
    turn.status = "queued";
    turn.error = undefined;
    // A manual retry starts a fresh automatic-retry budget.
    turn.autoRetry = undefined;
    turn.updatedAt = new Date().toISOString();
    save(p);
    return NextResponse.json(turn, { status: 202 });
  } catch {
    return NextResponse.json({ error: "재시도 요청이 올바르지 않습니다." }, { status: 400 });
  }
}
