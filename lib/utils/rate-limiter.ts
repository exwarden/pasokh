/**
 * Rate Limiter
 *
 * Redis-based rate limiter for Instagram private replies.
 *
 * Meta documents 750 private replies per hour per Instagram professional
 * account, for comments on posts and reels. Exceeding it risks 429s and
 * app-level restrictions, so the worker requeues rather than pushing through.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
 *
 * Two safeguards on top of Meta's number:
 *  - the cap is 600 (PRIVATE_REPLIES_PER_HOUR), leaving headroom for calls that
 *    share the bucket and for a throttle that starts before the stated limit;
 *  - the window slides: every reservation is a timestamp in a sorted set and
 *    only the last hour counts. A fixed window that resets on the clock would
 *    let a full cap go out at the end of one window and another at the start of
 *    the next, double the cap within minutes.
 */

import { randomBytes } from "node:crypto";
import Redis from "ioredis";

function configuredMax(): number {
  const n = Number(process.env.PRIVATE_REPLIES_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 600;
}

const RATE_LIMIT_MAX = configuredMax(); // private replies per rolling hour
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds
const WINDOW_MS = RATE_LIMIT_WINDOW * 1000;
const REQUEUE_DELAY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_REQUEUE_ATTEMPTS = 3;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return redis;
}

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingDMs: number;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

// Sliding window: one sorted-set entry per reservation, scored by time. Old
// entries are dropped first, so the count is exactly the last hour's.
const RESERVE_DM_SLOT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, "-inf", now - window)
local current = redis.call("ZCARD", key)
if current >= max then
  return {0, current, 0}
end

redis.call("ZADD", key, now, member)
redis.call("PEXPIRE", key, window)
return {1, current + 1, max - current - 1}
`;

const keyFor = (instagramAccountId: string) => `rate:dm:z:${instagramAccountId}`;

function toScriptNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

function blockedResult(
  count: number,
  requeueAttempt: number
): RateLimitResult {
  if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    };
  }

  return {
    allowed: false,
    currentCount: count,
    remainingDMs: 0,
    shouldRequeue: true,
    requeueDelayMs: REQUEUE_DELAY_MS,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Check if an Instagram account is within its DM rate limit.
 *
 * Counts the reservations of the last hour (a sorted set per account).
 * Key pattern: `rate:dm:z:{instagramAccountId}`
 *
 * @param instagramAccountId - The Instagram account ID to check
 * @param requeueAttempt - How many times this job has been requeued (0 = first attempt)
 * @returns Rate limit result with action recommendations
 */
export async function checkRateLimit(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const count = await client.zcount(keyFor(instagramAccountId), Date.now() - WINDOW_MS, "+inf");

  if (count >= RATE_LIMIT_MAX) {
    // Over the limit
    if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
      // Exceeded max requeue attempts — skip this DM
      return {
        allowed: false,
        currentCount: count,
        remainingDMs: 0,
        shouldRequeue: false,
        requeueDelayMs: 0,
        shouldSkip: true,
        reserved: false,
      };
    }

    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: REQUEUE_DELAY_MS,
      shouldSkip: false,
      reserved: false,
    };
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: RATE_LIMIT_MAX - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a DM send slot for an Instagram account.
 * This is the worker-safe path; it prevents concurrent jobs from all passing
 * the rate-limit check before any of them increments the Redis counter.
 */
export async function reserveDMSlot(
  instagramAccountId: string,
  requeueAttempt: number = 0,
  nowMs: number = Date.now()
): Promise<RateLimitResult> {
  const client = getRedis();

  const result = await client.eval(
    RESERVE_DM_SLOT_SCRIPT,
    1,
    keyFor(instagramAccountId),
    nowMs,
    WINDOW_MS,
    RATE_LIMIT_MAX,
    `${nowMs}-${randomBytes(4).toString("hex")}`
  );
  const values = Array.isArray(result) ? result : [];
  const allowedFlag = toScriptNumber(values[0]);
  const count = toScriptNumber(values[1]);
  const remaining = toScriptNumber(values[2]);

  if (allowedFlag !== 1) {
    return blockedResult(count, requeueAttempt);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: remaining,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  };
}

/**
 * Release a DM slot previously taken by reserveDMSlot.
 *
 * reserveDMSlot records the reservation before the send, so concurrent jobs
 * can't all pass the check at once. When that send then fails (closed
 * messaging window, expired token, rejected reply) the slot was never used and
 * must be handed back, or a comment that never delivers a DM still burns one
 * slot per attempt and BullMQ's retries burn several.
 *
 * The newest entry is removed: every entry counts the same, so which one goes
 * does not change the total. Returns the count that remains.
 */
export async function releaseDMSlot(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = keyFor(instagramAccountId);
  await client.zpopmax(key);
  return client.zcard(key);
}

/**
 * Backwards-compatible helper for tests and admin scripts.
 * Prefer reserveDMSlot in workers.
 */
export async function incrementDMCounter(
  instagramAccountId: string
): Promise<number> {
  const result = await reserveDMSlot(instagramAccountId, MAX_REQUEUE_ATTEMPTS);
  return result.currentCount;
}

/**
 * Get the current DM count for an Instagram account.
 */
export async function getCurrentDMCount(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  return client.zcount(keyFor(instagramAccountId), Date.now() - WINDOW_MS, "+inf");
}

/**
 * Reset the rate limiter for an account (useful for testing).
 */
export async function resetRateLimit(
  instagramAccountId: string
): Promise<void> {
  const client = getRedis();
  await client.del(keyFor(instagramAccountId));
}

// Export constants for use in tests
export { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, REQUEUE_DELAY_MS, MAX_REQUEUE_ATTEMPTS };
