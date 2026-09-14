import { NextResponse } from "next/server";
import { getAccountUsage } from "@/lib/account-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const response = NextResponse.json(await getAccountUsage());
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
