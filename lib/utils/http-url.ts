import { z } from "zod";

/** True only for a full http(s) address: `javascript:`, `data:`, `ftp:` and the like are not links to send people to. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export const httpUrlSchema = z
  .string()
  .max(2000)
  .refine(isHttpUrl, { message: "Enter a full web address starting with https:// or http://." });
