import { prisma } from "@/lib/db/client";

/**
 * How long operational data is kept. Webhook payloads and AI questions hold
 * customers' own words, and none of these tables is read after the first weeks,
 * so they are pruned instead of growing for ever. Contacts are not touched.
 * Each period can be changed in .env; 0 turns pruning of that table off.
 */
export const RETENTION = [
  { table: "webhookEvent", env: "WEBHOOK_EVENT_RETENTION_DAYS", days: 90 },
  { table: "dmLog", env: "DM_LOG_RETENTION_DAYS", days: 180 },
  { table: "operationalEvent", env: "OPERATIONAL_EVENT_RETENTION_DAYS", days: 90 },
  { table: "aiReply", env: "AI_REPLY_RETENTION_DAYS", days: 180 },
] as const;

type Table = (typeof RETENTION)[number]["table"];

const BATCH = 2000;
/** Per table and run: a large backlog drains over a few days instead of in one long delete. */
const MAX_BATCHES = 25;

export function retentionDays(entry: (typeof RETENTION)[number], env: Record<string, string | undefined> = process.env): number {
  const raw = env[entry.env];
  if (raw === undefined || raw === "") return entry.days;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : entry.days;
}

export async function runRetention(now = new Date(), env: Record<string, string | undefined> = process.env): Promise<Record<Table, number>> {
  const deleted = { webhookEvent: 0, dmLog: 0, operationalEvent: 0, aiReply: 0 } as Record<Table, number>;
  for (const entry of RETENTION) {
    const days = retentionDays(entry, env);
    if (days === 0) continue;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    // Typed loosely on purpose: the four models share only the two fields used here.
    const model = prisma[entry.table] as unknown as {
      findMany(args: unknown): Promise<{ id: string }[]>;
      deleteMany(args: unknown): Promise<{ count: number }>;
    };
    for (let i = 0; i < MAX_BATCHES; i++) {
      const rows = await model.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: BATCH });
      if (rows.length === 0) break;
      const { count } = await model.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      deleted[entry.table] += count;
      if (rows.length < BATCH) break;
    }
  }
  return deleted;
}
