import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { create, list } from "@/lib/store";
import { inputSchema } from "@/lib/types";
import { modelDefaults } from "@/lib/subscription";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const unsafe = rejectUnsafe(req, { json: false });
  if (unsafe) return unsafe;
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
    modelDefaults: modelDefaults(),
  });
}
export async function POST(req: NextRequest) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
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
