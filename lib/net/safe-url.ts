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

/** The 16 bytes of an IPv6 address (with "::" and a trailing dotted IPv4 expanded), or null. */
function ipv6Bytes(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = ipv4Parts(tail[1]);
    if (!v4) return null;
    text = text.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < (halves.length === 2 ? 1 : 0) || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

const ipv4At = (b: number[], at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

function isPrivateIpv6(ip: string): boolean {
  const b = ipv6Bytes(ip);
  if (!b) return true; // not an address we can reason about
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 12)) return true; // ::/96: unspecified, loopback, IPv4-compatible (::7f00:1)
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(ipv4At(b, 12)); // ::ffff:a.b.c.d
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    // 64:ff9b::/96 is NAT64 for a public IPv4 (judge it); 64:ff9b:1::/48 is local-use.
    return zeros(4, 12) ? isPrivateIpv4(ipv4At(b, 12)) : true;
  }
  const first = (b[0] << 8) | b[1];
  const second = (b[2] << 8) | b[3];
  return (
    first === 0x2002 || // 6to4: an IPv4 address in disguise, never needed for a gateway
    (first === 0x2001 && second === 0) || // Teredo
    (first === 0x2001 && second === 0x0db8) || // documentation
    (first === 0x0100 && zeros(2, 8)) || // discard-only 100::/64
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // site-local (deprecated) fec0::/10
    (first & 0xff00) === 0xff00 // multicast
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
 * address. This is an early, friendly refusal only. The request itself goes
 * through lib/net/safe-fetch.ts, whose connection uses the checked address, so
 * a name that changes between this lookup and the connection gains nothing.
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
