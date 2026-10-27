import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ processed: vi.fn(async () => undefined) }));
vi.mock("@/lib/queue/process-webhook", () => ({ processInstagramWebhook: m.processed }));
vi.mock("@/lib/ops/webhook-alerts", () => ({ noteBadWebhookSignature: async () => undefined }));

import { POST } from "../app/api/webhook/route";
import { BodyTooLargeError, readBodyLimited, webhookMaxBodyBytes } from "../lib/net/read-body-limited";

const URL_ = "http://localhost/api/webhook";
const LIMIT = 1024;

/** A body delivered as a stream, so the request carries no Content-Length. */
function streamOf(size: number, chunk = 100): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close();
      const n = Math.min(chunk, size - sent);
      controller.enqueue(new Uint8Array(n).fill(97));
      sent += n;
    },
  });
}
const streamed = (size: number, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: "POST", headers, body: streamOf(size), duplex: "half" } as RequestInit);

describe("readBodyLimited", () => {
  it("reads a body under the limit, with or without Content-Length", async () => {
    expect((await readBodyLimited(new Request(URL_, { method: "POST", body: "hello" }), LIMIT)).toString()).toBe("hello");
    expect((await readBodyLimited(streamed(500), LIMIT)).length).toBe(500);
    expect((await readBodyLimited(new Request(URL_, { method: "POST" }), LIMIT)).length).toBe(0);
  });

  it("accepts a body of exactly the limit and refuses one byte more", async () => {
    expect((await readBodyLimited(streamed(LIMIT), LIMIT)).length).toBe(LIMIT);
    await expect(readBodyLimited(streamed(LIMIT + 1), LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("refuses on Content-Length alone, before reading anything", async () => {
    const pull = vi.fn();
    const body = new ReadableStream({ pull });
    const request = new Request(URL_, { method: "POST", headers: { "content-length": String(LIMIT + 1) }, body, duplex: "half" } as RequestInit);
    await expect(readBodyLimited(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pull).not.toHaveBeenCalled();
  });

  it("stops a stream with no Content-Length at the limit instead of reading it all", async () => {
    const produced = { bytes: 0 };
    const body = new ReadableStream({
      pull(controller) {
        produced.bytes += 100;
        controller.enqueue(new Uint8Array(100));
      },
    });
    const request = new Request(URL_, { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(readBodyLimited(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(produced.bytes).toBeLessThan(LIMIT + 1000);
  });

  it("stops a body that is larger than its Content-Length claims", async () => {
    await expect(readBodyLimited(streamed(LIMIT * 10, { "content-length": "10" }), LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("defaults to 256 KiB and reads WEBHOOK_MAX_BODY_BYTES", () => {
    expect(webhookMaxBodyBytes({})).toBe(256 * 1024);
    expect(webhookMaxBodyBytes({ WEBHOOK_MAX_BODY_BYTES: "1000" })).toBe(1000);
    for (const junk of ["", "abc", "-1", "0", "1.5"]) expect(webhookMaxBodyBytes({ WEBHOOK_MAX_BODY_BYTES: junk })).toBe(256 * 1024);
  });
});

describe("Meta webhook route", () => {
  beforeEach(() => {
    m.processed.mockClear();
    vi.stubEnv("FACEBOOK_APP_SECRET", "meta-test-secret");
  });

  const signed = (body: string) => ({ "x-hub-signature-256": "sha256=" + createHmac("sha256", "meta-test-secret").update(body).digest("hex") });

  it("accepts a small signed body", async () => {
    const body = JSON.stringify({ object: "instagram", entry: [] });
    const res = await POST(new Request(URL_, { method: "POST", headers: signed(body), body }) as never);
    expect(res.status).toBe(200);
    expect(m.processed).toHaveBeenCalledTimes(1);
  });

  it("answers 413 for a body over the cap, declared or streamed, without processing it", async () => {
    vi.stubEnv("WEBHOOK_MAX_BODY_BYTES", String(LIMIT));
    const big = "a".repeat(LIMIT + 1);
    const declared = await POST(new Request(URL_, { method: "POST", body: big }) as never);
    const chunked = await POST(streamed(LIMIT + 1) as never);
    expect(declared.status).toBe(413);
    expect(chunked.status).toBe(413);
    expect(m.processed).not.toHaveBeenCalled();
  });
});
