import { createHash, randomBytes } from "node:crypto";
import { clientIpFromHeaders } from "@/lib/net/client-ip";

export function generateTrackedLinkSlug() {
  return randomBytes(7).toString("base64url");
}

export function hashClickIp(ipAddress: string | null | undefined) {
  if (!ipAddress) return null;

  const salt = process.env.NEXTAUTH_SECRET ?? "campaigncue-click-salt";
  return createHash("sha256").update(`${salt}:${ipAddress}`).digest("hex");
}

export function getRequestIp(request: Request) {
  return clientIpFromHeaders(request.headers);
}
