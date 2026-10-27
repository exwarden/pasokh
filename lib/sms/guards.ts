import { createHash, randomBytes } from "node:crypto";
import { getRedisConnection } from "@/lib/queue/client";

/**
 * Limits that keep one wrong click from becoming a mass send. Both are per
 * workspace and can be changed in .env.
 *
 *   SMS_MAX_RECIPIENTS          most numbers in one send         (default 200)
 *   SMS_MAX_RECIPIENTS_PER_DAY  most numbers across 24 hours     (default 500)
 */
export const SMS_DEFAULT_MAX_RECIPIENTS = 200;
export const SMS_DEFAULT_MAX_RECIPIENTS_PER_DAY = 500;
export const SMS_PREVIEW_TTL_SECONDS = 10 * 60;
export const SMS_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function smsLimits() {
  return {
    perCampaign: positiveInt(process.env.SMS_MAX_RECIPIENTS, SMS_DEFAULT_MAX_RECIPIENTS),
    perDay: positiveInt(process.env.SMS_MAX_RECIPIENTS_PER_DAY, SMS_DEFAULT_MAX_RECIPIENTS_PER_DAY),
  };
}

/** The same text typed twice hashes the same: spacing and Unicode forms are ignored. */
export function hashSmsMessage(message: string): string {
  const normalised = message.normalize("NFKC").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised).digest("hex");
}

/** Identifies an exact set of numbers, whatever order they came in. */
export function fingerprintPhones(phones: readonly string[]): string {
  return createHash("sha256").update([...phones].sort().join(",")).digest("hex");
}

/** Messages are translation keys: the dashboard shows them in either language. */
export const SMS_GUARD_MESSAGES = [
  "No contact with a phone number and SMS consent matches this filter.",
  "Too many recipients for one send. Narrow the filter, for example with a tag.",
  "This message was already sent in the last 24 hours.",
  "The daily SMS limit would be exceeded.",
  "Preview this send first, then confirm it.",
  "The preview expired or was already used. Preview again.",
  "The recipients or the text changed since the preview. Preview again.",
] as const;
export type SmsGuardMessage = (typeof SMS_GUARD_MESSAGES)[number];

export class SmsGuardError extends Error {
  name = "SmsGuardError";
  constructor(message: SmsGuardMessage) {
    super(message);
  }
}

type PreviewClaim = { workspaceId: string; messageHash: string; recipients: string; count: number };

const previewKey = (token: string) => `sms_preview:${token}`;

/** A one-time permission to send exactly what was previewed. */
export async function issuePreviewToken(claim: PreviewClaim): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await getRedisConnection().set(previewKey(token), JSON.stringify(claim), "EX", SMS_PREVIEW_TTL_SECONDS);
  return token;
}

/**
 * Takes the token: it works once. GETDEL is atomic, so two requests carrying
 * the same token (a double click, a retry) cannot both pass.
 */
export async function consumePreviewToken(token: string | undefined, expected: PreviewClaim): Promise<void> {
  if (!token) throw new SmsGuardError("Preview this send first, then confirm it.");
  const raw = await getRedisConnection().getdel(previewKey(token));
  if (!raw) throw new SmsGuardError("The preview expired or was already used. Preview again.");
  const claim = JSON.parse(raw) as PreviewClaim;
  if (
    claim.workspaceId !== expected.workspaceId ||
    claim.messageHash !== expected.messageHash ||
    claim.recipients !== expected.recipients ||
    claim.count !== expected.count
  ) {
    throw new SmsGuardError("The recipients or the text changed since the preview. Preview again.");
  }
}

/** 09123456789 → 0912•••6789: enough to recognise a number, not to copy it. */
export function maskPhone(phone: string): string {
  return phone.length <= 7 ? phone : `${phone.slice(0, 4)}•••${phone.slice(-4)}`;
}
