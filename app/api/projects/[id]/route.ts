import { NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { get, projectVersion } from "@/lib/store";
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
