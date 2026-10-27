import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { previewSmsCampaign } from "@/lib/sms/campaigns";

export const runtime = "nodejs";

const schema = z.object({
  message: z.string().trim().min(1).max(1000),
  accountId: z.string().min(1).nullable().optional(),
  tag: z.string().min(1).nullable().optional(),
});

/**
 * What a send would do, before anything is stored or sent: how many numbers,
 * a masked sample, the limits, and the one-time token the send requires.
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) return NextResponse.json({ error: "Only owners and admins can change this" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { accountId, tag, message } = parsed.data;
  if (accountId) {
    const account = await prisma.instagramAccount.findFirst({ where: { id: accountId, workspaceId: context.workspaceId }, select: { id: true } });
    if (!account) return NextResponse.json({ error: "Instagram account not found" }, { status: 404 });
  }
  try {
    return NextResponse.json(await previewSmsCampaign({ workspaceId: context.workspaceId, message, filter: { accountId, tag } }));
  } catch (error) {
    if (error instanceof Error && error.message === "Set up an SMS provider first.") return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("[SMS] Preview failed:", error);
    return NextResponse.json({ error: "Could not start the send." }, { status: 500 });
  }
}
