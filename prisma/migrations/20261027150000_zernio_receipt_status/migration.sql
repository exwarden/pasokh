-- Receipt state machine. Rows that exist already were accepted and processed, so they start as ENQUEUED and are never reprocessed.
CREATE TYPE "ZernioReceiptStatus" AS ENUM ('CLAIMED', 'ENQUEUED');

ALTER TABLE "ZernioEventReceipt" ADD COLUMN "status" "ZernioReceiptStatus" NOT NULL DEFAULT 'ENQUEUED';
ALTER TABLE "ZernioEventReceipt" ADD COLUMN "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- New rows are CLAIMED until processing succeeds.
ALTER TABLE "ZernioEventReceipt" ALTER COLUMN "status" SET DEFAULT 'CLAIMED';
