-- Invitation tokens are stored hashed. Existing pending invitations keep
-- working: their link carries the old token, whose hash is computed here.
ALTER TABLE "WorkspaceInvitation" ADD COLUMN "tokenHash" TEXT;
UPDATE "WorkspaceInvitation" SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex');
ALTER TABLE "WorkspaceInvitation" ALTER COLUMN "tokenHash" SET NOT NULL;
DROP INDEX "WorkspaceInvitation_token_key";
ALTER TABLE "WorkspaceInvitation" DROP COLUMN "token";
CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation"("tokenHash");
