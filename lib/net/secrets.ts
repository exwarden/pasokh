import { createHash, timingSafeEqual } from "node:crypto";

/** Compares two secrets in constant time, whatever their lengths. */
export function secretsMatch(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
