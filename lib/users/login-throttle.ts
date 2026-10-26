import { getRedisConnection } from "@/lib/queue/client";

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
  const redis = getRedisConnection();
  const k = keys(email, ip);
  const [byEmail, byPair, byIp] = await Promise.all([
    redis.get(k.email),
    k.pair ? redis.get(k.pair) : Promise.resolve(null),
    k.ip ? redis.get(k.ip) : Promise.resolve(null),
  ]);
  const emailLimit = ip ? MAX_FAILURES_PER_EMAIL : MAX_FAILURES_PER_EMAIL_AND_IP;
  return (
    Number(byEmail ?? 0) >= emailLimit ||
    Number(byPair ?? 0) >= MAX_FAILURES_PER_EMAIL_AND_IP ||
    Number(byIp ?? 0) >= MAX_FAILURES_PER_IP
  );
}

export async function recordLoginFailure(email: string, ip: string | null): Promise<void> {
  const redis = getRedisConnection();
  const k = keys(email, ip);
  const multi = redis.multi().incr(k.email).expire(k.email, WINDOW_SECONDS, "NX");
  if (k.pair) multi.incr(k.pair).expire(k.pair, WINDOW_SECONDS, "NX");
  if (k.ip) multi.incr(k.ip).expire(k.ip, WINDOW_SECONDS, "NX");
  await multi.exec();
}

export async function clearLoginFailures(email: string, ip: string | null = null): Promise<void> {
  const redis = getRedisConnection();
  const k = keys(email, ip);
  await redis.del(k.email);
  if (k.pair) await redis.del(k.pair);
}
