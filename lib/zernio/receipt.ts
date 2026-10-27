import { Prisma } from '@/app/generated/prisma/client';
import { prisma } from '@/lib/db/client';

/**
 * Claims for Zernio webhook events (ZernioEventReceipt).
 *
 * A delivery claims its event id before doing any work and marks it ENQUEUED once
 * its jobs are in the queue. A claim left in CLAIMED by a process that died is
 * taken over by the next delivery once it is older than the stale limit
 * (ZERNIO_CLAIM_STALE_SECONDS, default 120). Reprocessing is safe: job ids and the
 * durable per-message and per-comment claims in the worker absorb a second run.
 */
export type ClaimResult = 'claimed' | 'taken_over' | 'duplicate' | 'in_flight';

const DEFAULT_STALE_SECONDS = 120;

export function claimStaleMs(env: Record<string, string | undefined> = process.env): number {
  const seconds = Number(env.ZERNIO_CLAIM_STALE_SECONDS);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_STALE_SECONDS) * 1000;
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export async function claimZernioEvent(
  { workspaceId, eventId, event }: { workspaceId: string; eventId: string; event: string },
  now: Date = new Date(),
  staleMs: number = claimStaleMs(),
): Promise<ClaimResult> {
  // Twice: the row we collide with can be released (processing failed) before we read it.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await prisma.zernioEventReceipt.create({ data: { workspaceId, eventId, event, status: 'CLAIMED', claimedAt: now } });
      return 'claimed';
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const existing = await prisma.zernioEventReceipt.findUnique({
      where: { workspaceId_eventId: { workspaceId, eventId } },
      select: { status: true },
    });
    if (!existing) continue;
    if (existing.status === 'ENQUEUED') return 'duplicate';
    // Atomic: of any number of concurrent deliveries, exactly one changes the row.
    const taken = await prisma.zernioEventReceipt.updateMany({
      where: { workspaceId, eventId, status: 'CLAIMED', claimedAt: { lt: new Date(now.getTime() - staleMs) } },
      data: { claimedAt: now },
    });
    return taken.count === 1 ? 'taken_over' : 'in_flight';
  }
  return 'in_flight';
}

export async function markZernioEventEnqueued({ workspaceId, eventId }: { workspaceId: string; eventId: string }) {
  await prisma.zernioEventReceipt.updateMany({ where: { workspaceId, eventId }, data: { status: 'ENQUEUED' } });
}

/** Processing failed: forget the claim so Zernio's retry is handled as new. */
export async function releaseZernioEvent({ workspaceId, eventId }: { workspaceId: string; eventId: string }) {
  await prisma.zernioEventReceipt.deleteMany({ where: { workspaceId, eventId } });
}
