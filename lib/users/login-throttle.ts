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
// Success clears the email's counters.
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

export async function isLoginThrottled(email: string, ip: string | null): Promise<boolean> {
  const k = keys(email, ip);
  let counts: [string | null, string | null, string | null];
  try {
    const redis = getRedisConnection();
    const read = Promise.all([
      redis.get(k.email),
      k.pair ? redis.get(k.pair) : Promise.resolve(null),
      k.ip ? redis.get(k.ip) : Promise.resolve(null),
    ]);
    const result = await withTimeout(read, DEADLINE_MS, null);
    if (!result) throw new ThrottleUnavailableError("Redis did not answer in time");
    counts = result;
  } catch (error) {
    throw error instanceof ThrottleUnavailableError ? error : new ThrottleUnavailableError(error instanceof Error ? error.message : "Redis error");
  }
  const [byEmail, byPair, byIp] = counts;
  const emailLimit = ip ? MAX_FAILURES_PER_EMAIL : MAX_FAILURES_PER_EMAIL_AND_IP;
  return (
    Number(byEmail ?? 0) >= emailLimit ||
    Number(byPair ?? 0) >= MAX_FAILURES_PER_EMAIL_AND_IP ||
    Number(byIp ?? 0) >= MAX_FAILURES_PER_IP
  );
}

export async function recordLoginFailure(email: string, ip: string | null): Promise<void> {
  // The attempt is already refused; a counter that cannot be written must not
  // turn that refusal into a hang.
  try {
    const redis = getRedisConnection();
    const k = keys(email, ip);
    const multi = redis.multi().incr(k.email).expire(k.email, WINDOW_SECONDS, "NX");
    if (k.pair) multi.incr(k.pair).expire(k.pair, WINDOW_SECONDS, "NX");
    if (k.ip) multi.incr(k.ip).expire(k.ip, WINDOW_SECONDS, "NX");
    await withTimeout(multi.exec(), DEADLINE_MS, null);
  } catch {
    // see above
  }
}

export async function clearLoginFailures(email: string, ip: string | null = null): Promise<void> {
  try {
    const redis = getRedisConnection();
    const k = keys(email, ip);
    await withTimeout(Promise.all([redis.del(k.email), k.pair ? redis.del(k.pair) : Promise.resolve(0)]), DEADLINE_MS, null);
  } catch {
    // The password was right; failing to reset a counter must not block the sign-in.
  }
}
