/**
 * The attempt is counted before the password is checked, in one atomic
 * increment. Counting after the check lets a burst of parallel guesses all
 * read "not throttled" and all get verified.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => {
  const store = new Map<string, number>();
  const multi = () => {
    const ops: Array<() => number | null> = [];
    const chain = {
      incr(key: string) {
        ops.push(() => {
          store.set(key, (store.get(key) ?? 0) + 1);
          return store.get(key)!;
        });
        return chain;
      },
      decr(key: string) {
        ops.push(() => {
          store.set(key, (store.get(key) ?? 0) - 1);
          return store.get(key)!;
        });
        return chain;
      },
      expire() {
        ops.push(() => 1);
        return chain;
      },
      async exec() {
        await new Promise((r) => setTimeout(r, 1)); // yield, as a network round trip does
        return ops.map((op) => [null, op()]);
      },
    };
    return chain;
  };
  return {
    store,
    client: {
      get: async (key: string) => (store.has(key) ? String(store.get(key)) : null),
      del: async (key: string) => store.delete(key),
      decr: async (key: string) => store.set(key, (store.get(key) ?? 0) - 1).get(key),
      multi,
    },
  };
});
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redis.client }));

const verify = vi.hoisted(() => ({ calls: 0, result: false }));
vi.mock("../lib/users/password", async (importActual) => ({
  ...(await importActual<typeof import("../lib/users/password")>()),
  verifyPassword: async () => (verify.calls++, verify.result),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: { user: { findUnique: async () => ({ id: "u1", email: "a@b.ir", name: null, passwordHash: "x", sessionVersion: 0 }) } },
}));
vi.mock("@/lib/workspace", () => ({ ensureWorkspaceForUser: vi.fn() }));

import { checkCredentials } from "../lib/users/accounts";

beforeEach(() => {
  redis.store.clear();
  verify.calls = 0;
  verify.result = false;
});

describe("sign-in throttle under parallel guesses", () => {
  it("lets at most five passwords from one address be verified out of fifty at once", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => checkCredentials("a@b.ir", "guess", "1.2.3.4")));
    expect(verify.calls).toBeLessThanOrEqual(5);
    expect(results.filter((r) => !r.ok && r.reason === "throttled").length).toBeGreaterThanOrEqual(45);
  });

  it("a right password still gets in and clears the email's counters", async () => {
    verify.result = true;
    const result = await checkCredentials("a@b.ir", "right", "1.2.3.4");
    expect(result.ok).toBe(true);
    expect(redis.store.get("login_fail:email:a@b.ir") ?? 0).toBe(0);
    expect(redis.store.get("login_fail:ip:1.2.3.4") ?? 0).toBe(0);
  });
});
