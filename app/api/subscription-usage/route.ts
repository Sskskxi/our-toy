import { NextResponse } from "next/server";
import { getAccountUsage } from "@/lib/account-usage";
import { rejectUnsafe } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unsafe = rejectUnsafe(req, { json: false });
  if (unsafe) return unsafe;
  const response = NextResponse.json(await getAccountUsage());
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
