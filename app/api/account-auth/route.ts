import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authStatus,
  cancelLogin,
  logout,
  startLogin,
  submitClaudeCode,
  subscriptionBusy,
} from "@/lib/account-auth";
import { rejectUnsafe } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("login"), provider: z.enum(["codex", "claude"]) }),
  z.object({ action: z.literal("logout"), provider: z.enum(["codex", "claude"]) }),
  z.object({ action: z.literal("cancel"), provider: z.enum(["codex", "claude"]) }),
  z.object({ action: z.literal("code"), provider: z.literal("claude"), code: z.string().trim().min(4).max(2000) }),
]);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(req: Request) {
  const unsafe = rejectUnsafe(req, { json: false });
  if (unsafe) return unsafe;
  return json({ ...authStatus(), locked: subscriptionBusy() });
}

export async function POST(req: Request) {
  const unsafe = rejectUnsafe(req);
  if (unsafe) return unsafe;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "요청 형식이 올바르지 않아요." }, 400);
  const body = parsed.data;
  try {
    if (body.action === "login") await startLogin(body.provider);
    else if (body.action === "cancel") cancelLogin(body.provider);
    else if (body.action === "code") submitClaudeCode(body.code);
    else await logout(body.provider);
    return json({ ...authStatus(), locked: subscriptionBusy() });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "계정 작업을 마치지 못했어요." }, 409);
  }
}
