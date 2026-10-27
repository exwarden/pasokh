/**
 * Rate Limiter — Unit Tests
 *
 * Tests the hourly private-reply cap enforcement using mocked Redis.
 * Assertions derive from RATE_LIMIT_MAX so they survive a change to the cap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGet, mockEval, mockDel, mockDecr, mockZcount, mockZpopmax, mockZcard } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockZcount: vi.fn(),
  mockZpopmax: vi.fn(),
  mockZcard: vi.fn(),
  mockEval: vi.fn(),
  mockDel: vi.fn(),
  mockDecr: vi.fn(),
}));

vi.mock("ioredis", () => {
  const MockRedis = vi.fn().mockImplementation(function (
    this: Record<string, unknown>
  ) {
    this.get = mockGet;
    this.eval = mockEval;
    this.del = mockDel;
    this.decr = mockDecr;
    this.zcount = mockZcount;
    this.zpopmax = mockZpopmax;
    this.zcard = mockZcard;
    return this;
  });
  return { default: MockRedis };
});

vi.stubEnv("REDIS_URL", "redis://localhost:6379");

import {
  checkRateLimit,
  incrementDMCounter,
  reserveDMSlot,
  releaseDMSlot,
  RATE_LIMIT_MAX,
} from "../lib/utils/rate-limiter";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkRateLimit", () => {
  it("should allow when count is below limit", async () => {
    mockZcount.mockResolvedValue(50);

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(50);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX - 50);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(false);
    expect(result.reserved).toBe(false);
  });

  it("should allow when no previous count exists", async () => {
    mockZcount.mockResolvedValue(0);

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX);
  });

  it("should deny when count reaches the limit", async () => {
    mockZcount.mockResolvedValue(RATE_LIMIT_MAX);

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockZcount.mockResolvedValue(RATE_LIMIT_MAX);

    const result = await checkRateLimit("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("reserveDMSlot", () => {
  it("should atomically reserve a slot when below the hourly cap", async () => {
    mockEval.mockResolvedValue([1, 51, 139]);

    const result = await reserveDMSlot("account_123");

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rate:dm:z:account_123",
      expect.any(Number),
      3600 * 1000,
      RATE_LIMIT_MAX,
      expect.stringMatching(/^\d+-[0-9a-f]{8}$/)
    );
    expect(result.allowed).toBe(true);
    expect(result.reserved).toBe(true);
    expect(result.currentCount).toBe(51);
    expect(result.remainingDMs).toBe(139);
  });

  it("should recommend requeue when the atomic reserve is denied", async () => {
    mockEval.mockResolvedValue([0, RATE_LIMIT_MAX, 0]);

    const result = await reserveDMSlot("account_123", 0);

    expect(result.allowed).toBe(false);
    expect(result.reserved).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockEval.mockResolvedValue(["0", String(RATE_LIMIT_MAX), "0"]);

    const result = await reserveDMSlot("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("incrementDMCounter", () => {
  it("should use the atomic reservation path", async () => {
    mockEval.mockResolvedValue([1, 51, 139]);

    const count = await incrementDMCounter("account_123");

    expect(mockEval).toHaveBeenCalled();
    expect(count).toBe(51);
  });
});

describe("releaseDMSlot", () => {
  it("hands the newest reservation back and returns the count that remains", async () => {
    mockZcard.mockResolvedValue(49);

    const count = await releaseDMSlot("account_123");

    expect(mockZpopmax).toHaveBeenCalledWith("rate:dm:z:account_123");
    expect(count).toBe(49);
  });

  it("is harmless when nothing was reserved", async () => {
    mockZcard.mockResolvedValue(0);
    expect(await releaseDMSlot("account_123")).toBe(0);
  });
});

describe("the cap", () => {
  it("is 600 an hour, below Meta's documented 750", () => {
    expect(RATE_LIMIT_MAX).toBe(600);
  });
});
