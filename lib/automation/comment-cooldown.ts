import { prisma } from "@/lib/db/client";

const HOUR_MS = 3_600_000;
const DEFAULT_COOLDOWN_HOURS = 24;

/**
 * How long a campaign leaves a person alone after it has DMed them from a
 * comment. Meta allows one private reply per comment, so a person who comments
 * the keyword N times under a post would otherwise receive N DMs.
 * `COMMENT_DM_COOLDOWN_HOURS` sets it (default 24, fractions allowed, 0 = off).
 */
export function commentDmCooldownMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.COMMENT_DM_COOLDOWN_HOURS?.trim();
  if (!raw) return DEFAULT_COOLDOWN_HOURS * HOUR_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_COOLDOWN_HOURS * HOUR_MS;
  return Math.round(hours * HOUR_MS);
}

/**
 * A DM this campaign already delivered to this person, from another comment,
 * inside the cooldown window. Null when there is none or the cooldown is off.
 */
export async function findRecentDmToCommenter(
  { automationId, commenterId, commentId, cooldownMs }: { automationId: string; commenterId: string; commentId: string; cooldownMs: number },
  now: Date = new Date(),
): Promise<{ dmSentAt: Date | null } | null> {
  if (cooldownMs <= 0) return null;
  return prisma.dmLog.findFirst({
    where: {
      automationId,
      commenterId,
      status: "SENT",
      commentId: { not: commentId },
      dmSentAt: { gte: new Date(now.getTime() - cooldownMs) },
    },
    select: { dmSentAt: true },
  });
}
