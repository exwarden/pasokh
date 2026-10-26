import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt from node:crypto, so password sign-in adds no native dependency to
// the image. N=2^15 costs ~30 ms per attempt on a small VPS: noticeable to a
// brute-forcer, not to a person signing in.
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs 128 * N * r bytes; Node's default cap (32 MiB) is exactly that
// for these parameters, so raise it with headroom rather than sit on the edge.
const MAX_MEMORY = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

// Each derivation holds ~32 MiB while it runs, and sign-in is reachable by
// anyone. A burst of attempts must wait its turn instead of exhausting a small
// server's memory.
const MAX_CONCURRENT_DERIVATIONS = 4;
let running = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT_DERIVATIONS) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // the slot passes straight to the next waiter
  else running--;
}

async function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  await acquire();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password.normalize("NFKC"), salt, keyLength, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) =>
        error ? reject(error) : resolve(key),
      );
    });
  } finally {
    release();
  }
}

/** Stored as `scrypt$N$r$p$salt$hash` (base64) so parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger)) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (expected.length === 0) return false;
  const actual = await derive(password, salt, n, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}

/** Returns a translation key describing the problem, or null if acceptable. */
export function passwordProblem(password: string): "Password must be at least 8 characters." | "Password is too long." | null {
  if (password.length < MIN_PASSWORD_LENGTH) return "Password must be at least 8 characters.";
  if (password.length > MAX_PASSWORD_LENGTH) return "Password is too long.";
  return null;
}
