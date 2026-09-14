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
    if (p.status !== "complete")
      return NextResponse.json(
        { error: "초기 연구가 완료된 뒤 대화를 시작할 수 있습니다." },
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
