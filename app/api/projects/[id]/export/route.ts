import { NextResponse } from "next/server";
import { rejectUnsafe } from "@/lib/http";
import { get } from "@/lib/store";
import { markdownToDocx } from "@/lib/docx-export";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Word download of the final report. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const unsafe = rejectUnsafe(req, { json: false });
  if (unsafe) return unsafe;
  // A plain link from another site sends no Origin; the browser still marks it.
  if (req.headers.get("sec-fetch-site") === "cross-site")
    return NextResponse.json({ error: "다른 사이트의 요청은 허용되지 않습니다." }, { status: 403 });
  const format = new URL(req.url).searchParams.get("format") ?? "docx";
  if (format !== "docx")
    return NextResponse.json({ error: "지원하는 형식은 docx예요." }, { status: 400 });
  let p;
  try {
    p = get((await params).id);
  } catch {
    return NextResponse.json({ error: "프로젝트를 읽을 수 없습니다." }, { status: 400 });
  }
  if (!p) return NextResponse.json({ error: "프로젝트가 없습니다." }, { status: 404 });
  if (!p.report) return NextResponse.json({ error: "아직 최종 보고서가 없어요." }, { status: 409 });
  const title = (p.title ?? p.topic.split("\n").find((l) => l.trim()) ?? "research")
    .replace(/^[#>\s*-]+/, "")
    .trim()
    .slice(0, 60);
  const body = await markdownToDocx(p.report, title);
  const name = `${title.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim() || "research"}.docx`;
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="research-${p.id}.docx"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
