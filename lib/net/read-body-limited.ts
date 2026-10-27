/**
 * Reading a webhook body that cannot grow without bound.
 *
 * Webhook routes are public and read the whole body before the signature can be
 * checked (the signature covers all of it). WEBHOOK_MAX_BODY_BYTES (default
 * 256 KiB, about a hundred times a real Zernio event) caps that. Content-Length
 * is only a hint, since it may be absent (chunked) or wrong, so the bytes
 * actually read are counted too and the read stops at the cap.
 */
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export function webhookMaxBodyBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.WEBHOOK_MAX_BODY_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body is larger than ${limit} bytes`);
  }
}

export async function readBodyLimited(request: Request, limit: number = webhookMaxBodyBytes()): Promise<Buffer> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    // Refused before reading; free the connection instead of leaving the body unread.
    await request.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(limit);
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
