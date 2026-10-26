import { getRedisConnection } from "@/lib/queue/client";

const WINDOW_SECONDS = 60;
/** Counted clicks per link and visitor each minute; real people do not click one link 30 times. */
const PER_VISITOR = 30;
/** Per link when the visitor's address is unknown (no trusted proxy): a ceiling for the whole minute. */
const PER_LINK_UNKNOWN_VISITOR = 600;

/**
 * Whether this click should be stored. The redirect itself always happens; only
 * the row is skipped, so a script hammering a public link cannot fill the
 * LinkClick table. If Redis is down the click is counted, as before.
 */
export async function shouldRecordClick(slug: string, ipHash: string | null): Promise<boolean> {
  try {
    const redis = getRedisConnection();
    const key = `click:${slug}:${ipHash ?? "unknown"}`;
    const results = await redis.multi().incr(key).expire(key, WINDOW_SECONDS, "NX").exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    return count <= (ipHash ? PER_VISITOR : PER_LINK_UNKNOWN_VISITOR);
  } catch {
    return true;
  }
}
