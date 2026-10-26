import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceMember: { findMany: vi.fn(), findFirst: vi.fn() },
    workspaceInvitation: { findMany: vi.fn(), upsert: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => "u1" }));

import { GET, POST } from "../app/api/workspace/members/route";
import { hashInvitationToken } from "../lib/workspace-invitations";

function context(role: "OWNER" | "ADMIN" | "MEMBER") {
  mockPrisma.workspaceMember.findFirst.mockResolvedValue({ workspaceId: "w1", role, workspace: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspaceMember.findMany.mockResolvedValue([]);
  mockPrisma.workspaceInvitation.findMany.mockResolvedValue([
    { id: "i1", email: "new@shop.ir", role: "ADMIN", expiresAt: new Date(), createdAt: new Date() },
  ]);
  mockPrisma.user.findUnique.mockResolvedValue(null);
});

describe("invitation links", () => {
  it("a plain member does not get the pending invitations, so cannot take over an invited address", async () => {
    context("MEMBER");
    const body = await (await GET()).json();
    expect(body.data.invitations).toEqual([]);
    expect(mockPrisma.workspaceInvitation.findMany).not.toHaveBeenCalled();
  });

  it("even an admin listing never carries a token or link", async () => {
    context("ADMIN");
    const body = await (await GET()).json();
    expect(body.data.invitations).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/token|inviteUrl|\/invite\//i);
    const select = mockPrisma.workspaceInvitation.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("tokenHash");
  });

  it("the link is returned once on creation and only its hash is stored", async () => {
    context("OWNER");
    const request = new Request("http://x", { method: "POST", body: JSON.stringify({ email: "New@Shop.ir", role: "MEMBER" }) });
    const body = await (await POST(request as never)).json();

    const link: string = body.data.newInvite.inviteUrl;
    const token = link.split("/invite/")[1];
    expect(token.length).toBeGreaterThan(16);

    const call = mockPrisma.workspaceInvitation.upsert.mock.calls[0][0];
    expect(call.create.tokenHash).toBe(hashInvitationToken(token));
    expect(call.update.tokenHash).toBe(hashInvitationToken(token));
    expect(JSON.stringify(call)).not.toContain(token);
  });
});
