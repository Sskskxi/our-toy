import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { briefs, create } from "@/lib/store";
import { workerAlive } from "@/lib/control";
import { inputSchema } from "@/lib/types";
import { modelDefaults, resolveModel } from "@/lib/subscription";
import { serverBuild } from "@/lib/updater";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const unsafe = rejectUnsafe(req, { json: false });
  if (unsafe) return unsafe;
  return NextResponse.json({
    // Polled every few seconds, so open tabs notice a restart on a new build quickly.
    build: serverBuild(),
    workerAlive: workerAlive(),
    projects: briefs().map(({ id, topic, title, status, mode, createdAt, updatedAt, stage, queuedTurnAt, turnActive, autoResumeAt }) => ({
      id,
      topic,
      title,
      updatedAt,
      status,
      mode,
      createdAt,
      stage,
      autoResumeAt,
      busy: status === "running" || status === "queued" || Boolean(queuedTurnAt) || turnActive,
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
    // Record the models actually used, so later .env changes do not
    // silently change what an existing project shows or resumes with.
    const input = parsed.data;
    if (input.mode === "subscription") {
      const models = { ...input.models };
      for (const actor of ["GPT", "Claude"] as const)
        models[actor] = resolveModel({ actor, ...input.models?.[actor] }) as typeof models.GPT;
      input.models = models;
    }
    return NextResponse.json(create(input), { status: 201 });
  } catch {
    return NextResponse.json(
      {
        error: "프로젝트를 생성하지 못했습니다. 입력과 저장 경로를 확인하세요.",
      },
      { status: 400 },
    );
  }
}
