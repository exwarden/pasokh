import { NextRequest, NextResponse } from "next/server";
import { secretsMatch } from "@/lib/net/secrets";
import { BodyTooLargeError, readBodyLimited } from "@/lib/net/read-body-limited";
import { noteBadWebhookSignature } from "@/lib/ops/webhook-alerts";
import {
  parseCommentEvents,
  verifyWebhookSignature,
} from "@/lib/meta/webhook";
import { processInstagramWebhook } from "@/lib/queue/process-webhook";


export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && secretsMatch(token, process.env.WEBHOOK_VERIFY_TOKEN)) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest) {
  let rawBody: string;
  try {
    rawBody = (await readBodyLimited(request)).toString("utf8");
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json({ success: false, error: "Payload too large" }, { status: 413 });
    }
    throw error;
  }
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    // Visible rather than a silent 401 (the common cause is FACEBOOK_APP_SECRET
    // belonging to the wrong app), but rate-limited and without the body.
    await noteBadWebhookSignature({ hadSignatureHeader: Boolean(signature), bodyLength: rawBody.length });
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  try {
    await processInstagramWebhook({ payload: payload as Parameters<typeof parseCommentEvents>[0], provider: 'META' });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: 'Webhook processing failed' }, { status: 500 });
  }
}
