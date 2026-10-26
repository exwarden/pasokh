import { secretsMatch } from "./secrets";

const MIN_CRON_SECRET_LENGTH = 16;

/**
 * The cron routes are reachable from the internet like every other route, so
 * they answer only to CRON_SECRET as a Bearer token. No other secret is a
 * fallback (a leaked cron token must not open sign-in), and with the secret
 * unset or short every request is refused rather than "Bearer undefined"
 * being accepted.
 */
export function isAuthorizedCronRequest(request: Request, secret: string | undefined = process.env.CRON_SECRET): boolean {
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") && secretsMatch(header.slice("Bearer ".length), secret);
}
