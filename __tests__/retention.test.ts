import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const calls: { table: string; op: string; args: unknown }[] = [];
  const rows: Record<string, { id: string }[]> = {};
  const model = (table: string) => ({
    findMany: async (args: { take: number }) => {
      calls.push({ table, op: "findMany", args });
      return (rows[table] ?? []).splice(0, args.take);
    },
    deleteMany: async (args: { where: { id: { in: string[] } } }) => {
      calls.push({ table, op: "deleteMany", args });
      return { count: args.where.id.in.length };
    },
  });
  return {
    calls,
    rows,
    prisma: new Proxy({}, { get: (_t, table: string) => (table === "contact" ? new Proxy({}, { get: () => () => { throw new Error("contacts must never be touched"); } }) : model(table)) }),
  };
});
vi.mock("@/lib/db/client", () => ({ prisma: db.prisma }));

import { RETENTION, retentionDays, runRetention } from "../lib/ops/retention";

const NOW = new Date("2026-10-26T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const cutoffOf = (table: string) => {
  const call = db.calls.find((c) => c.table === table && c.op === "findMany");
  return (call?.args as { where: { createdAt: { lt: Date } } }).where.createdAt.lt;
};

beforeEach(() => {
  db.calls.length = 0;
  for (const key of Object.keys(db.rows)) delete db.rows[key];
  for (const t of ["webhookEvent", "dmLog", "operationalEvent", "aiReply", "zernioEventReceipt", "zernioSentMessage"]) db.rows[t] = [{ id: `${t}1` }, { id: `${t}2` }];
});

describe("data retention", () => {
  it("keeps webhook events 90 days and DM logs 180 by default, and prunes nothing newer", async () => {
    const deleted = await runRetention(NOW, {});
    expect(cutoffOf("webhookEvent").getTime()).toBe(NOW.getTime() - 90 * DAY);
    expect(cutoffOf("dmLog").getTime()).toBe(NOW.getTime() - 180 * DAY);
    expect(cutoffOf("zernioEventReceipt").getTime()).toBe(NOW.getTime() - 7 * DAY);
    expect(deleted).toEqual({ webhookEvent: 2, dmLog: 2, operationalEvent: 2, aiReply: 2, zernioEventReceipt: 2, zernioSentMessage: 2 });
  });

  it("follows the periods set in the environment, and 0 keeps a table for ever", async () => {
    await runRetention(NOW, { WEBHOOK_EVENT_RETENTION_DAYS: "30", DM_LOG_RETENTION_DAYS: "0" });
    expect(cutoffOf("webhookEvent").getTime()).toBe(NOW.getTime() - 30 * DAY);
    expect(db.calls.some((c) => c.table === "dmLog")).toBe(false);
  });

  it("ignores a value that is not a whole number of days", () => {
    expect(retentionDays(RETENTION[0], { WEBHOOK_EVENT_RETENTION_DAYS: "soon" })).toBe(90);
    expect(retentionDays(RETENTION[0], { WEBHOOK_EVENT_RETENTION_DAYS: "-5" })).toBe(90);
  });

  it("never touches contacts", async () => {
    await expect(runRetention(NOW, {})).resolves.toBeDefined();
    expect(db.calls.some((c) => c.table === "contact")).toBe(false);
  });
});
