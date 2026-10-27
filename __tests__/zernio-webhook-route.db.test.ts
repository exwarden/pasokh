/**
 * The Zernio webhook route against a real Postgres: the seven captured events
 * (sanitized fixtures) go in signed, through normalisation and process-webhook,
 * and only the queue is replaced by a spy.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/pasokh \
 *     npx vitest run __tests__/zernio-webhook-route.db.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";
import { FAKE_SECRET, FIXTURE, fixture, fixtureBody, sign, zernioHeaders } from "./helpers/zernio-fixtures";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  add: vi.fn(async (...args: unknown[]) => void args),
}));
vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: state.add }),
  MESSAGE_JOB_NAME: "process-message",
  POSTBACK_JOB_NAME: "process-postback",
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "fixture-secret-not-a-real-one" }));

import { POST } from "../app/api/zernio/webhook/[workspaceId]/route";
import { claimZernioEvent } from "../lib/zernio/receipt";

const schema = `zernio_route_${randomBytes(4).toString("hex")}`;
let sql: Client;
const ZERNIO_ACCOUNT_ID = fixture(FIXTURE.messageText).account.accountId as string;

function deliver(body: string, headers = zernioHeaders(body), workspaceId = "ws") {
  const request = new Request(`http://localhost/api/zernio/webhook/${workspaceId}`, { method: "POST", headers, body });
  return POST(request, { params: Promise.resolve({ workspaceId }) });
}
const jobs = () => state.add.mock.calls.map((c) => c[0] as string);

describe.skipIf(!DATABASE_URL)("Zernio webhook route on a real Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: DATABASE_URL });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const dir of dirs) await sql.query(readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    await sql.query(`
      INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('u', 'u@test.dev', now());
      INSERT INTO "Workspace" ("id", "name", "ownerId", "updatedAt") VALUES ('ws', 'W', 'u', now());
    `);
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema }) });
    await state.db.zernioConnection.create({ data: { workspaceId: "ws", apiKey: "k", profileId: "p", webhookId: "wh", webhookSecret: "enc" } });
    await state.db.instagramAccount.create({
      data: { workspaceId: "ws", instagramId: "ig-fixture", username: "shop_account", accessToken: "unused", provider: "ZERNIO", zernioAccountId: ZERNIO_ACCOUNT_ID },
    });
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  beforeEach(async () => {
    state.add.mockReset();
    state.add.mockResolvedValue(undefined);
    await state.db.zernioEventReceipt.deleteMany();
    await state.db.zernioSentMessage.deleteMany();
    await state.db.webhookEvent.deleteMany();
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs all seven captured events: DMs and customer comments are queued, nothing else is", async () => {
    for (let n = 1; n <= 7; n++) {
      const res = await deliver(fixtureBody(n));
      expect(res.status, `fixture ${n}`).toBe(200);
    }
    // 1 and 2: messages; 3 and 4: comments; 5 and 7: message.sent; 6: the page's own reply.
    expect(jobs()).toEqual(["process-message", "process-message", "process-comment", "process-comment"]);
    expect(await state.db.zernioSentMessage.count()).toBe(2);
    expect(await state.db.zernioEventReceipt.count()).toBe(7);
  });

  it("queues a long (160+ character) message id without losing any of it", async () => {
    await deliver(fixtureBody(FIXTURE.messageText));
    const data = state.add.mock.calls[0][1] as { messageId: string };
    expect(data.messageId).toBe(fixture(FIXTURE.messageText).message.platformMessageId);
    expect(data.messageId.length).toBeGreaterThan(150);
  });

  it("the page's own public reply does not start a campaign", async () => {
    const res = await deliver(fixtureBody(FIXTURE.commentOwnReply));
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(state.add).not.toHaveBeenCalled();
  });

  it("message.sent is recorded as metadata only and never reaches automations", async () => {
    const body = fixtureBody(FIXTURE.sentHuman);
    expect((await deliver(body)).status).toBe(200);
    expect(state.add).not.toHaveBeenCalled();
    const row = await state.db.zernioSentMessage.findFirstOrThrow();
    expect(row).toMatchObject({ workspaceId: "ws", sentVia: "human", hasAttachments: false });
    expect(Object.keys(row).sort()).toEqual(["createdAt", "hasAttachments", "id", "platformMessageId", "sentAt", "sentVia", "workspaceId"]);
    expect(await state.db.webhookEvent.count()).toBe(0);
  });

  it("the same sent message under a new event id updates the one row", async () => {
    const original = fixture(FIXTURE.sentHuman);
    await deliver(fixtureBody(FIXTURE.sentHuman));
    const again = JSON.stringify({ ...original, id: "00000000-0000-4000-8000-0000000000ff", message: { ...original.message, sentVia: "automation" } });
    expect((await deliver(again)).status).toBe(200);
    expect(await state.db.zernioSentMessage.count()).toBe(1);
    expect((await state.db.zernioSentMessage.findFirstOrThrow()).sentVia).toBe("automation");
  });

  it("a redelivered event is acknowledged and not processed twice", async () => {
    const body = fixtureBody(FIXTURE.commentCustomer);
    expect((await (await deliver(body)).json())).toEqual({ success: true });
    expect((await (await deliver(body)).json())).toEqual({ success: true, duplicate: true });
    expect(jobs()).toEqual(["process-comment"]);
    expect(await state.db.webhookEvent.count()).toBe(1);
  });

  it("gives the event id back when processing fails, so Zernio's retry is processed", async () => {
    const body = fixtureBody(FIXTURE.commentCustomer);
    state.add.mockRejectedValueOnce(new Error("redis down"));
    expect((await deliver(body)).status).toBe(500);
    expect(await state.db.zernioEventReceipt.count()).toBe(0);
    expect((await deliver(body)).status).toBe(200);
    expect(jobs()).toEqual(["process-comment", "process-comment"]);
    expect(await state.db.zernioEventReceipt.count()).toBe(1);
  });

  it("accepts the legacy x-late-* headers when x-zernio-* are absent", async () => {
    const body = fixtureBody(FIXTURE.messageText);
    expect((await deliver(body, zernioHeaders(body, { prefixes: ["x-late"] }))).status).toBe(200);
    expect(jobs()).toEqual(["process-message"]);
  });

  it("rejects a missing, wrong or tampered signature before touching anything", async () => {
    const body = fixtureBody(FIXTURE.commentCustomer);
    const cases: [string, Response][] = [
      ["no header", await deliver(body, zernioHeaders(body, { signature: null }))],
      ["wrong length", await deliver(body, zernioHeaders(body, { signature: sign(body).slice(2) }))],
      ["wrong value", await deliver(body, zernioHeaders(body, { signature: sign(body, "other") }))],
      ["tampered body", await deliver(body.replace("customer", "attacker"), zernioHeaders(body))],
    ];
    for (const [label, res] of cases) expect(res.status, label).toBe(401);
    expect(state.add).not.toHaveBeenCalled();
    expect(await state.db.zernioEventReceipt.count()).toBe(0);
    expect(FAKE_SECRET).toBeTruthy();
  });

  it("warns, without values, when the event id header differs from the body id; the body id still dedupes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = fixtureBody(FIXTURE.commentCustomer);
    const headers = { ...zernioHeaders(body), "x-zernio-event-id": "some-other-id" };
    await deliver(body, headers);
    await deliver(body, headers);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0])).not.toContain("some-other-id");
    expect(jobs()).toEqual(["process-comment"]);
  });

  it("logs account.connected / account.disconnected and does nothing else", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const event of ["account.connected", "account.disconnected"]) {
      const body = JSON.stringify({ id: `00000000-0000-4000-8000-${event.length.toString().padStart(12, "0")}`, event, account: { id: ZERNIO_ACCOUNT_ID, platform: "instagram" } });
      expect((await (await deliver(body)).json())).toEqual({ success: true, ignored: true });
    }
    expect(info).toHaveBeenCalledTimes(2);
    expect(state.add).not.toHaveBeenCalled();
    expect(await state.db.zernioEventReceipt.count()).toBe(0);
  });

  it("ignores events of an account that is not connected here, without claiming them", async () => {
    const other = JSON.stringify({ ...fixture(FIXTURE.commentCustomer), account: { id: "someone-else", accountId: "someone-else", platform: "instagram" } });
    expect((await (await deliver(other)).json())).toMatchObject({ ignored: true });
    expect(await state.db.zernioEventReceipt.count()).toBe(0);
    expect(state.add).not.toHaveBeenCalled();
  });
  describe("receipt states", () => {
    const eventOf = (n: number) => ({ eventId: fixture(n).id as string, event: fixture(n).event as string });
    const seed = (n: number, status: "CLAIMED" | "ENQUEUED", ageMs: number) =>
      state.db.zernioEventReceipt.create({ data: { workspaceId: "ws", ...eventOf(n), status, claimedAt: new Date(Date.now() - ageMs) } });
    const statusOf = async (n: number) => (await state.db.zernioEventReceipt.findFirstOrThrow({ where: { eventId: eventOf(n).eventId } })).status;

    it("ENQUEUED: acknowledged as a duplicate, nothing runs", async () => {
      await seed(FIXTURE.commentCustomer, "ENQUEUED", 60 * 60_000);
      expect(await (await deliver(fixtureBody(FIXTURE.commentCustomer))).json()).toEqual({ success: true, duplicate: true });
      expect(state.add).not.toHaveBeenCalled();
    });

    it("a successful run leaves the receipt ENQUEUED", async () => {
      await deliver(fixtureBody(FIXTURE.commentCustomer));
      expect(await statusOf(FIXTURE.commentCustomer)).toBe("ENQUEUED");
    });

    it("CLAIMED and stale (the process died before queueing): reprocessed, then ENQUEUED", async () => {
      await seed(FIXTURE.commentCustomer, "CLAIMED", 10 * 60_000);
      const res = await deliver(fixtureBody(FIXTURE.commentCustomer));
      expect(await res.json()).toEqual({ success: true });
      expect(jobs()).toEqual(["process-comment"]);
      expect(await statusOf(FIXTURE.commentCustomer)).toBe("ENQUEUED");
    });

    it("CLAIMED and fresh (still being processed): 503 with Retry-After, nothing runs, claim untouched", async () => {
      await seed(FIXTURE.commentCustomer, "CLAIMED", 5_000);
      const res = await deliver(fixtureBody(FIXTURE.commentCustomer));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("30");
      expect(state.add).not.toHaveBeenCalled();
      expect(await statusOf(FIXTURE.commentCustomer)).toBe("CLAIMED");
    });

    it("the stale limit is configurable", async () => {
      await seed(FIXTURE.commentCustomer, "CLAIMED", 30_000);
      vi.stubEnv("ZERNIO_CLAIM_STALE_SECONDS", "10");
      try {
        expect((await deliver(fixtureBody(FIXTURE.commentCustomer))).status).toBe(200);
      } finally {
        vi.unstubAllEnvs();
      }
      expect(jobs()).toEqual(["process-comment"]);
    });

    it("two deliveries racing for one stale claim: exactly one takes it", async () => {
      await seed(FIXTURE.commentCustomer, "CLAIMED", 10 * 60_000);
      const results = await Promise.all(Array.from({ length: 5 }, () => claimZernioEvent({ workspaceId: "ws", ...eventOf(FIXTURE.commentCustomer) })));
      expect(results.filter((r) => r === "taken_over")).toHaveLength(1);
      expect(results.filter((r) => r === "in_flight")).toHaveLength(4);
    });

    it("the same race through the route queues the comment once", async () => {
      await seed(FIXTURE.commentCustomer, "CLAIMED", 10 * 60_000);
      const responses = await Promise.all([1, 2, 3].map(() => deliver(fixtureBody(FIXTURE.commentCustomer))));
      const bodies = await Promise.all(responses.map((r) => r.json()));
      expect(jobs()).toEqual(["process-comment"]);
      expect(bodies.filter((b) => b.success && !b.duplicate)).toHaveLength(1);
      expect(responses.every((r) => [200, 503].includes(r.status))).toBe(true);
    });

    it("a processing failure removes the claim, and the retry is processed", async () => {
      state.add.mockRejectedValueOnce(new Error("redis down"));
      expect((await deliver(fixtureBody(FIXTURE.commentCustomer))).status).toBe(500);
      expect(await state.db.zernioEventReceipt.count()).toBe(0);
      expect((await deliver(fixtureBody(FIXTURE.commentCustomer))).status).toBe(200);
      expect(await statusOf(FIXTURE.commentCustomer)).toBe("ENQUEUED");
    });

    it("receipts that existed before the status column are ENQUEUED, so they are never reprocessed", async () => {
      const old = `zernio_receipt_old_${randomBytes(4).toString("hex")}`;
      const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
      const last = dirs.indexOf("20261027150000_zernio_receipt_status");
      expect(last).toBeGreaterThan(0);
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      try {
        await client.query(`CREATE SCHEMA "${old}"`);
        await client.query(`SET search_path TO "${old}"`);
        for (const dir of dirs.slice(0, last)) await client.query(readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
        await client.query(`INSERT INTO "ZernioEventReceipt" ("id", "workspaceId", "eventId", "event") VALUES ('r1', 'ws', 'e1', 'comment.received')`);
        await client.query(readFileSync(path.join(MIGRATIONS_DIR, dirs[last], "migration.sql"), "utf8"));
        const { rows } = await client.query(`SELECT "status" FROM "ZernioEventReceipt" WHERE "id" = 'r1'`);
        expect(rows[0].status).toBe("ENQUEUED");
        await client.query(`INSERT INTO "ZernioEventReceipt" ("id", "workspaceId", "eventId", "event") VALUES ('r2', 'ws', 'e2', 'comment.received')`);
        expect((await client.query(`SELECT "status" FROM "ZernioEventReceipt" WHERE "id" = 'r2'`)).rows[0].status).toBe("CLAIMED");
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${old}" CASCADE`);
        await client.end();
      }
    });
  });
  describe("body size cap", () => {
    const big = "a".repeat(300_000);
    const post = (init: RequestInit) =>
      POST(new Request("http://localhost/api/zernio/webhook/ws", { method: "POST", ...init } as RequestInit), { params: Promise.resolve({ workspaceId: "ws" }) });

    it("refuses a declared oversize body with 413 before claiming or queueing anything", async () => {
      const res = await post({ headers: { "content-length": String(big.length) }, body: big });
      expect(res.status).toBe(413);
      expect(state.add).not.toHaveBeenCalled();
      expect(await state.db.zernioEventReceipt.count()).toBe(0);
    });

    it("refuses an oversize streamed body (no Content-Length) with 413", async () => {
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
      const res = await post({ body: stream, duplex: "half" } as RequestInit);
      expect(res.status).toBe(413);
      expect(state.add).not.toHaveBeenCalled();
    });

    it("still accepts a normal event", async () => {
      expect((await deliver(fixtureBody(FIXTURE.messageText))).status).toBe(200);
    });
  });
});
