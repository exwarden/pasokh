-- Serves the per-commenter cooldown lookup: one campaign, one person, recent SENT rows.
CREATE INDEX "DmLog_automationId_commenterId_idx" ON "DmLog"("automationId", "commenterId");
