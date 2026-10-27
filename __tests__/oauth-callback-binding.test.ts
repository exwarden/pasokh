import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ sessionUser: "attacker", exchanged: false }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: m.sessionUser } }) }));
vi.mock("@/lib/db/client", () => ({ prisma: { workspaceMember: { findFirst: async () => ({ role: "OWNER" }) }, operationalEvent: { create: async () => ({}) } } }));
vi.mock("@/lib/meta/client", () => ({ getLongLivedToken: vi.fn(), getUserInfo: vi.fn(), subscribeInstagramAccountToWebhooks: vi.fn() }));
vi.mock("@/lib/instagram-accounts", () => ({ canConnectInstagramAccount: vi.fn() }));
vi.mock("@/lib/meta/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/meta/oauth")>()),
  exchangeCodeForToken: async () => {
    m.exchanged = true;
    throw new Error("stop");
  },
}));

import { NextRequest } from "next/server";
import { GET } from "../app/api/instagram/callback/route";
import { createOAuthState } from "../lib/meta/oauth";

beforeEach(() => {
  m.exchanged = false;
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
});

describe("Meta OAuth callback", () => {
  it("does not complete a connection that another user started, even for a member of that workspace", async () => {
    m.sessionUser = "attacker";
    const state = createOAuthState("w1", "victim");
    const response = await GET(new NextRequest(`http://localhost:3000/api/instagram/callback?code=abc&state=${encodeURIComponent(state)}`));
    expect(response.headers.get("location")).toContain("instagram=forbidden");
    expect(m.exchanged).toBe(false);
  });

  it("goes on for the person who started it", async () => {
    m.sessionUser = "victim";
    const state = createOAuthState("w1", "victim");
    await GET(new NextRequest(`http://localhost:3000/api/instagram/callback?code=abc&state=${encodeURIComponent(state)}`));
    expect(m.exchanged).toBe(true);
  });
});
