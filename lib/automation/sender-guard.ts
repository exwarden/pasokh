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
 * The two limits are separate checks, because they protect against different
 * things:
 *   checkLoop          every inbound message and button tap (a loop is a loop,
 *                      whatever the sender is in the middle of);
 *   checkAutoReplyCap  only what would START an automatic reply. A customer
 *                      answering a form, a menu or a comment-reply prompt is in
 *                      a conversation we began, and their answers must never
 *                      be dropped for being the 21st message of the hour.
 * Each counts a retried job once. If Redis does not answer in time the message
 * is let through (losing the limit for a moment beats going silent), and an
 * event says so, so the gap is visible.
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

type SenderArgs = { instagramId: string; workspaceId?: string; senderId: string; messageId: string };

/** Fail open, but not silently: the limits were not applied to this message. */
async function unavailable(args: SenderArgs, reason: string): Promise<SenderVerdict> {
  await recordEvent({
    workspaceId: args.workspaceId,
    instagramId: args.instagramId,
    level: "WARNING",
    message: "Sender limits could not be checked",
    payload: { instagramId: args.instagramId, reason },
  });
  return "allow";
}

async function guarded(args: SenderArgs, run: (redis: ReturnType<typeof getRedisConnection>) => Promise<SenderVerdict>): Promise<SenderVerdict> {
  try {
    const verdict = await withTimeout<SenderVerdict | null>(run(getRedisConnection()), 300, null);
    return verdict ?? (await unavailable(args, "Redis did not answer in time"));
  } catch (error) {
    return unavailable(args, error instanceof Error ? error.message : "Redis error");
  }
}

/** More than LOOP_MESSAGES_PER_MINUTE from one sender in a minute is not a person. */
export function checkLoop(args: SenderArgs): Promise<SenderVerdict> {
  const { instagramId, workspaceId, senderId, messageId } = args;
  return guarded(args, async (redis) => {
    const who = `${instagramId}:${senderId}`;
    const limits = senderLimits();
    if (await redis.get(`sender_pause:${who}`)) return "loop_paused";
    // The same message again (a job retry) is not a new message.
    const fresh = await redis.set(`sender_seen:${who}:${messageId}`, "1", "EX", HOUR + 60, "NX");
    if (fresh === null) return "allow";
    const counts = await redis.multi().incr(`sender_minute:${who}`).expire(`sender_minute:${who}`, MINUTE, "NX").exec();
    if (Number(counts?.[0]?.[1] ?? 0) <= limits.loopPerMinute) return "allow";
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
  });
}

/** Call only for a message that would start an automatic reply. */
export function checkAutoReplyCap(args: SenderArgs): Promise<SenderVerdict> {
  const { instagramId, senderId, messageId } = args;
  return guarded(args, async (redis) => {
    const who = `${instagramId}:${senderId}`;
    const fresh = await redis.set(`sender_cap_seen:${who}:${messageId}`, "1", "EX", HOUR + 60, "NX");
    if (fresh === null) return "allow";
    const counts = await redis.multi().incr(`sender_hour:${who}`).expire(`sender_hour:${who}`, HOUR, "NX").exec();
    return Number(counts?.[0]?.[1] ?? 0) > senderLimits().perHour ? "over_hourly_cap" : "allow";
  });
}

/** Both limits, for a message that is certainly an initiator. */
export async function checkSender(args: SenderArgs): Promise<SenderVerdict> {
  const loop = await checkLoop(args);
  return loop !== "allow" ? loop : checkAutoReplyCap(args);
}
