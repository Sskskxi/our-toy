import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { addIntervention } from "@/lib/interventions";
import { get } from "@/lib/store";
import { interventionSchema } from "@/lib/types";

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
    if (raw.length > 10000)
      return NextResponse.json({ error: "개입 내용이 너무 깁니다." }, { status: 413 });
    const input = interventionSchema.safeParse(JSON.parse(raw));
    if (!input.success)
      return NextResponse.json(
        { error: input.error.issues.map((issue) => issue.message).join(" / ") },
        { status: 400 },
      );
    const id = (await params).id;
    const p = get(id);
    if (!p)
      return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    if (p.status !== "queued" && p.status !== "running")
      return NextResponse.json(
        {
          error:
            p.status === "complete"
              ? "연구가 끝났습니다. 대화 탭에서 이어서 질문하세요."
              : "진행 중인 연구에만 개입할 수 있습니다.",
        },
        { status: 409 },
      );
    return NextResponse.json(addIntervention(id, input.data), { status: 202 });
  } catch (e) {
    const limit = e instanceof Error && e.message.includes("최대");
    return NextResponse.json(
      { error: limit ? (e as Error).message : "개입 내용을 저장하지 못했습니다." },
      { status: limit ? 429 : 400 },
    );
  }
}
