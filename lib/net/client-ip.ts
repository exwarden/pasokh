/**
 * The visitor's address, read only from a header the deployment can vouch for.
 *
 * A header such as X-Forwarded-For or CF-Connecting-IP is whatever the sender
 * wrote unless the proxy in front rewrites it, so trusting it blindly lets
 * anyone pick the address a rate limit sees. TRUSTED_PROXY says which proxy
 * sits in front:
 *
 *   caddy       the domain profile: Caddy appends the real peer address to
 *               X-Forwarded-For, so the LAST entry is the one to trust
 *   cloudflare  a Cloudflare tunnel or proxy: CF-Connecting-IP
 *   (unset)     no proxy is trusted: no address, so limits fall back to
 *               per-account counters
 */
export type TrustedProxy = "caddy" | "cloudflare" | null;

export function trustedProxy(): TrustedProxy {
  const value = process.env.TRUSTED_PROXY?.trim().toLowerCase();
  return value === "caddy" || value === "cloudflare" ? value : null;
}

const IP_SHAPE = /^[0-9a-f:.]{3,45}$/i;

export function clientIpFromHeaders(headers: Pick<Headers, "get">, proxy: TrustedProxy = trustedProxy()): string | null {
  let candidate: string | null | undefined;
  if (proxy === "cloudflare") {
    candidate = headers.get("cf-connecting-ip")?.trim();
  } else if (proxy === "caddy") {
    candidate = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  }
  return candidate && IP_SHAPE.test(candidate) ? candidate : null;
}
