import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";

const WINDOW_SECONDS = 10 * 60;

/**
 * A request to the webhook with a bad signature is either a wrong
 * FACEBOOK_APP_SECRET (worth showing: every real event fails) or someone
 * probing. Both look the same, and the endpoint is open to the internet, so
 * writing a row per request would let a flood fill the database. One event per
 * ten minutes is enough to notice; the count says how loud it was.
 *
 * Nothing from the request body is stored: it comes from an unauthenticated sender.
 */
export async function noteBadWebhookSignature({ hadSignatureHeader, bodyLength }: { hadSignatureHeader: boolean; bodyLength: number }): Promise<void> {
  try {
    const redis = getRedisConnection();
    const key = "webhook_bad_signature";
    const results = await redis.multi().incr(key).expire(key, WINDOW_SECONDS, "NX").exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    if (count !== 1) return;
    await prisma.operationalEvent.create({
      data: {
        source: "SYSTEM",
        level: "WARNING",
        message: "Webhook signature verification failed",
        payload: { hadSignatureHeader, bodyLength, note: "Logged once per 10 minutes; check FACEBOOK_APP_SECRET if real events are failing." },
      },
    });
  } catch {
    // Alerting must never turn a rejected request into a server error.
  }
}
