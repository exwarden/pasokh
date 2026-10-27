import { describe, expect, it, vi, beforeEach } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { dmLog: { findFirst } } }));

import { commentDmCooldownMs, findRecentDmToCommenter } from "@/lib/automation/comment-cooldown";

describe("commentDmCooldownMs", () => {
  it("defaults to 24 hours", () => {
    expect(commentDmCooldownMs({})).toBe(24 * 3_600_000);
  });

  it("reads COMMENT_DM_COOLDOWN_HOURS, fractions included", () => {
    expect(commentDmCooldownMs({ COMMENT_DM_COOLDOWN_HOURS: "6" })).toBe(6 * 3_600_000);
    expect(commentDmCooldownMs({ COMMENT_DM_COOLDOWN_HOURS: "0.5" })).toBe(1_800_000);
  });

  it("0 turns the cooldown off", () => {
    expect(commentDmCooldownMs({ COMMENT_DM_COOLDOWN_HOURS: "0" })).toBe(0);
  });

  it("falls back to the default for junk and negative values", () => {
    for (const value of ["", "abc", "-3", "NaN", "Infinity"]) {
      expect(commentDmCooldownMs({ COMMENT_DM_COOLDOWN_HOURS: value })).toBe(24 * 3_600_000);
    }
  });
});

describe("findRecentDmToCommenter", () => {
  beforeEach(() => findFirst.mockReset());

  it("looks for a DM this campaign already delivered to this person inside the window, on another comment", async () => {
    findFirst.mockResolvedValue({ dmSentAt: new Date("2026-10-27T10:00:00Z") });
    const now = new Date("2026-10-27T12:00:00Z");

    const hit = await findRecentDmToCommenter(
      { automationId: "a1", commenterId: "u1", commentId: "c2", cooldownMs: 24 * 3_600_000 },
      now,
    );

    expect(hit).toEqual({ dmSentAt: new Date("2026-10-27T10:00:00Z") });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          automationId: "a1",
          commenterId: "u1",
          status: "SENT",
          commentId: { not: "c2" },
          dmSentAt: { gte: new Date("2026-10-26T12:00:00Z") },
        },
      }),
    );
  });

  it("returns null when nothing matches", async () => {
    findFirst.mockResolvedValue(null);
    expect(
      await findRecentDmToCommenter({ automationId: "a1", commenterId: "u1", commentId: "c2", cooldownMs: 3_600_000 }),
    ).toBeNull();
  });

  it("does not query at all when the cooldown is off", async () => {
    expect(
      await findRecentDmToCommenter({ automationId: "a1", commenterId: "u1", commentId: "c2", cooldownMs: 0 }),
    ).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
