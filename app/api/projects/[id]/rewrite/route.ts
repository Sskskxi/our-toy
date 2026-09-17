import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { get, save } from "@/lib/store";
import { modelsSchema } from "@/lib/types";
import { queueReportRefresh } from "@/lib/followup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rewrite only the final report of a finished run with the current report
// rules. Research calls are replayed from their saved results, so this costs
// the report call (and an edit call when the draft buries the answer).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  try {
    const p = get((await params).id);
    if (!p) return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    if (p.status !== "complete" || !p.report)
      return NextResponse.json({ error: "완료된 연구의 보고서만 다시 쓸 수 있어요." }, { status: 409 });
    if (p.mode === "live")
      return NextResponse.json({ error: "직접 API 기록은 다시 실행할 수 없습니다." }, { status: 409 });
    if (p.conversation.turns.some((t) => t.status === "running" || t.status === "queued"))
      return NextResponse.json({ error: "후속 대화 답변이 끝난 뒤 다시 쓸 수 있어요." }, { status: 409 });
    const body = await req.json().catch(() => ({}));
    if (body?.models !== undefined) {
      const models = modelsSchema.safeParse(body.models);
      if (!models.success)
        return NextResponse.json({ error: models.error.issues.map((i) => i.message).join(" / ") }, { status: 400 });
      for (const actor of ["GPT", "Claude"] as const)
        if (models.data[actor])
          p.models = { ...p.models, [actor]: { ...p.models?.[actor], ...models.data[actor] } };
    }
    queueReportRefresh(p, "보고서 다시 쓰기 대기");
    save(p);
    return NextResponse.json({ id: p.id, status: p.status }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "보고서를 다시 쓰지 못했어요." }, { status: 400 });
  }
}
