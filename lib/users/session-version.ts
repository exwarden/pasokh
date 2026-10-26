/**
 * Sign-in tokens are JWTs that live 30 days and are checked against the
 * database only for the user's existence. A per-user counter closes the gap:
 * changing a password bumps it, and a token issued before that no longer
 * matches, so a stolen session does not survive the owner fixing the password.
 * Tokens from before the counter existed carry none, which counts as 0.
 */
export function isSessionCurrent(tokenVersion: unknown, userVersion: number): boolean {
  const issued = typeof tokenVersion === "number" ? tokenVersion : 0;
  return issued === userVersion;
}
