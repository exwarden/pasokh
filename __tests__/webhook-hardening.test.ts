import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  counter: 0,
  eventsCreated: [] as unknown[],
  dmLogWhere: [] as unknown[],
}));

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({
    multi: () => ({
      incr() {
        return this;
      },
      expire() {
        return this;
      },
      exec: async () => [[null, ++m.counter], [null, 1]],
    }),
  }),
  getDMQueue: () => ({ add: async () => undefined }),
  MESSAGE_JOB_NAME: "process-message",
  POSTBACK_JOB_NAME: "process-postback",
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    operationalEvent: { create: async (args: unknown) => m.eventsCreated.push(args) },
    instagramAccount: { findMany: async () => [{ id: "a1", instagramId: "ig1", username: "shop", workspaceId: "w1" }] },
    webhookEvent: { create: async () => ({ id: "e1" }), update: async () => ({}) },
    dmLog: { findMany: async (args: unknown) => (m.dmLogWhere.push(args), []) },
  },
}));

import { GET, POST } from "../app/api/webhook/route";
import { processInstagramWebhook } from "../lib/queue/process-webhook";

beforeEach(() => {
  m.counter = 0;
  m.eventsCreated.length = 0;
  m.dmLogWhere.length = 0;
  process.env.FACEBOOK_APP_SECRET = "secret-for-tests";
  process.env.WEBHOOK_VERIFY_TOKEN = "verify-token-for-tests";
});

const post = (body: string) => POST(new Request("http://x/api/webhook", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=bad" } }) as never);

describe("the Meta webhook endpoint", () => {
  it("a flood of badly signed requests writes one event, not one row each, and never the body", async () => {
    for (let i = 0; i < 200; i++) expect((await post(`{"junk":"${"x".repeat(50)}${i}"}`)).status).toBe(401);
    expect(m.eventsCreated).toHaveLength(1);
    expect(JSON.stringify(m.eventsCreated)).not.toContain("junk");
  });

  it("answers the verification handshake only to the right token", async () => {
    const verify = (token: string) =>
      GET({ nextUrl: new URL(`http://x/api/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc`) } as never);
    expect((await verify("verify-token-for-tests")).status).toBe(200);
    expect((await verify("verify-token-for-testz")).status).toBe(403);
    expect((await verify("")).status).toBe(403);
  });
});

describe("read receipts", () => {
  it("look up opening DMs only inside the account's own workspace", async () => {
    await processInstagramWebhook({
      provider: "META",
      payload: { object: "instagram", entry: [{ id: "ig1", time: 1, messaging: [{ sender: { id: "person" }, read: { watermark: 1 } }] }] } as never,
    });
    expect(m.dmLogWhere[0]).toMatchObject({ where: { workspaceId: "w1", commenterId: "person" } });
  });
});
