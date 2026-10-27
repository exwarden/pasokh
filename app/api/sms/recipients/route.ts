import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { contactWhere } from "@/lib/contacts/list";
import { recipientsFor } from "@/lib/sms/campaigns";

export const runtime = "nodejs";

/** How many different numbers a filter reaches, before anything is sent. */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const s = request.nextUrl.searchParams;
  const filter = { accountId: s.get("accountId"), tag: s.get("tag") };
  const [phones, withoutConsent] = await Promise.all([
    recipientsFor(context.workspaceId, filter),
    // People with a number who have not agreed: shown so the owner knows why they are left out.
    prisma.contact.count({
      where: { ...contactWhere({ workspaceId: context.workspaceId, ...filter, hasPhone: true }), smsConsent: false },
    }),
  ]);
  return NextResponse.json({ count: phones.length, withoutConsent });
}
