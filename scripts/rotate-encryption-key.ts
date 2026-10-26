/**
 * Re-encrypts every stored secret with the current ENCRYPTION_KEY.
 *
 *   1. Put the old key in ENCRYPTION_KEY_PREVIOUS and the new one in ENCRYPTION_KEY
 *   2. Restart: the app now reads with either key and writes with the new one
 *   3. docker compose exec web npm run keys:rotate           (shows what would change)
 *      docker compose exec web npm run keys:rotate -- --apply
 *   4. When it reports nothing left on an old key, remove ENCRYPTION_KEY_PREVIOUS
 *
 * Back up the database and both keys first. A value that no key can read is
 * reported and left as it is; nothing is ever overwritten with a guess.
 */
import { existsSync } from "node:fs";
import { prisma } from "@/lib/db/client";
import { decryptTokenWithKeyInfo, encryptToken } from "@/lib/meta/oauth";

if (existsSync(".env")) process.loadEnvFile(".env");

type Field = { label: string; rows: () => Promise<{ id: string; value: string }[]>; save: (id: string, value: string) => Promise<unknown> };

const FIELDS: Field[] = [
  {
    label: "Instagram access tokens",
    rows: async () => (await prisma.instagramAccount.findMany({ where: { accessToken: { not: "" } }, select: { id: true, accessToken: true } })).map((r) => ({ id: r.id, value: r.accessToken })),
    save: (id, value) => prisma.instagramAccount.update({ where: { id }, data: { accessToken: value } }),
  },
  {
    label: "Zernio API keys",
    rows: async () => (await prisma.zernioConnection.findMany({ select: { workspaceId: true, apiKey: true } })).map((r) => ({ id: r.workspaceId, value: r.apiKey })),
    save: (id, value) => prisma.zernioConnection.update({ where: { workspaceId: id }, data: { apiKey: value } }),
  },
  {
    label: "Zernio webhook secrets",
    rows: async () => (await prisma.zernioConnection.findMany({ select: { workspaceId: true, webhookSecret: true } })).map((r) => ({ id: r.workspaceId, value: r.webhookSecret })),
    save: (id, value) => prisma.zernioConnection.update({ where: { workspaceId: id }, data: { webhookSecret: value } }),
  },
  {
    label: "AI assistant keys",
    rows: async () => (await prisma.aiAssistant.findMany({ where: { apiKey: { not: "" } }, select: { id: true, apiKey: true } })).map((r) => ({ id: r.id, value: r.apiKey })),
    save: (id, value) => prisma.aiAssistant.update({ where: { id }, data: { apiKey: value } }),
  },
  {
    label: "SMS panel keys",
    rows: async () => (await prisma.smsSettings.findMany({ where: { apiKey: { not: "" } }, select: { id: true, apiKey: true } })).map((r) => ({ id: r.id, value: r.apiKey })),
    save: (id, value) => prisma.smsSettings.update({ where: { id }, data: { apiKey: value } }),
  },
];

async function main() {
  const apply = process.argv.includes("--apply");
  let unreadable = 0;
  let onOldKey = 0;
  for (const field of FIELDS) {
    let current = 0;
    let old = 0;
    let bad = 0;
    for (const row of await field.rows()) {
      try {
        const { plaintext, previous } = decryptTokenWithKeyInfo(row.value);
        if (!previous) current++;
        else {
          old++;
          if (apply) await field.save(row.id, encryptToken(plaintext));
        }
      } catch {
        bad++;
      }
    }
    onOldKey += old;
    unreadable += bad;
    console.log(`${field.label}: ${current} on the current key, ${old} ${apply ? "re-encrypted" : "on an old key"}, ${bad} unreadable`);
  }
  if (!apply && onOldKey > 0) console.log("Nothing was changed. Run again with --apply to re-encrypt.");
  if (unreadable > 0) console.log("Unreadable values need the key they were written with in ENCRYPTION_KEY_PREVIOUS.");
  return unreadable > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
