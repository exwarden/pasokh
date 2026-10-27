import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/app/generated/prisma/client';
import { prisma } from '@/lib/db/client';
import { decryptToken } from '@/lib/meta/oauth';
import {
  getZernioAccountId, normalizeZernioEvent, parseZernioSentMessage, readZernioHeaders,
  resolveZernioEventId, verifyZernioSignature, zernioAccountSchema,
} from '@/lib/zernio/normalize-event';
import { processInstagramWebhook } from '@/lib/queue/process-webhook';

const eventEnvelopeSchema = z.object({ id: z.string().min(1), event: z.string(), account: zernioAccountSchema });

export async function POST(request: Request, segmentData: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await segmentData.params;
  const connection = await prisma.zernioConnection.findUnique({ where: { workspaceId } });
  // Same answer as a bad signature: whether a workspace id exists is not for strangers to learn.
  if (!connection?.webhookId) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  // The signature covers the exact bytes Zernio sent, so verify those, not a decoded string.
  const rawBody = Buffer.from(await request.arrayBuffer());
  const headers = readZernioHeaders(request.headers);
  if (!verifyZernioSignature({ rawBody, signature: headers.signature, secret: decryptToken(connection.webhookSecret) })) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  let payload: unknown;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = eventEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ success: true, ignored: true });
  const { event, account: envelopeAccount } = parsed.data;
  // Zernio subscriptions are account-wide. Drop other profiles before persisting any payload.
  const account = await prisma.instagramAccount.findFirst({ where: { workspaceId, provider: 'ZERNIO', zernioAccountId: getZernioAccountId(envelopeAccount) } });
  if (!account) return NextResponse.json({ success: true, ignored: true });

  if (event === 'account.connected' || event === 'account.disconnected') {
    // Not handled yet (docs/BACKLOG.md). Log the kind only.
    console.info(`[zernio] ${event} received for workspace ${workspaceId}; no action taken`);
    return NextResponse.json({ success: true, ignored: true });
  }

  // At-least-once delivery with retries for about two days: claim the event id first, and give
  // the claim back if processing fails so the retry is not mistaken for a duplicate.
  const eventId = resolveZernioEventId(parsed.data.id, headers.eventId);
  try {
    await prisma.zernioEventReceipt.create({ data: { workspaceId, eventId, event } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return NextResponse.json({ success: true, duplicate: true });
    return NextResponse.json({ error: 'Webhook processing failed; retry delivery.' }, { status: 500 });
  }

  try {
    if (event === 'message.sent') {
      // Bookkeeping only. A message the account sent must never reach automations or the AI.
      const sent = parseZernioSentMessage(payload);
      if (sent) {
        const { platformMessageId, ...data } = sent;
        await prisma.zernioSentMessage.upsert({
          where: { workspaceId_platformMessageId: { workspaceId, platformMessageId } },
          create: { workspaceId, platformMessageId, ...data },
          update: data,
        });
      }
      return NextResponse.json({ success: true });
    }
    const normalized = normalizeZernioEvent({ payload, account });
    if (!normalized) return NextResponse.json({ success: true, ignored: true });
    await processInstagramWebhook({ payload: normalized, provider: 'ZERNIO', workspaceId });
    return NextResponse.json({ success: true });
  } catch {
    await prisma.zernioEventReceipt.deleteMany({ where: { workspaceId, eventId } }).catch(() => undefined);
    return NextResponse.json({ error: 'Webhook processing failed; retry delivery.' }, { status: 500 });
  }
}
