import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getZernioAccountId, normalizeZernioEvent, parseZernioSentMessage, readZernioHeaders,
  resolveZernioEventId, verifyZernioSignature,
} from "@/lib/zernio/normalize-event";
import { parseCommentEvents, parseMessageEvents } from "@/lib/meta/webhook";
import { FAKE_SECRET, FIXTURE, fixture, fixtureBody, sign, zernioHeaders } from "./helpers/zernio-fixtures";

const account = { zernioAccountId: fixture(FIXTURE.messageText).account.accountId as string, instagramId: "ig-fixture" };

afterEach(() => vi.restoreAllMocks());

describe("signature check", () => {
  const body = fixtureBody(FIXTURE.commentCustomer);

  it("accepts the HMAC-SHA256 of the exact bytes", () => {
    expect(verifyZernioSignature({ rawBody: body, signature: sign(body), secret: FAKE_SECRET })).toBe(true);
    const bytes = Buffer.from(body, "utf8");
    expect(verifyZernioSignature({ rawBody: bytes, signature: sign(bytes), secret: FAKE_SECRET })).toBe(true);
  });

  it("signs bytes, not a decoded string: a dropped BOM changes the signature", () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]);
    expect(verifyZernioSignature({ rawBody: withBom, signature: sign(withBom), secret: FAKE_SECRET })).toBe(true);
    expect(verifyZernioSignature({ rawBody: withBom.subarray(3), signature: sign(withBom), secret: FAKE_SECRET })).toBe(false);
  });

  it("rejects a missing, short, long, non-hex, wrong or other-secret signature", () => {
    const good = sign(body);
    for (const signature of [null, "", good.slice(0, 63), good + "0", "z".repeat(64), "0".repeat(64), sign(body, "another-secret")]) {
      expect(verifyZernioSignature({ rawBody: body, signature, secret: FAKE_SECRET })).toBe(false);
    }
    expect(verifyZernioSignature({ rawBody: body, signature: good, secret: "" })).toBe(false);
  });

  it("rejects a body changed after signing", () => {
    expect(verifyZernioSignature({ rawBody: body.replace("customer", "attacker"), signature: sign(body), secret: FAKE_SECRET })).toBe(false);
    expect(verifyZernioSignature({ rawBody: body + "\n", signature: sign(body), secret: FAKE_SECRET })).toBe(false);
  });

  it("reads x-zernio-* first and x-late-* as the fallback", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(readZernioHeaders(h({ "x-zernio-signature": "a", "x-late-signature": "b", "x-zernio-event-id": "e1", "x-late-event-id": "e2" }))).toMatchObject({ signature: "a", eventId: "e1" });
    expect(readZernioHeaders(h({ "x-late-signature": "b", "x-late-event-id": "e2", "x-late-event": "message.received" }))).toEqual({ signature: "b", eventId: "e2", event: "message.received" });
    expect(readZernioHeaders(h({}))).toEqual({ signature: null, eventId: null, event: null });
  });

  it("the test helper builds both header families with the body id as event id", () => {
    const headers = zernioHeaders(body);
    expect(headers["x-zernio-event-id"]).toBe(fixture(FIXTURE.commentCustomer).id);
    expect(headers["x-late-signature"]).toBe(headers["x-zernio-signature"]);
  });
});

describe("account id", () => {
  it("prefers accountId, falls back to id, and says nothing when they agree", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(getZernioAccountId({ id: "a", accountId: "a" })).toBe("a");
    expect(getZernioAccountId({ id: "a" })).toBe("a");
    expect(getZernioAccountId({ accountId: "b" })).toBe("b");
    expect(getZernioAccountId({})).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns without printing either value when they differ", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(getZernioAccountId({ id: "secret-id-1", accountId: "secret-id-2" })).toBe("secret-id-2");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toMatch(/secret-id/);
  });

  it("normalizes events that carry only id or only accountId", () => {
    const payload = fixture(FIXTURE.commentCustomer);
    const onlyId = { ...payload, account: { id: payload.account.id, platform: "instagram" } };
    const onlyAccountId = { ...payload, account: { accountId: payload.account.accountId, platform: "instagram" } };
    expect(normalizeZernioEvent({ payload: onlyId, account })).not.toBeNull();
    expect(normalizeZernioEvent({ payload: onlyAccountId, account })).not.toBeNull();
  });
});

