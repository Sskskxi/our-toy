import { NextRequest, NextResponse } from "next/server";
import { create, list } from "@/lib/store";
import { inputSchema } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json({
    projects: list().map(({ id, topic, status, mode, createdAt, stage }) => ({
      id,
      topic,
      status,
      mode,
      createdAt,
      stage,
    })),
    defaultMode: process.env.RESEARCH_MODE === "mock" ? "mock" : "subscription",
    liveReady: true,
  });
}
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host"))
    return NextResponse.json(
      { error: "다른 사이트의 요청은 허용되지 않습니다." },
      { status: 403 },
    );
  if (!(req.headers.get("content-type") ?? "").includes("application/json"))
    return NextResponse.json(
      { error: "JSON 요청이 필요합니다." },
      { status: 415 },
    );
  try {
    const text = await req.text();
    if (text.length > 400000)
      return NextResponse.json(
        { error: "입력이 너무 깁니다." },
        { status: 413 },
      );
    const parsed = inputSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      return NextResponse.json(
        {
          error:
            parsed.error.issues.map(i => i.message).join(" / "),
        },
        { status: 400 },
      );
    return NextResponse.json(create(parsed.data), { status: 201 });
  } catch {
    return NextResponse.json(
      {
        error: "프로젝트를 생성하지 못했습니다. 입력과 저장 경로를 확인하세요.",
      },
      { status: 400 },
    );
  }
}
