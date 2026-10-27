/**
 * A plain member may read the SMS panel (settings, campaigns) but must never
 * get the provider's API key back, encrypted or not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceMember: { findFirst: vi.fn() },
    smsSettings: { findUnique: vi.fn() },
    smsCampaign: { findMany: vi.fn() },
    smsMessage: { groupBy: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => "u1" }));

import { GET as getSettings } from "../app/api/sms/settings/route";
import { GET as getCampaigns } from "../app/api/sms/campaigns/route";

const KEY = "enc:v1:SUPER-SECRET-PANEL-KEY";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspaceMember.findFirst.mockResolvedValue({ workspaceId: "w1", role: "MEMBER", workspace: {} });
  mockPrisma.smsSettings.findUnique.mockResolvedValue({ id: "s1", workspaceId: "w1", provider: "KAVENEGAR", apiKey: KEY, sender: "3000123" });
  mockPrisma.smsCampaign.findMany.mockResolvedValue([
    { id: "c1", workspaceId: "w1", name: "n", message: "m", provider: "KAVENEGAR", filter: {}, status: "DONE", stopReason: null, messageHash: "h", createdAt: new Date() },
  ]);
  mockPrisma.smsMessage.groupBy.mockResolvedValue([]);
});

describe("what a member reads from the SMS panel", () => {
  it("settings: the provider, the sender line and whether a key exists, never the key", async () => {
    const body = await (await getSettings()).json();
    expect(body).toEqual({ settings: { provider: "KAVENEGAR", sender: "3000123", hasKey: true } });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("campaigns: no credential of any kind", async () => {
    const text = JSON.stringify(await (await getCampaigns()).json());
    expect(text).not.toContain("SECRET");
    expect(text).not.toMatch(/apiKey/i);
    // the campaign query never touches the settings table
    expect(mockPrisma.smsSettings.findUnique).not.toHaveBeenCalled();
  });
});
