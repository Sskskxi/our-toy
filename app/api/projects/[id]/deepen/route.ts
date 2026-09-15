import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { get, save } from "@/lib/store";
import { modelsSchema } from "@/lib/types";
import { startFollowUp } from "@/lib/followup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Follow-up research: reopen a finished run for a question asked after its
// report. Saved calls replay; only the new rounds and the report run live.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  try {
    const p = get((await params).id);
    if (!p) return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body.question !== "string")
      return NextResponse.json({ error: "후속 질문을 입력해 주세요." }, { status: 400 });
    if (body.rounds !== undefined && typeof body.rounds !== "number")
      return NextResponse.json({ error: "추가 라운드는 숫자로 보내 주세요." }, { status: 400 });
    if (body.models !== undefined) {
      const models = modelsSchema.safeParse(body.models);
      if (!models.success)
        return NextResponse.json({ error: models.error.issues.map((i) => i.message).join(" / ") }, { status: 400 });
      for (const actor of ["GPT", "Claude"] as const)
        if (models.data[actor])
          p.models = { ...p.models, [actor]: { ...p.models?.[actor], ...models.data[actor] } };
    }
    const problem = startFollowUp(p, { question: body.question, rounds: body.rounds });
    if (problem) {
      const conflict = /보고서가 나온|직접 API|답변이 끝난/.test(problem);
      return NextResponse.json({ error: problem }, { status: conflict ? 409 : 400 });
    }
    save(p);
    return NextResponse.json({ id: p.id, status: p.status, followUp: p.followUps!.at(-1) }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "후속 심층 조사를 시작하지 못했어요." }, { status: 400 });
  }
}
