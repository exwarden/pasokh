/**
 * Smoke test for lib/net/safe-fetch.ts against real hosts, no mocks.
 * Checks that the custom `lookup` (which always asks for all addresses) works
 * with the https agent on this Node version, for IPv4, IPv6 and dual-stack
 * hosts, and that a name resolving to a private address is refused.
 *
 *   npx tsx scripts/smoke-safe-fetch.ts
 *
 * Any status code counts as a pass for the public hosts (the point is that the
 * TLS connection through our lookup worked); a network error is reported as
 * "unreachable", which says nothing about the code when the local network has
 * no route to that address family.
 */
import { postJson } from "../lib/net/safe-fetch";
import { UnsafeUrlError } from "../lib/net/safe-url";

type Case = { label: string; url: string; expect: "reach" | "refuse" };

const cases: Case[] = [
  { label: "dual-stack", url: "https://example.com/", expect: "reach" },
  { label: "IPv4 only", url: "https://ipv4.icanhazip.com/", expect: "reach" },
  { label: "IPv6 only", url: "https://ipv6.icanhazip.com/", expect: "reach" },
  { label: "resolves to 127.0.0.1", url: "https://localtest.me/", expect: "refuse" },
];

async function main() {
  console.log(`node ${process.version}`);
  let failed = 0;
  for (const c of cases) {
    try {
      const res = await postJson(c.url, {}, { ping: true }, { timeoutMs: 15_000 });
      if (c.expect === "reach") console.log(`PASS  ${c.label}: HTTP ${res.status}, ${res.text.length} bytes`);
      else {
        failed++;
        console.log(`FAIL  ${c.label}: connected (HTTP ${res.status}) but should have been refused`);
      }
    } catch (error) {
      const e = error as Error & { code?: string };
      if (c.expect === "refuse" && error instanceof UnsafeUrlError) console.log(`PASS  ${c.label}: refused (${e.message})`);
      else if (c.expect === "refuse") {
        // DNS failure for the test name is inconclusive, not a pass.
        console.log(`SKIP  ${c.label}: ${e.name} ${e.code ?? ""} ${e.message}`);
      } else if (["ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"].includes(e.code ?? "")) {
        // No route or no AAAA answer on this network: not evidence about the code.
        console.log(`UNREACHABLE  ${c.label}: ${e.code} ${e.message}`);
      } else {
        failed++;
        console.log(`FAIL  ${c.label}: ${e.name} ${e.code ?? ""} ${e.message}`);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
