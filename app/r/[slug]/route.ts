import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRequestIp, hashClickIp } from "@/lib/tracking/server";
import { shouldRecordClick } from "@/lib/tracking/click-limit";
import { isHttpUrl } from "@/lib/utils/http-url";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      destinationUrl: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  // Only web addresses are ever redirected to, whatever an older row holds.
  if (!isHttpUrl(trackedLink.destinationUrl)) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  const ipHash = hashClickIp(getRequestIp(request));
  if (await shouldRecordClick(slug, ipHash)) {
    await prisma.linkClick.create({
      data: {
        workspaceId: trackedLink.workspaceId,
        automationId: trackedLink.automationId,
        instagramAccountId: trackedLink.automation.instagramAccountId,
        trackedLinkId: trackedLink.id,
        ipHash,
        // Sent by the visitor, so cut to a length that cannot bloat the table.
        userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
        referrer: request.headers.get("referer")?.slice(0, 500) ?? null,
      },
    });
  }

  return NextResponse.redirect(trackedLink.destinationUrl, { status: 302 });
}
