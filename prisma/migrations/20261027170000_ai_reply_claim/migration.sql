-- Lets a retry tell a live AI reply claim from one whose process died, and counts model calls per reply.
ALTER TABLE "AiReply" ADD COLUMN "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "AiReply" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1;
