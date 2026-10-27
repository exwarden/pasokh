import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { parseCommentEvents } from '@/lib/meta/webhook';

type InstagramPayload = Parameters<typeof parseCommentEvents>[0];

/** Zernio sends the account's id as `id` and, in current payloads, also as `accountId`. */
export const zernioAccountSchema = z.object({
  id: z.string().min(1).optional(), accountId: z.string().min(1).optional(), platform: z.literal('instagram'),
}).refine(a => Boolean(a.id ?? a.accountId), { message: 'account id missing' });

/**
 * The Zernio account an event belongs to: `accountId` first, `id` as the fallback.
 * Both appear in real payloads with the same value; if they ever differ that is
 * logged (never the values) and `accountId` wins.
 */
export function getZernioAccountId(account: { id?: string | null; accountId?: string | null }): string | null {
  if (account.id && account.accountId && account.id !== account.accountId) {
    console.warn('[zernio] account.id and account.accountId differ in a webhook payload; using accountId');
  }
  return account.accountId ?? account.id ?? null;
}

const envelopeSchema = z.object({
  id: z.string().min(1),
  event: z.string(),
  account: zernioAccountSchema,
  comment: z.object({
    id: z.string().min(1), platformPostId: z.string().min(1), text: z.string(),
    author: z.object({ id: z.string().min(1), username: z.string().optional(), isOwnAccount: z.boolean().optional() }),
    isReply: z.boolean().optional(),
  }).optional(),
  message: z.object({
    platformMessageId: z.string().min(1), direction: z.enum(['incoming', 'outgoing']),
    text: z.string().nullable(), sender: z.object({ id: z.string().min(1), username: z.string().optional() }),
    attachments: z.array(z.object({ type: z.string(), originalType: z.string().optional(), url: z.string().optional() })).optional(),
    sentAt: z.string().nullish(), sentVia: z.string().nullish(),
  }).optional(),
  conversation: z.object({ participantId: z.string().nullish() }).optional(),
  metadata: z.object({
    postbackPayload: z.string().optional(), postbackTitle: z.string().optional(),
    quickReplyPayload: z.string().optional(),
    storyReply: z.object({ storyId: z.string(), storyUrl: z.string().optional() }).optional(),
    isStoryMention: z.boolean().optional(),
  }).nullish(),
  statusAt: z.string().optional(),
});

/** Signature and event id headers: x-zernio-* first, the legacy x-late-* names as the fallback. */
export function readZernioHeaders(headers: Pick<Headers, 'get'>): { signature: string | null; eventId: string | null; event: string | null } {
  const pick = (name: string) => headers.get(`x-zernio-${name}`) ?? headers.get(`x-late-${name}`);
  return { signature: pick('signature'), eventId: pick('event-id'), event: pick('event') };
}

/** HMAC-SHA256 over the raw request bytes, compared as hex in constant time. */
export function verifyZernioSignature({ rawBody, signature, secret }: {
  rawBody: string | Uint8Array; signature: string | null; secret: string;
}): boolean {
  if (!signature || !secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

/** The event id to dedupe on: the body's `id`, which x-zernio-event-id repeats. A mismatch is logged. */
export function resolveZernioEventId(bodyId: string, headerId: string | null): string {
  if (headerId && headerId !== bodyId) console.warn('[zernio] x-zernio-event-id differs from the body id; using the body id');
  return bodyId;
}

/** message.sent: a message the account sent (a person, or an automation). Recorded, never acted on. */
export function parseZernioSentMessage(payload: unknown): { platformMessageId: string; sentVia: string | null; hasAttachments: boolean; sentAt: Date | null } | null {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success || parsed.data.event !== 'message.sent' || parsed.data.message?.direction !== 'outgoing') return null;
  const { message } = parsed.data;
  const sentAt = message.sentAt ? new Date(message.sentAt) : null;
  return {
    platformMessageId: message.platformMessageId,
    sentVia: message.sentVia ?? null,
    hasAttachments: (message.attachments?.length ?? 0) > 0,
    sentAt: sentAt && Number.isFinite(sentAt.getTime()) ? sentAt : null,
  };
}

export function normalizeZernioEvent({ payload, account }: {
  payload: unknown; account: { zernioAccountId: string | null; instagramId: string };
}): InstagramPayload | null {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success || getZernioAccountId(parsed.data.account) !== account.zernioAccountId) return null;
  const { event, comment, message, metadata, conversation, statusAt } = parsed.data;
  const entry: InstagramPayload['entry'][number] = { id: account.instagramId, time: Date.now() };
  if (event === 'comment.received' && comment) {
    // The page's own public reply arrives as a comment too. It must never start a campaign.
    // Ids differ per surface for our own account, so Zernio's flag is the only reliable signal.
    if (comment.author.isOwnAccount) return null;
    entry.changes = [{ field: 'comments', value: { id: comment.id, text: comment.text, from: comment.author, media: { id: comment.platformPostId } } }];
  } else if (event === 'message.received' && message?.direction === 'incoming') {
    const sender = { id: message.sender.id, ...(message.sender.username ? { username: message.sender.username } : {}) };
    // Zernio folds Meta's story_mention into type "share"; originalType keeps it.
    // Only the type travels on: attachment URLs are signed, expiring CDN links to a
    // customer's media and nothing downstream downloads them.
    const attachments = (message.attachments ?? []).map(a => ({
      type: a.originalType === 'story_mention' ? 'story_mention' : a.type,
    }));
    if (metadata?.isStoryMention && !attachments.some(a => a.type === 'story_mention')) attachments.push({ type: 'story_mention' });
    entry.messaging = [metadata?.postbackPayload
      ? { sender, postback: { mid: message.platformMessageId, payload: metadata.postbackPayload, title: metadata.postbackTitle } }
      : { sender, message: {
          mid: message.platformMessageId,
          text: message.text ?? '',
          ...(attachments.length ? { attachments } : {}),
          ...(metadata?.quickReplyPayload ? { quick_reply: { payload: metadata.quickReplyPayload } } : {}),
          ...(metadata?.storyReply ? { reply_to: { story: { id: metadata.storyReply.storyId } } } : {}),
        } }];
  } else if (event === 'message.read' && conversation?.participantId) {
    const watermark = statusAt ? Date.parse(statusAt) : undefined;
    entry.messaging = [{ sender: { id: conversation.participantId }, read: { watermark: watermark !== undefined && Number.isFinite(watermark) ? watermark : undefined } }];
  } else {
    return null;
  }
  return { object: 'instagram', entry: [entry] };
}
