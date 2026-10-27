-- Bumped on every password change; a sign-in token carrying an older number is signed out.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
