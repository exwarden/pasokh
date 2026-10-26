import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceMember: { findFirst: vi.fn() },
    contact: { findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => "u1" }));

import { PATCH } from "../app/api/contacts/[id]/route";

const patch = (body: unknown) =>
  PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: "c1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.contact.findFirst.mockResolvedValue({ id: "c1", smsConsent: false });
  mockPrisma.contact.update.mockImplementation(async ({ data }: { data: unknown }) => data);
});

describe("recording SMS consent by hand", () => {
  it("a plain member cannot mark someone as having agreed to SMS", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ workspaceId: "w1", role: "MEMBER", workspace: {} });
    const response = await patch({ smsConsent: true });
    expect(response.status).toBe(403);
    expect(mockPrisma.contact.update).not.toHaveBeenCalled();
  });

  it("a member can still edit the contact's other fields", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ workspaceId: "w1", role: "MEMBER", workspace: {} });
    expect((await patch({ name: "علی", smsConsent: false })).status).toBe(200);
  });

  it("an admin's change is stored with the time and who made it", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({ workspaceId: "w1", role: "ADMIN", workspace: {} });
    expect((await patch({ smsConsent: true })).status).toBe(200);
    expect(mockPrisma.contact.update.mock.calls[0][0].data).toMatchObject({ smsConsent: true, smsConsentSource: "manual:u1", smsConsentAt: expect.any(Date) });
  });
});
