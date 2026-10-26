import { prisma } from "@/lib/db/client";

/**
 * Writes an operational event (shown in diagnostics). Never throws: reporting
 * a problem must not become a second problem. Give `instagramId` instead of
 * `workspaceId` when only the Instagram account is known.
 */
export async function recordEvent({
  workspaceId,
  instagramId,
  source = "WORKER",
  level,
  message,
  payload,
}: {
  workspaceId?: string | null;
  instagramId?: string;
  source?: "WORKER" | "SYSTEM";
  level: "INFO" | "WARNING" | "ERROR";
  message: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    let workspace = workspaceId ?? null;
    if (!workspace && instagramId) {
      workspace = (await prisma.instagramAccount.findUnique({ where: { instagramId }, select: { workspaceId: true } }))?.workspaceId ?? null;
    }
    await prisma.operationalEvent.create({
      data: { workspaceId: workspace, source, level, message, ...(payload ? { payload: payload as never } : {}) },
    });
  } catch {
    // see above
  }
}
