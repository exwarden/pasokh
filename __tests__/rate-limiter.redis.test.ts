/**
 * The limiter's Lua script against a real Redis: the sliding window only
 * exists there. Skipped without one:
 *
 *   TEST_REDIS_URL=redis://localhost:56379 npx vitest run __tests__/rate-limiter.redis.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

const URL = process.env.TEST_REDIS_URL;
vi.stubEnv("REDIS_URL", URL ?? "redis://localhost:6379");

import { RATE_LIMIT_MAX, releaseDMSlot, reserveDMSlot } from "../lib/utils/rate-limiter";

const account = `test_${Math.random().toString(36).slice(2)}`;
const HOUR = 3600 * 1000;
let redis: Redis;

describe.skipIf(!URL)("sliding-window private reply limiter on Redis", () => {
  beforeEach(async () => {
    redis ??= new Redis(URL!);
    await redis.del(`rate:dm:z:${account}`);
  });
  afterAll(async () => {
    await redis?.del(`rate:dm:z:${account}`);
    await redis?.quit();
  });

  async function fill(n: number, at: number) {
    for (let i = 0; i < n; i++) expect((await reserveDMSlot(account, 0, at)).allowed).toBe(true);
  }

  it("allows exactly the cap within an hour and then refuses", async () => {
    const t = Date.now();
    await fill(RATE_LIMIT_MAX, t);
    expect((await reserveDMSlot(account, 0, t + 1000)).allowed).toBe(false);
  });

  it("does not let a second full cap through at the start of the next clock hour: the window slides", async () => {
    const t = Date.now();
    await fill(RATE_LIMIT_MAX, t); // all at the same moment
    // 30 minutes later no slot has aged out, so nothing more goes, whatever the clock says.
    expect((await reserveDMSlot(account, 0, t + 30 * 60 * 1000)).allowed).toBe(false);
    // Only after a full hour do they leave the window.
    expect((await reserveDMSlot(account, 0, t + HOUR + 1)).allowed).toBe(true);
  });

  it("frees slots one by one as they age out", async () => {
    const t = Date.now();
    await fill(300, t);
    await fill(RATE_LIMIT_MAX - 300, t + 20 * 60 * 1000);
    expect((await reserveDMSlot(account, 0, t + 40 * 60 * 1000)).allowed).toBe(false);
    // The first 300 are an hour old; the later batch still counts.
    for (let i = 0; i < 300; i++) expect((await reserveDMSlot(account, 0, t + HOUR + 1)).allowed).toBe(true);
    expect((await reserveDMSlot(account, 0, t + HOUR + 1)).allowed).toBe(false);
  });

  it("gives a slot back when the send did not happen", async () => {
    const t = Date.now();
    await fill(RATE_LIMIT_MAX, t);
    await releaseDMSlot(account);
    expect((await reserveDMSlot(account, 0, t + 1)).allowed).toBe(true);
    expect((await reserveDMSlot(account, 0, t + 2)).allowed).toBe(false);
  });

  it("runs concurrent reservations without overshooting the cap", async () => {
    const t = Date.now();
    const results = await Promise.all(Array.from({ length: RATE_LIMIT_MAX + 50 }, () => reserveDMSlot(account, 0, t)));
    expect(results.filter((r) => r.allowed)).toHaveLength(RATE_LIMIT_MAX);
  });
});
