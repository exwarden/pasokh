import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    contact: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { saveAnswerToContact } from "../lib/forms/engine";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.contact.upsert.mockResolvedValue({});
});

describe("a form that saves a phone number to the contact", () => {
  it("takes back SMS consent given for the previous number", async () => {
    mockPrisma.contact.findUnique.mockResolvedValue({ phone: "09121111111" });
    await saveAnswerToContact("a1", "ig1", "phone", "09122222222");
    expect(mockPrisma.contact.upsert.mock.calls[0][0].update).toMatchObject({ phone: "09122222222", smsConsent: false, smsConsentAt: null, smsConsentSource: null });
  });

  it("keeps consent when the number is the same", async () => {
    mockPrisma.contact.findUnique.mockResolvedValue({ phone: "09121111111" });
    await saveAnswerToContact("a1", "ig1", "phone", "09121111111");
    expect(mockPrisma.contact.upsert.mock.calls[0][0].update).toEqual({ phone: "09121111111" });
  });

  it("does not touch consent when the answer is a name", async () => {
    await saveAnswerToContact("a1", "ig1", "name", "Ali");
    expect(mockPrisma.contact.upsert.mock.calls[0][0].update).toEqual({ name: "Ali" });
  });
});
