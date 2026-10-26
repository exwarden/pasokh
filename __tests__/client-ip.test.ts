import { describe, expect, it } from "vitest";
import { clientIpFromHeaders } from "../lib/net/client-ip";

const headers = (init: Record<string, string>) => new Headers(init);

describe("client address behind a proxy", () => {
  it("trusts no header when no proxy is declared, so a spoofed header cannot choose the address", () => {
    const spoof = headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" });
    expect(clientIpFromHeaders(spoof, null)).toBeNull();
  });

  it("behind Caddy uses the last X-Forwarded-For entry, which Caddy wrote, not the one the visitor sent", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.5" }), "caddy")).toBe("203.0.113.5");
  });

  it("behind Caddy ignores a CF-Connecting-IP header the visitor made up", () => {
    expect(clientIpFromHeaders(headers({ "cf-connecting-ip": "1.1.1.1" }), "caddy")).toBeNull();
  });

  it("behind Cloudflare uses CF-Connecting-IP and ignores X-Forwarded-For", () => {
    expect(clientIpFromHeaders(headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "9.9.9.9" }), "cloudflare")).toBe("203.0.113.9");
  });

  it("rejects a value that is not an address", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "<script>" }), "caddy")).toBeNull();
  });
});
