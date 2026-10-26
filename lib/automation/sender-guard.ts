import { getRedisConnection } from "@/lib/queue/client";
import { withTimeout } from "@/lib/net/with-timeout";
import { recordEvent } from "@/lib/ops/events";

/**
 * Limits on automatic replies to one sender, against the two ways an
 * auto-responder gets an Instagram account restricted: answering one person
 * without end, and two automatic responders answering each other.
 *
 *   AUTO_REPLIES_PER_SENDER_PER_HOUR  most messages from one sender that are
 *                                     answered automatically in an hour (20)
 *   LOOP_MESSAGES_PER_MINUTE          more messages than this from one sender
 *                                     within 60 seconds is a loop, not a person:
 *                                     automatic replies to them stop for an
 *                                     hour (10)
 *
 * Counted per inbound message (a retried job is counted once), because every
 * message may produce a reply. If Redis does not answer in time the message is
 * let through: losing the limit for a moment beats going silent.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function senderLimits(env: Record<string, string | undefined> = process.env) {
  return {
    perHour: positiveInt(env.AUTO_REPLIES_PER_SENDER_PER_HOUR, 20),
    loopPerMinute: positiveInt(env.LOOP_MESSAGES_PER_MINUTE, 10),
  };
}

const HOUR = 3600;
const MINUTE = 60;

export type SenderVerdict = "allow" | "over_hourly_cap" | "loop_paused";

export async function checkSender({
  instagramId,
  workspaceId,
  senderId,
  messageId,
}: {
  instagramId: string;
  workspaceId?: string;
  senderId: string;
  messageId: string;
}): Promise<SenderVerdict> {
  try {
    const redis = getRedisConnection();
    const who = `${instagramId}:${senderId}`;
    const limits = senderLimits();

    const verdict = await withTimeout<SenderVerdict | null>(
      (async () => {
        if (await redis.get(`sender_pause:${who}`)) return "loop_paused";
        // The same message again (a job retry) is not a new message.
        const fresh = await redis.set(`sender_seen:${who}:${messageId}`, "1", "EX", HOUR + 60, "NX");
        if (fresh === null) return "allow";

        const counts = await redis
          .multi()
          .incr(`sender_minute:${who}`)
          .expire(`sender_minute:${who}`, MINUTE, "NX")
          .incr(`sender_hour:${who}`)
          .expire(`sender_hour:${who}`, HOUR, "NX")
          .exec();
        const perMinute = Number(counts?.[0]?.[1] ?? 0);
        const perHour = Number(counts?.[2]?.[1] ?? 0);

        if (perMinute > limits.loopPerMinute) {
          const first = await redis.set(`sender_pause:${who}`, "1", "EX", HOUR, "NX");
          if (first !== null) {
            await recordEvent({
              workspaceId,
              instagramId,
              level: "WARNING",
              message: "Automatic replies to a sender were paused",
              payload: { instagramId, senderId, reason: `more than ${limits.loopPerMinute} messages in 60 seconds`, pausedForSeconds: HOUR },
            });
          }
          return "loop_paused";
        }
        if (perHour > limits.perHour) return "over_hourly_cap";
        return "allow";
      })(),
      300,
      null,
    );
    return verdict ?? "allow";
  } catch {
    return "allow";
  }
}
