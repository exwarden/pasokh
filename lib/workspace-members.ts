import type { Prisma, WorkspaceRole } from "@/app/generated/prisma/client";

type MemberDb = Pick<Prisma.TransactionClient, "workspaceMember">;

/**
 * Add a user to a workspace, or change the role they already have, without
 * ever touching an OWNER. Invitations, "add existing user" and accept all go
 * through here, so an admin cannot demote the owner by inviting their address.
 * The role update is conditional in SQL (`role <> OWNER`), not read-then-write.
 */
export async function grantWorkspaceRole(
  db: MemberDb,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole
): Promise<void> {
  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, role },
    update: {},
  });
  await db.workspaceMember.updateMany({
    where: { workspaceId, userId, role: { not: "OWNER" } },
    data: { role },
  });
}
