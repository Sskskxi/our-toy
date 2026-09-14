import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { enqueueMessage } from "@/lib/conversation";
import { get, save } from "@/lib/store";
import { messageSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  try {
    const raw = await req.text();
    if (raw.length > 20000)
      return NextResponse.json({ error: "메시지가 너무 깁니다." }, { status: 413 });
    const input = messageSchema.safeParse(JSON.parse(raw));
    if (!input.success)
      return NextResponse.json(
        { error: input.error.issues.map((issue) => issue.message).join(" / ") },
        { status: 400 },
      );
    const p = get((await params).id);
    if (!p)
      return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    // Follow-ups work on any finished run, including failed or stopped ones
    // with partial results, but never while the research itself is running.
    if (p.status === "running" || p.status === "queued")
      return NextResponse.json(
        { error: "연구가 진행 중입니다. 진행 중에는 토론 탭의 개입 메모를 쓰세요." },
        { status: 409 },
      );
    if (!p.calls.some((c) => c.status === "complete"))
      return NextResponse.json(
        { error: "아직 대화할 연구 결과가 없습니다. 이어서 실행해 주세요." },
        { status: 409 },
      );
    const turn = enqueueMessage(p, input.data);
    save(p);
    return NextResponse.json(turn, { status: 202 });
  } catch {
    return NextResponse.json(
      { error: "메시지를 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}
