import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(__dirname, "..", "fixtures", "zernio");

/** The seven sanitized real-world payloads, in capture order (1-based, as in docs/ZERNIO_INGESTION.fa.md). */
export const FIXTURE = {
  messageText: 1,
  messageImage: 2,
  commentCustomer: 3,
  commentKeyword: 4,
  sentHuman: 5,
  commentOwnReply: 6,
  sentHumanShort: 7,
} as const;

export function fixtureBody(n: number): string {
  const file = readdirSync(DIR).find((f) => f.startsWith(String(n).padStart(2, "0") + "-"));
  if (!file) throw new Error(`no zernio fixture ${n}`);
  return readFileSync(path.join(DIR, file), "utf8");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture(n: number): Record<string, any> {
  return JSON.parse(fixtureBody(n));
}

export const FAKE_SECRET = "fixture-secret-not-a-real-one";

export function sign(body: string | Uint8Array, secret = FAKE_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Headers as Zernio sends them: x-zernio-* and the identical legacy x-late-* set. */
export function zernioHeaders(
  body: string,
  { prefixes = ["x-zernio", "x-late"], signature = sign(body) }: { prefixes?: string[]; signature?: string | null } = {},
) {
  const parsed = JSON.parse(body) as { id: string; event: string };
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Zernio-Webhooks/1.0" };
  for (const p of prefixes) {
    if (signature) headers[`${p}-signature`] = signature;
    headers[`${p}-event-id`] = parsed.id;
    headers[`${p}-event`] = parsed.event;
  }
  return headers;
}
