import { NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { get } from "@/lib/store";
import { withPendingInterventions } from "@/lib/interventions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const unsafe = rejectUnsafe(_req, { json: false });
  if (unsafe) return unsafe;
  try {
    const p = get((await params).id);
    return p
      ? NextResponse.json(withPendingInterventions(p))
      : NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
  } catch {
    return NextResponse.json(
      { error: "프로젝트를 읽을 수 없습니다." },
      { status: 400 },
    );
  }
}
