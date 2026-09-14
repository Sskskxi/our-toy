import { NextRequest, NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { get, projectVersion, remove, setTitle } from "@/lib/store";
import { inboxVersion, withPendingInterventions } from "@/lib/interventions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const unsafe = rejectUnsafe(_req, { json: false });
  if (unsafe) return unsafe;
  try {
    const id = (await params).id;
    // Clients poll with the version they already have; skip re-sending a
    // large unchanged project.
    const version = [projectVersion(id), inboxVersion(id)].join(":");
    if (new URL(_req.url).searchParams.get("v") === version)
      return NextResponse.json({ unchanged: true, version });
    const p = get(id);
    return p
      ? NextResponse.json({ ...withPendingInterventions(p), version })
      : NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
  } catch {
    return NextResponse.json(
      { error: "프로젝트를 읽을 수 없습니다." },
      { status: 400 },
    );
  }
}

function isBusy(p: NonNullable<ReturnType<typeof get>>) {
  return (
    p.status === "running" ||
    p.status === "queued" ||
    p.conversation.turns.some((t) => t.status === "running" || t.status === "queued")
  );
}

/** Rename: stored beside the project so it never races the worker's saves. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  try {
    const id = (await params).id;
    const raw = await req.text();
    if (raw.length > 2000)
      return NextResponse.json({ error: "요청이 너무 깁니다." }, { status: 413 });
    const { title } = JSON.parse(raw) as { title?: unknown };
    if (typeof title !== "string" || title.length > 120)
      return NextResponse.json({ error: "제목은 120자 이하 문자열이어야 합니다." }, { status: 400 });
    if (!get(id)) return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    setTitle(id, title.replace(/\s+/g, " "));
    return NextResponse.json({ ok: true, title: title.trim() || undefined });
  } catch {
    return NextResponse.json({ error: "제목을 바꾸지 못했습니다." }, { status: 400 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unsafe = rejectUnsafe(req, { json: false });
  if (unsafe) return unsafe;
  try {
    const id = (await params).id;
    const p = get(id);
    if (!p) return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
    if (isBusy(p))
      return NextResponse.json(
        { error: "진행 중인 연구나 답변이 있습니다. 먼저 중지한 뒤 삭제하세요." },
        { status: 409 },
      );
    remove(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "삭제하지 못했습니다." }, { status: 400 });
  }
}
