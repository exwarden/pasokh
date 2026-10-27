import { lookup, type LookupOptions } from "node:dns";
import https from "node:https";
import { checkPublicHttpsUrl, isPrivateAddress, UnsafeUrlError } from "./safe-url";

/** The answer was bigger than we are willing to read. */
export class ResponseTooLargeError extends Error {
  name = "ResponseTooLargeError";
}

/** An AI gateway answers with a few kilobytes; a megabyte is far more than any real answer. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

type LookupCallback = (error: Error | null, address?: string | { address: string; family: number }[], family?: number) => void;

/**
 * The name lookup the socket uses to connect. It is the only place the name is
 * resolved for the request, and it refuses private answers, so the address that
 * was checked is the address that is connected to. A separate "check, then
 * fetch" resolves twice, and a DNS server can answer differently the second time.
 */
export function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = addresses as unknown as { address: string; family: number }[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new UnsafeUrlError("The address points at a private network."));
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export type PostResult = { status: number; headers: Record<string, string | string[] | undefined>; text: string };

/**
 * POST a JSON body to a public https address and read the answer, up to
 * MAX_RESPONSE_BYTES. Redirects are not followed (the status is returned as is).
 */
export async function postJson(
  rawUrl: string,
  headers: Record<string, string>,
  body: unknown,
  { timeoutMs = 45_000, maxBytes = MAX_RESPONSE_BYTES }: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<PostResult> {
  const url = checkPublicHttpsUrl(rawUrl);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise<PostResult>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(payload.length), ...headers },
        lookup: publicLookup as never,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            reject(new ResponseTooLargeError(`The answer is larger than ${maxBytes} bytes.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error(`No answer within ${timeoutMs} ms`)));
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}
