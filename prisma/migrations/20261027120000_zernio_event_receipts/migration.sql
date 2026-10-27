-- Dedupe of redelivered Zernio webhook events, and metadata of outgoing messages (message.sent).
CREATE TABLE "ZernioEventReceipt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZernioEventReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ZernioSentMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platformMessageId" TEXT NOT NULL,
    "sentVia" TEXT,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZernioSentMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZernioEventReceipt_workspaceId_eventId_key" ON "ZernioEventReceipt"("workspaceId", "eventId");
CREATE INDEX "ZernioEventReceipt_createdAt_idx" ON "ZernioEventReceipt"("createdAt");
CREATE UNIQUE INDEX "ZernioSentMessage_workspaceId_platformMessageId_key" ON "ZernioSentMessage"("workspaceId", "platformMessageId");
CREATE INDEX "ZernioSentMessage_createdAt_idx" ON "ZernioSentMessage"("createdAt");
