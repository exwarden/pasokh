/**
 * The OWNER role never moves through invite, add-member or accept. A tiny
 * in-memory workspaceMember table stands in for the database so the test sees
 * the final role, not just which calls were made.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Member = { id: string; workspaceId: string; userId: string; role: "OWNER" | "ADMIN" | "MEMBER" };
type Invitation = { id: string; workspaceId: string; email: string; role: "ADMIN" | "MEMBER"; status: string; tokenHash: string; expiresAt: Date };

const db = vi.hoisted(() => {
  const state = { members: [] as Member[], invitations: [] as Invitation[], actor: { userId: "admin1", role: "ADMIN" as string } };
  const matches = (m: Member, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const actual = (m as Record<string, unknown>)[k];
      if (v && typeof v === "object" && "not" in (v as object)) return actual !== (v as { not: unknown }).not;
      return actual === v;
    });
  const compound = (w: { workspaceId_userId?: { workspaceId: string; userId: string } } & Record<string, unknown>) =>
    w.workspaceId_userId ? { ...w.workspaceId_userId } : w;
  const prisma: Record<string, unknown> = {
    user: { findUnique: async ({ where }: { where: { email: string } }) => (where.email === "boss@shop.ir" ? { id: "owner1" } : null) },
    workspaceMember: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.userId === state.actor.userId && !where.id) {
          return { workspaceId: "w1", userId: state.actor.userId, role: state.actor.role, workspace: { id: "w1" } };
        }
        return state.members.find((m) => matches(m, where)) ?? null;
      },
      findUnique: async ({ where }: { where: never }) => state.members.find((m) => matches(m, compound(where))) ?? null,
      findMany: async () => state.members.map((m) => ({ ...m, createdAt: new Date(), user: { id: m.userId, email: "x", name: null } })),
      upsert: async ({ where, create, update }: { where: never; create: Omit<Member, "id">; update: Partial<Member> }) => {
        const found = state.members.find((m) => matches(m, compound(where)));
        if (found) return Object.assign(found, update);
        const row = { id: `m${state.members.length + 1}`, ...create };
        state.members.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Member> }) => {
        const rows = state.members.filter((m) => matches(m, compound(where as never)));
        rows.forEach((m) => Object.assign(m, data));
        return { count: rows.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Member> }) => {
        const row = state.members.find((m) => m.id === where.id)!;
        return Object.assign(row, data);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        state.members = state.members.filter((m) => m.id !== where.id);
      },
    },
    workspaceInvitation: {
      upsert: async () => ({}),
      findMany: async ({ where }: { where: { email?: string } }) => state.invitations.filter((i) => !where.email || i.email === where.email),
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const inv = state.invitations.find((i) => i.tokenHash === where.tokenHash);
        return inv ? { ...inv, workspace: { name: "W" } } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Invitation> }) =>
        Object.assign(state.invitations.find((i) => i.id === where.id)!, data),
      updateMany: async () => ({ count: 0 }),
    },
  };
  prisma.$transaction = async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]);
  return { state, prisma };
});

vi.mock("@/lib/db/client", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth", () => ({
  getCurrentUserId: async () => db.state.actor.userId,
  auth: async () => ({ user: { id: "owner1", email: "boss@shop.ir" } }),
}));

import { DELETE, PATCH, POST } from "../app/api/workspace/members/route";
import { POST as acceptRoute } from "../app/api/workspace/invitations/accept/route";
import { acceptPendingInvitationsForUser } from "../lib/workspace";
import { hashInvitationToken } from "../lib/workspace-invitations";

const req = (method: string, body: unknown) => new Request("http://x", { method, body: JSON.stringify(body) }) as never;
const roleOf = (userId: string) => db.state.members.find((m) => m.userId === userId)?.role;

beforeEach(() => {
  db.state.actor = { userId: "admin1", role: "ADMIN" };
  db.state.members = [
    { id: "m-owner", workspaceId: "w1", userId: "owner1", role: "OWNER" },
    { id: "m-admin", workspaceId: "w1", userId: "admin1", role: "ADMIN" },
  ];
  db.state.invitations = [];
});

describe("OWNER role is never changed by an admin", () => {
  it("inviting the owner's own address as MEMBER leaves the owner an OWNER", async () => {
    await POST(req("POST", { email: "boss@shop.ir", role: "MEMBER" }));
    expect(roleOf("owner1")).toBe("OWNER");
  });

  it("inviting the owner's own address as ADMIN leaves the owner an OWNER", async () => {
    await POST(req("POST", { email: "boss@shop.ir", role: "ADMIN" }));
    expect(roleOf("owner1")).toBe("OWNER");
  });

  it("an existing non-owner member can still be given a different role", async () => {
    db.state.members.push({ id: "m-m", workspaceId: "w1", userId: "owner1b", role: "MEMBER" });
    // the stand-in user table knows only the owner, so use the PATCH path for a plain member
    const res = await PATCH(req("PATCH", { memberId: "m-m", role: "ADMIN" }));
    expect(res.status).toBe(200);
    expect(roleOf("owner1b")).toBe("ADMIN");
  });

  it("PATCH on the owner is refused and the role stays", async () => {
    const res = await PATCH(req("PATCH", { memberId: "m-owner", role: "MEMBER" }));
    expect(res.status).toBe(400);
    expect(roleOf("owner1")).toBe("OWNER");
  });

  it("DELETE on the owner is refused and the member stays", async () => {
    const res = await DELETE(req("DELETE", { memberId: "m-owner" }));
    expect(res.status).toBe(400);
    expect(roleOf("owner1")).toBe("OWNER");
  });

  it("accepting an invitation sent to the owner's address does not demote the owner", async () => {
    db.state.invitations = [
      { id: "i1", workspaceId: "w1", email: "boss@shop.ir", role: "MEMBER", status: "PENDING", tokenHash: hashInvitationToken("tok"), expiresAt: new Date(Date.now() + 1e6) },
    ];
    const res = await acceptRoute(req("POST", { token: "tok" }));
    expect(res.status).toBe(200);
    expect(roleOf("owner1")).toBe("OWNER");
  });

  it("auto-accepting pending invitations on sign-in does not demote the owner", async () => {
    db.state.invitations = [
      { id: "i2", workspaceId: "w1", email: "boss@shop.ir", role: "MEMBER", status: "PENDING", tokenHash: "h", expiresAt: new Date(Date.now() + 1e6) },
    ];
    await acceptPendingInvitationsForUser("owner1", "boss@shop.ir");
    expect(roleOf("owner1")).toBe("OWNER");
  });
});
