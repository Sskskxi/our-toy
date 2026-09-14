import { NextResponse } from "next/server";
import { get } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const p = get((await params).id);
    return p
      ? NextResponse.json(p)
      : NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
  } catch {
    return NextResponse.json(
      { error: "프로젝트를 읽을 수 없습니다." },
      { status: 400 },
    );
  }
}
