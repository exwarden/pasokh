/**
 * A campaign is checked (daily cap, repeat guard, test mode) for the provider
 * it was created with. If the settings change afterwards, it must not be sent
 * through a different one: a campaign made in TEST mode skips the real-send
 * checks, and the key in the settings belongs to the new provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  prisma: {
    smsCampaign: { findUnique: vi.fn(), update: vi.fn() },
    smsSettings: { findUnique: vi.fn() },
    smsMessage: { findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(),
  },
  sendSms: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: m.prisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (v: string) => v }));
vi.mock("../lib/sms/providers", async (orig) => ({ ...(await orig<object>()), sendSms: m.sendSms }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}), getDmQueue: () => ({ add: vi.fn() }) }));

import { processSmsBatch } from "../lib/sms/campaigns";

beforeEach(() => {
  vi.clearAllMocks();
  m.prisma.smsMessage.findMany.mockResolvedValue([]);
  m.prisma.smsMessage.updateMany.mockResolvedValue({ count: 0 });
  m.prisma.smsCampaign.update.mockResolvedValue({});
});

describe("processing a campaign after the SMS settings changed", () => {
  it("stops a campaign created in TEST mode when the settings now point at a real provider", async () => {
    m.prisma.smsCampaign.findUnique.mockResolvedValue({ id: "c1", workspaceId: "w1", provider: "TEST", status: "QUEUED", message: "hi" });
    m.prisma.smsSettings.findUnique.mockResolvedValue({ provider: "KAVENEGAR", apiKey: "k", sender: "3000" });
    expect(await processSmsBatch("c1")).toBe("STOPPED");
    expect(m.sendSms).not.toHaveBeenCalled();
    expect(m.prisma.smsCampaign.update.mock.calls[0][0].data).toMatchObject({ status: "STOPPED" });
  });

  it("stops a real-provider campaign when the settings were switched to another provider", async () => {
    m.prisma.smsCampaign.findUnique.mockResolvedValue({ id: "c1", workspaceId: "w1", provider: "KAVENEGAR", status: "SENDING", message: "hi" });
    m.prisma.smsSettings.findUnique.mockResolvedValue({ provider: "SMSIR", apiKey: "k", sender: "3000" });
    expect(await processSmsBatch("c1")).toBe("STOPPED");
    expect(m.sendSms).not.toHaveBeenCalled();
  });

  it("goes on when the provider is the one the campaign was created with", async () => {
    m.prisma.smsCampaign.findUnique.mockResolvedValue({ id: "c1", workspaceId: "w1", provider: "KAVENEGAR", status: "SENDING", message: "hi" });
    m.prisma.smsSettings.findUnique.mockResolvedValue({ provider: "KAVENEGAR", apiKey: "k", sender: "3000" });
    m.prisma.smsMessage.count.mockResolvedValue(0);
    expect(await processSmsBatch("c1")).toBe("DONE");
  });
});
