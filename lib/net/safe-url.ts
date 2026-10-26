import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Addresses a user-supplied URL may not point at: this machine, the private
 * network the containers share (Redis, Postgres, the app itself), link-local
 * (cloud metadata at 169.254.169.254) and other non-public ranges.
 */
export class UnsafeUrlError extends Error {
  name = "UnsafeUrlError";
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function isPrivateIpv4(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (!p) return true; // not an address we can reason about
  const [a, b, c] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast and reserved
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::" || lower === "::1") return true;
  // IPv4 carried inside IPv6 (::ffff:10.0.0.1, 64:ff9b::10.0.0.1): judge the IPv4.
  const embedded = /(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded) return isPrivateIpv4(embedded[1]);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(lower.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    lower.startsWith("2001:db8:") // documentation
  );
}

export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return isPrivateIpv4(bare);
  if (family === 6) return isPrivateIpv6(bare);
  return true;
}

/**
 * Checks that need no network: https only, no credentials in the URL, and a
 * host that is a public name or public address. A name with no dot is a
 * container or intranet name (redis, web), never a public one.
 */
export function checkPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("The address is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("The address must start with https://.");
  if (url.username || url.password) throw new UnsafeUrlError("The address must not contain a username or password.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError("The address points at a private network.");
  } else if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("The address points at a private network.");
  }
  return url;
}

/**
 * The same, plus a DNS lookup: a public-looking name may resolve to a private
 * address. Call it immediately before the request. (A name can still change
 * between the lookup and the connection; the request does not follow
 * redirects, which closes the more common route.)
 */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const url = checkPublicHttpsUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return url;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError("The address could not be resolved.");
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError("The address points at a private network.");
  }
  return url;
}
