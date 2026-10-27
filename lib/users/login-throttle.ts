import { getRedisConnection } from "@/lib/queue/client";
import { withTimeout } from "@/lib/net/with-timeout";

/**
 * The failure counters could not be read in time (Redis down or slow). Signing
 * in without them would mean unlimited password guesses, so sign-in is refused
 * with a clear message instead of waiting or letting everyone through.
 */
export class ThrottleUnavailableError extends Error {
  name = "ThrottleUnavailableError";
}

const DEADLINE_MS = 300;

// A public instance is a password prompt on the open internet. Failures are
// counted three ways, and any one tripping blocks that key for the rest of the
// window:
//   - per email *and* address: guessing at one account from one place stops
//     after a few tries, but cannot lock the real owner out from elsewhere;
//   - per email overall, with a much higher ceiling: slows guessing spread over
//     many addresses without making a lockout cheap to cause;
//   - per address: one place spraying many accounts.
// Without a trusted address (TRUSTED_PROXY unset) the first two collapse into
// one email counter with the low limit, as before.
// Every attempt is counted before the password is checked; success clears the
// email's counters and gives the address its slot back.
const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES_PER_EMAIL_AND_IP = 5;
const MAX_FAILURES_PER_EMAIL = 50;
const MAX_FAILURES_PER_IP = 20;

function keys(email: string, ip: string | null) {
  const e = email.trim().toLowerCase();
  return {
    email: `login_fail:email:${e}`,
    pair: ip ? `login_fail:pair:${e}:${ip}` : null,
    ip: ip ? `login_fail:ip:${ip}` : null,
  };
}

/**
 * Counts this attempt and says whether it may go on to the password check.
 * The increment happens first and is atomic, so a burst of parallel guesses
 * each get their own number and only the first few are let through; counting
 * after the check would let them all read the same low count. Throws
 * ThrottleUnavailableError when the counters cannot be written in time.
 */
export async function reserveLoginAttempt(email: string, ip: string | null): Promise<boolean> {
  const k = keys(email, ip);
  const names = [k.email, k.pair, k.ip].filter((n): n is string => n !== null);
  let replies: Array<[Error | null, unknown]> | null;
  try {
    const multi = getRedisConnection().multi();
    for (const name of names) multi.incr(name).expire(name, WINDOW_SECONDS, "NX");
    replies = (await withTimeout(multi.exec(), DEADLINE_MS, null)) as Array<[Error | null, unknown]> | null;
  } catch (error) {
    throw new ThrottleUnavailableError(error instanceof Error ? error.message : "Redis error");
  }
  if (!replies) throw new ThrottleUnavailableError("Redis did not answer in time");
  // Replies alternate INCR, EXPIRE for each key, in the order of `names`.
  const count = (name: string) => {
    const reply = replies![names.indexOf(name) * 2];
    if (!reply || reply[0]) throw new ThrottleUnavailableError("Redis refused the counter");
    return Number(reply[1]);
  };
  const emailLimit = ip ? MAX_FAILURES_PER_EMAIL : MAX_FAILURES_PER_EMAIL_AND_IP;
  return (
    count(k.email) > emailLimit ||
    (k.pair !== null && count(k.pair) > MAX_FAILURES_PER_EMAIL_AND_IP) ||
    (k.ip !== null && count(k.ip) > MAX_FAILURES_PER_IP)
  );
}

export async function clearLoginFailures(email: string, ip: string | null = null): Promise<void> {
  try {
    const redis = getRedisConnection();
    const k = keys(email, ip);
    // The attempt was counted up front; a right password is not a failure, so
    // the address gets its slot back as well.
    const release = async () => {
      if (!k.ip) return;
      if ((await redis.decr(k.ip)) < 0) await redis.del(k.ip);
    };
    await withTimeout(Promise.all([redis.del(k.email), k.pair ? redis.del(k.pair) : Promise.resolve(0), release()]), DEADLINE_MS, null);
  } catch {
    // The password was right; failing to reset a counter must not block the sign-in.
  }
}
