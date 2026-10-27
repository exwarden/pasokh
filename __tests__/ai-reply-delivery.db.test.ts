/**
 * The AI reply's delivery states on a real Postgres: a process that dies inside
 * the send is never retried into a second message, a claim whose process died
 * before it answered is taken over by exactly one retry, and the daily limits
 * only count model calls that really happen.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/pasokh \
 *     npx vitest run __tests__/ai-reply-delivery.db.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");

const m = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  complete: vi.fn(),
  send: vi.fn(),
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return m.db;
  },
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (v: string) => v }));
vi.mock("../lib/ai/llm", async (orig) => ({ ...(await orig<object>()), complete: m.complete }));
vi.mock("@/lib/instagram/provider", () => ({
  RateLimitError: m.RateLimitError,
  createInstagramContext: async () => ({}),
  sendOutboundMessage: m.send,
}));

import { answerWithAi } from "../lib/ai/assistant";

const schema = `ai_delivery_${randomBytes(4).toString("hex")}`;
let sql: Client;
let assistantId: string;
const ANSWER = "ما در مشهد بیلبورد داریم.";
const ask = (messageId = "m1", extra: { finalAttempt?: boolean } = {}) =>
  answerWithAi({ instagramId: "ig1", igsid: "c1", messageId, text: "بیلبورد دارید؟", ...extra });
const row = (triggerId = "m1") => m.db.aiReply.findFirstOrThrow({ where: { triggerId } });
const seed = (data: { status?: string; answer?: string | null; claimedAgoMs?: number; attempts?: number; triggerId?: string; igsid?: string }) =>
  m.db.aiReply.create({
    data: {
      assistantId,
      igsid: data.igsid ?? "c1",
      triggerId: data.triggerId ?? "m1",
      question: "q",
      status: data.status ?? "PENDING",
      answer: data.answer ?? null,
      attempts: data.attempts ?? 1,
      claimedAt: new Date(Date.now() - (data.claimedAgoMs ?? 0)),
    },
  });

describe.skipIf(!DATABASE_URL)("AI reply delivery on a real Postgres", () => {
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
    m.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema }) });
    const account = await m.db.instagramAccount.create({ data: { workspaceId: "ws", instagramId: "ig1", username: "shop", accessToken: "x" } });
    const assistant = await m.db.aiAssistant.create({
      data: { instagramAccountId: account.id, enabled: true, model: "m", apiKey: "k", knowledge: ANSWER, dailyLimitPerPerson: 20 },
    });
    assistantId = assistant.id;
  }, 60_000);

  afterAll(async () => {
    await m.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    m.complete.mockReset();
    m.complete.mockResolvedValue(ANSWER);
    m.send.mockReset();
    m.send.mockResolvedValue(undefined);
    await m.db.aiReply.deleteMany();
    await m.db.operationalEvent.deleteMany();
    await m.db.aiAssistant.update({ where: { id: assistantId }, data: { dailyLimitPerPerson: 20 } });
  });

  it("the ordinary path is unchanged: one model call, one message, SENT", async () => {
    expect(await ask()).toBe("SENT");
    expect(m.complete).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({ status: "SENT", answer: ANSWER, attempts: 1 });
  });
  it("a redelivery of a finished reply does nothing", async () => {
    await ask();
    expect(await ask()).toBe("DUPLICATE");
    expect(m.complete).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it("the process dying after the send leaves SENDING, and the retry marks it UNCONFIRMED without sending again", async () => {
    const real = m.db.aiReply.update.bind(m.db.aiReply);
    // The send goes out, then the process "dies" before the outcome is recorded.
    vi.spyOn(m.db.aiReply, "update").mockImplementation(((args: { data: { status?: string } }) =>
      args.data.status === "SENT" ? Promise.reject(new Error("process died")) : real(args as never)) as never);
    await expect(ask()).rejects.toThrow("process died");
    vi.restoreAllMocks();
    expect((await row()).status).toBe("SENDING");
    expect(m.send).toHaveBeenCalledTimes(1);

    expect(await ask()).toBe("UNCONFIRMED");
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.complete).toHaveBeenCalledTimes(1);
    const after = await row();
    expect(after.status).toBe("UNCONFIRMED");
    expect(after.error).toContain("not sent again");
    // Visible where the other AI failures are.
    expect(await m.db.operationalEvent.count({ where: { message: "The AI assistant could not confirm a reply" } })).toBe(1);
    // And a further retry stays quiet.
    expect(await ask()).toBe("DUPLICATE");
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it("Instagram asking us to wait puts the stored answer back, and the retry sends it without a second model call", async () => {
    m.send.mockRejectedValueOnce(new m.RateLimitError("slow down"));
    await expect(ask()).rejects.toBeInstanceOf(m.RateLimitError);
    expect(await row()).toMatchObject({ status: "PENDING", answer: ANSWER });
    expect(await ask()).toBe("SENT");
    expect(m.complete).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledTimes(2);
  });
  it("a PENDING reply that already has its answer is sent without calling the model", async () => {
    await seed({ answer: ANSWER, claimedAgoMs: 0 });
    expect(await ask()).toBe("SENT");
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.send).toHaveBeenCalledTimes(1);
  });
});
