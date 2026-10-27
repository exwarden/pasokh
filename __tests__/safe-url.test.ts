import { beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ addresses: [{ address: "93.184.216.34", family: 4 }] as { address: string; family: number }[] }));
vi.mock("node:dns/promises", () => ({ lookup: async () => dns.addresses }));

const postJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/net/safe-fetch", async (importOriginal) => ({ ...(await importOriginal<object>()), postJson }));

import { assertPublicHttpsUrl, checkPublicHttpsUrl, isPrivateAddress, UnsafeUrlError } from "../lib/net/safe-url";
import { ResponseTooLargeError } from "../lib/net/safe-fetch";
import { complete, LlmError } from "../lib/ai/llm";
import { assistantInputSchema } from "../lib/ai/settings";

beforeEach(() => {
  dns.addresses = [{ address: "93.184.216.34", family: 4 }];
  vi.unstubAllGlobals();
});

describe("addresses a user-supplied URL may not reach", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "224.0.0.1",
    // NAT64, IPv4-compatible, 6to4, Teredo, discard, site-local
    "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "::7f00:1", "::10.0.0.1", "2002::1", "2002:7f00:1::1",
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "100::1", "fec0::1", "2001:db8::1",
  ])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "64:ff9b::5db8:d822", "2001:4860:4860::8888"])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each([
    "http://gateway.example.ir/v1",
    "https://localhost/v1",
    "https://redis/v1",
    "https://web:3000/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/v1",
    "https://user:pass@gateway.example.ir/v1",
    "ftp://gateway.example.ir",
    "not a url",
    "https://db.internal/v1",
  ])("refuses %s before any lookup", (url) => {
    expect(() => checkPublicHttpsUrl(url)).toThrow();
  });

  it("accepts an ordinary public https gateway", () => {
    expect(checkPublicHttpsUrl("https://gateway.example.ir/v1").hostname).toBe("gateway.example.ir");
  });

  it("refuses a public-looking name that resolves to a private address (DNS pointed inward)", async () => {
    dns.addresses = [{ address: "10.0.0.5", family: 4 }];
    await expect(assertPublicHttpsUrl("https://innocent.example.com/v1")).rejects.toThrow("private network");
  });

  it("refuses when any of several answers is private", async () => {
    dns.addresses = [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    await expect(assertPublicHttpsUrl("https://mixed.example.com/v1")).rejects.toThrow("private network");
  });
});

describe("the AI gateway address", () => {
  const input = (baseUrl: string) => ({ instagramAccountId: "a", enabled: true, provider: "OPENAI" as const, model: "m", baseUrl });

  it("is rejected when saving if it points inside the deployment", () => {
    for (const baseUrl of ["http://redis:6379", "https://169.254.169.254/", "https://localhost:3000"]) {
      expect(assistantInputSchema.safeParse(input(baseUrl)).success, baseUrl).toBe(false);
    }
    expect(assistantInputSchema.safeParse(input("https://gateway.example.ir/v1")).success).toBe(true);
  });

  it("turns a refusal to connect to a private address into an LlmError, and the key goes nowhere", async () => {
    postJson.mockRejectedValue(new UnsafeUrlError("The address points at a private network."));
    await expect(
      complete({ provider: "OPENAI", model: "m", apiKey: "secret-key", baseUrl: "https://rebound.example.com/v1" }, "S", [{ role: "user", content: "x" }]),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("turns an oversized answer into an LlmError that is not retried", async () => {
    postJson.mockRejectedValue(new ResponseTooLargeError("The answer is larger than 1048576 bytes."));
    await expect(
      complete({ provider: "OPENAI", model: "m", apiKey: "k", baseUrl: "https://gateway.example.ir/v1" }, "S", [{ role: "user", content: "x" }]),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("does not follow a redirect to somewhere unchecked", async () => {
    postJson.mockResolvedValue({ status: 302, headers: { location: "http://169.254.169.254/" }, text: "" });
    await expect(
      complete({ provider: "OPENAI", model: "m", apiKey: "k", baseUrl: "https://gateway.example.ir/v1" }, "S", [{ role: "user", content: "x" }]),
    ).rejects.toThrow("redirected");
  });
});
