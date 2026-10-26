import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_SETUP_TOKEN_LENGTH = 16;

/**
 * The first-run page creates the owner for whoever reaches it first, so it is
 * closed unless the operator proved access to the server by putting
 * SETUP_TOKEN in .env. Too short a value counts as unset.
 */
export function configuredSetupToken(): string | null {
  const value = process.env.SETUP_TOKEN?.trim() ?? "";
  return value.length >= MIN_SETUP_TOKEN_LENGTH ? value : null;
}

export function isSetupEnabled(): boolean {
  return configuredSetupToken() !== null;
}

/** Constant-time comparison; false when setup is not enabled. */
export function setupTokenMatches(given: string | null | undefined): boolean {
  const expected = configuredSetupToken();
  if (!expected || !given) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(given.trim()), digest(expected));
}
