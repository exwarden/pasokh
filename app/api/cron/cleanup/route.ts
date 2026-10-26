import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/net/cron-auth";
import { runRetention } from "@/lib/ops/retention";

/** Deletes webhook payloads, DM logs, events and AI replies past their retention period. */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ success: true, data: { deleted: await runRetention() } });
}
