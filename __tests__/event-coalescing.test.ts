import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; workspaceId: string | null; source: string; level: string; message: string; payload: Record<string, unknown> | null; createdAt: Date };
const db = vi.hoisted(() => ({ rows: [] as Row[], lookupFails: false }));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramAccount: { findUnique: async () => ({ workspaceId: "w1" }) },
    operationalEvent: {
      findFirst: async ({ where }: { where: Record<string, unknown> & { createdAt: { gte: Date } } }) => {
        if (db.lookupFails) throw new Error("no lookup");
        return (
          db.rows
            .filter((r) => r.workspaceId === where.workspaceId && r.source === where.source && r.level === where.level && r.message === where.message && r.createdAt >= where.createdAt.gte)
            .at(-1) ?? null
        );
      },
      update: async ({ where, data }: { where: { id: string }; data: { payload: Record<string, unknown> } }) => {
        const row = db.rows.find((r) => r.id === where.id)!;
        row.payload = data.payload;
        return row;
      },
      create: async ({ data }: { data: Omit<Row, "id" | "createdAt" | "payload"> & { payload?: Record<string, unknown> } }) => {
        db.rows.push({ id: `e${db.rows.length}`, createdAt: new Date(), payload: data.payload ?? null, ...data });
        return {};
      },
    },
  },
}));

import { recordEvent } from "../lib/ops/events";

beforeEach(() => {
  db.rows.length = 0;
  db.lookupFails = false;
  vi.useRealTimers();
  delete process.env.EVENT_COALESCE_MINUTES;
});

const fail = (message = "DM worker job failed: token expired", extra: Record<string, unknown> = {}) =>
  recordEvent({ workspaceId: "w1", level: "ERROR", message, payload: extra });

describe("repeated operational events", () => {
  it("an outage that fails a thousand jobs leaves one row with a count, and the newest details", async () => {
    for (let i = 0; i < 1000; i++) await fail(undefined, { jobId: `job${i}` });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].payload).toMatchObject({ repeats: 1000, jobId: "job999" });
  });

  it("different kinds, levels and workspaces stay separate", async () => {
    await fail("A");
    await fail("B");
    await recordEvent({ workspaceId: "w2", level: "ERROR", message: "A" });
    await recordEvent({ workspaceId: "w1", level: "WARNING", message: "A" });
    expect(db.rows).toHaveLength(4);
  });

  it("starts a new row once the window has passed", async () => {
    await fail();
    db.rows[0].createdAt = new Date(Date.now() - 11 * 60 * 1000);
    await fail();
    expect(db.rows).toHaveLength(2);
  });

  it("EVENT_COALESCE_MINUTES=0 turns it off", async () => {
    process.env.EVENT_COALESCE_MINUTES = "0";
    await fail();
    await fail();
    expect(db.rows).toHaveLength(2);
  });

  it("still records the event if the lookup fails", async () => {
    db.lookupFails = true;
    await fail();
    expect(db.rows).toHaveLength(1);
  });

  it("finds the workspace from the Instagram account when only that is known", async () => {
    await recordEvent({ instagramId: "ig1", level: "WARNING", message: "x" });
    expect(db.rows[0].workspaceId).toBe("w1");
  });
});
