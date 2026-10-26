import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ link: null as null | { destinationUrl: string }, clicks: [] as { data: Record<string, unknown> }[], count: 0 }));

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({
    multi: () => ({
      incr() {
        return this;
      },
      expire() {
        return this;
      },
      exec: async () => [[null, ++m.count], [null, 1]],
    }),
  }),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    trackedLink: { findUnique: async () => (m.link ? { id: "t1", workspaceId: "w1", automationId: "a1", automation: { instagramAccountId: "i1" }, ...m.link } : null) },
    linkClick: { create: async (args: { data: Record<string, unknown> }) => m.clicks.push(args) },
  },
}));

import { GET } from "../app/r/[slug]/route";
import { httpUrlSchema } from "../lib/utils/http-url";

const hit = (headers: Record<string, string> = {}) =>
  GET({ url: "http://localhost/r/abc", headers: new Headers(headers) } as never, { params: Promise.resolve({ slug: "abc" }) });

beforeEach(() => {
  m.link = { destinationUrl: "https://shop.example.ir/page" };
  m.clicks.length = 0;
  m.count = 0;
  delete process.env.TRUSTED_PROXY;
});

describe("tracked link redirect", () => {
  it("only sends people to web addresses", async () => {
    for (const destinationUrl of ["javascript:alert(1)", "data:text/html,x", "ftp://x.example/file"]) {
      m.link = { destinationUrl };
      const response = await hit();
      expect(response.headers.get("location")).toBe("http://localhost/");
      expect(m.clicks).toHaveLength(0);
    }
  });

  it("redirects to the stored https address and records the click with a cut-down user agent", async () => {
    const response = await hit({ "user-agent": "x".repeat(5000), referer: "https://r.example/" + "y".repeat(5000) });
    expect(response.headers.get("location")).toBe("https://shop.example.ir/page");
    const data = m.clicks[0].data;
    expect((data.userAgent as string).length).toBe(300);
    expect((data.referrer as string).length).toBe(500);
  });

  it("keeps redirecting but stops recording once an address floods one link", async () => {
    process.env.TRUSTED_PROXY = "caddy";
    for (let i = 0; i < 100; i++) {
      const response = await hit({ "x-forwarded-for": "203.0.113.5" });
      expect(response.headers.get("location")).toBe("https://shop.example.ir/page");
    }
    expect(m.clicks).toHaveLength(30);
  });
});

describe("campaign link addresses", () => {
  it("accept http and https only", () => {
    expect(httpUrlSchema.safeParse("https://shop.example.ir/a?b=1").success).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.example", "//evil.example", "not a url"]) {
      expect(httpUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
