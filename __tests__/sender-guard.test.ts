import { beforeEach, describe, expect, it, vi } from "vitest";

const r = vi.hoisted(() => {
  const store = new Map<string, number | string>();
  const events: unknown[] = [];
  const redis = {
    get: async (k: string) => (store.has(k) ? String(store.get(k)) : null),
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes("NX") && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
    multi() {
      const ops: Array<() => number> = [];
      const chain = {
        incr(k: string) {
          ops.push(() => {
            store.set(k, Number(store.get(k) ?? 0) + 1);
            return Number(store.get(k));
          });
          return chain;
        },
        expire() {
          ops.push(() => 1);
          return chain;
        },
        exec: async () => ops.map((op) => [null, op()]),
      };
      return chain;
    },
  };
  return { store, events, redis };
});
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => r.redis }));
vi.mock("@/lib/ops/events", () => ({ recordEvent: async (e: unknown) => void r.events.push(e) }));

import { checkSender, senderLimits } from "../lib/automation/sender-guard";

let n = 0;
const send = (sender = "s1") => checkSender({ instagramId: "ig", senderId: sender, messageId: `m${++n}` });

beforeEach(() => {
  r.store.clear();
  r.events.length = 0;
  delete process.env.AUTO_REPLIES_PER_SENDER_PER_HOUR;
  delete process.env.LOOP_MESSAGES_PER_MINUTE;
});

describe("automatic replies to one sender", () => {
  it("answers an ordinary conversation", async () => {
    for (let i = 0; i < 10; i++) expect(await send()).toBe("allow");
  });

  it("stops after the hourly cap, which is 20 by default and can be set", async () => {
    process.env.LOOP_MESSAGES_PER_MINUTE = "1000";
    for (let i = 0; i < 20; i++) expect(await send()).toBe("allow");
    expect(await send()).toBe("over_hourly_cap");
    expect(await send("other")).toBe("allow");

    r.store.clear();
    process.env.AUTO_REPLIES_PER_SENDER_PER_HOUR = "3";
    process.env.LOOP_MESSAGES_PER_MINUTE = "1000";
    for (let i = 0; i < 3; i++) expect(await send()).toBe("allow");
    expect(await send()).toBe("over_hourly_cap");
  });

  it("treats more than 10 messages in a minute as a loop, pauses that sender, and says so once", async () => {
    for (let i = 0; i < 10; i++) expect(await send("bot")).toBe("allow");
    expect(await send("bot")).toBe("loop_paused");
    expect(await send("bot")).toBe("loop_paused");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ level: "WARNING", message: "Automatic replies to a sender were paused" });
    expect(await send("a-person")).toBe("allow");
  });

  it("counts a retried job once", async () => {
    process.env.AUTO_REPLIES_PER_SENDER_PER_HOUR = "2";
    process.env.LOOP_MESSAGES_PER_MINUTE = "1000";
    for (let i = 0; i < 6; i++) expect(await checkSender({ instagramId: "ig", senderId: "s", messageId: "same" })).toBe("allow");
  });

  it("lets messages through when Redis is down or slow, rather than going silent", async () => {
    const failing = r.redis.get;
    r.redis.get = async () => {
      throw new Error("down");
    };
    expect(await send()).toBe("allow");
    r.redis.get = () => new Promise(() => {});
    const started = Date.now();
    expect(await send()).toBe("allow");
    expect(Date.now() - started).toBeLessThan(2000);
    r.redis.get = failing;
  });

  it("reads limits from the environment and ignores nonsense", () => {
    expect(senderLimits({})).toEqual({ perHour: 20, loopPerMinute: 10 });
    expect(senderLimits({ AUTO_REPLIES_PER_SENDER_PER_HOUR: "5", LOOP_MESSAGES_PER_MINUTE: "x" })).toEqual({ perHour: 5, loopPerMinute: 10 });
  });
});