describe("event id", () => {
  it("uses the body id and warns when the header disagrees", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveZernioEventId("evt-1", "evt-1")).toBe("evt-1");
    expect(resolveZernioEventId("evt-1", null)).toBe("evt-1");
    expect(warn).not.toHaveBeenCalled();
    expect(resolveZernioEventId("evt-1", "evt-2")).toBe("evt-1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toMatch(/evt-/);
  });
});

describe("the seven captured events, normalize to parse", () => {
  it("1: a text DM becomes a keyword-matchable message with the full-length message id", () => {
    const payload = fixture(FIXTURE.messageText);
    const events = parseMessageEvents(normalizeZernioEvent({ payload, account })!);
    expect(events).toEqual([expect.objectContaining({
      instagramAccountId: "ig-fixture",
      messageId: payload.message.platformMessageId,
      messageText: "hello there",
      senderId: payload.message.sender.id,
      senderUsername: payload.message.sender.username,
    })]);
    expect(payload.message.platformMessageId.length).toBeGreaterThan(150);
  });

  it("2: an image DM keeps the attachment type but not its signed CDN URL", () => {
    const payload = fixture(FIXTURE.messageImage);
    const normalized = normalizeZernioEvent({ payload, account })!;
    expect(parseMessageEvents(normalized)).toEqual([expect.objectContaining({ messageText: "", attachments: [{ type: "image" }] })]);
    expect(JSON.stringify(normalized)).not.toContain(payload.message.attachments[0].url);
    expect(JSON.stringify(normalized)).not.toContain("cdn.example.test");
  });

  it("3 and 4: customer comments match on platformPostId alone", () => {
    for (const n of [FIXTURE.commentCustomer, FIXTURE.commentKeyword]) {
      const payload = fixture(n);
      expect(payload.comment.postId).toBeNull();
      expect(payload.post.permalink).toBeNull();
      expect(payload.post.content).toBeNull();
      expect(parseCommentEvents(normalizeZernioEvent({ payload, account })!)).toEqual([{
        instagramAccountId: "ig-fixture",
        commentId: payload.comment.id,
        commentText: payload.comment.text,
        commenterId: payload.comment.author.id,
        commenterName: payload.comment.author.username,
        mediaId: payload.comment.platformPostId,
        originalMediaId: undefined,
      }]);
    }
  });

  it("5 and 7: message.sent never normalizes into anything an automation could act on", () => {
    for (const n of [FIXTURE.sentHuman, FIXTURE.sentHumanShort]) {
      const payload = fixture(n);
      expect(normalizeZernioEvent({ payload, account })).toBeNull();
      expect(parseZernioSentMessage(payload)).toEqual({
        platformMessageId: payload.message.platformMessageId,
        sentVia: "human",
        hasAttachments: false,
        sentAt: new Date(payload.message.sentAt),
      });
    }
  });

  it("6: the page's own public reply does not normalize, whatever its ids look like", () => {
    const payload = fixture(FIXTURE.commentOwnReply);
    expect(payload.comment.author.isOwnAccount).toBe(true);
    expect(payload.comment.isReply).toBe(true);
    // Our own account has three different ids; none equals the stored instagramId, so an id check would miss it.
    expect(payload.comment.author.id).not.toBe(account.instagramId);
    expect(payload.comment.author.id).not.toBe(payload.account.accountId);
    expect(normalizeZernioEvent({ payload, account })).toBeNull();
  });

  it("the flag alone decides: the same reply from another person is a customer comment", () => {
    const payload = fixture(FIXTURE.commentOwnReply);
    const customerReply = { ...payload, comment: { ...payload.comment, author: { ...payload.comment.author, isOwnAccount: false } } };
    expect(parseCommentEvents(normalizeZernioEvent({ payload: customerReply, account })!)).toHaveLength(1);
  });

  it("an outgoing message.received never triggers anything", () => {
    const payload = fixture(FIXTURE.messageText);
    const outgoing = { ...payload, message: { ...payload.message, direction: "outgoing" } };
    expect(normalizeZernioEvent({ payload: outgoing, account })).toBeNull();
  });

  it("message.sent has a summary only when it is an outgoing message.sent", () => {
    expect(parseZernioSentMessage(fixture(FIXTURE.messageText))).toBeNull();
    const payload = fixture(FIXTURE.sentHuman);
    expect(parseZernioSentMessage({ ...payload, message: { ...payload.message, direction: "incoming" } })).toBeNull();
  });
});
