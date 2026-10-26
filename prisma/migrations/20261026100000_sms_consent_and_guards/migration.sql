-- Contacts start without SMS consent; only an explicit answer or the owner sets it.
ALTER TABLE "Contact"
  ADD COLUMN "smsConsent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "smsConsentAt" TIMESTAMP(3),
  ADD COLUMN "smsConsentSource" TEXT;

ALTER TABLE "SmsCampaign" ADD COLUMN "messageHash" TEXT;
CREATE INDEX "SmsCampaign_workspaceId_messageHash_createdAt_idx" ON "SmsCampaign"("workspaceId", "messageHash", "createdAt");
