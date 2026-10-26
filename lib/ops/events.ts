import { prisma } from "@/lib/db/client";

/**
 * Same kind of event within this many minutes counts as one (EVENT_COALESCE_MINUTES).
 * An outage fails every job for hours; ten thousand identical rows help nobody.
 */
function coalesceWindowMs(): number {
  const n = Number(process.env.EVENT_COALESCE_MINUTES);
  return (Number.isFinite(n) && n >= 0 ? n : 10) * 60 * 1000;
}

type EventInput = {
  workspaceId?: string | null;
  instagramId?: string;
  source?: "WORKER" | "SYSTEM";
  level: "INFO" | "WARNING" | "ERROR";
  /** Identifies the kind of event: keep it free of ids and counts, or nothing coalesces. */
  message: string;
  payload?: Record<string, unknown>;
};

/**
 * Writes an operational event (shown in diagnostics), or, when the same kind
 * (workspace, source, level, message) was already recorded in the last
 * EVENT_COALESCE_MINUTES (10; 0 turns this off), adds to that one: `repeats`
 * counts the occurrences and the newest details replace the older ones.
 *
 * Never throws: reporting a problem must not become a second problem. Give
 * `instagramId` instead of `workspaceId` when only the Instagram account is known.
 */
export async function recordEvent({ workspaceId, instagramId, source = "WORKER", level, message, payload }: EventInput): Promise<void> {
  try {
    let workspace = workspaceId ?? null;
    if (!workspace && instagramId) {
      workspace = (await prisma.instagramAccount.findUnique({ where: { instagramId }, select: { workspaceId: true } }))?.workspaceId ?? null;
    }

    const windowMs = coalesceWindowMs();
    if (windowMs > 0) {
      try {
        const recent = await prisma.operationalEvent.findFirst({
          where: { workspaceId: workspace, source, level, message, createdAt: { gte: new Date(Date.now() - windowMs) } },
          orderBy: { createdAt: "desc" },
          select: { id: true, payload: true },
        });
        if (recent) {
          const before = (recent.payload ?? {}) as Record<string, unknown>;
          const repeats = (typeof before.repeats === "number" ? before.repeats : 1) + 1;
          await prisma.operationalEvent.update({
            where: { id: recent.id },
            data: { payload: { ...before, ...(payload ?? {}), repeats, lastSeenAt: new Date().toISOString() } as never },
          });
          return;
        }
      } catch {
        // No lookup: fall through and write a row rather than lose the event.
      }
    }

    await prisma.operationalEvent.create({
      data: { workspaceId: workspace, source, level, message, ...(payload ? { payload: payload as never } : {}) },
    });
  } catch {
    // see above
  }
}
