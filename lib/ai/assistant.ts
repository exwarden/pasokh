import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { defaultLocale } from "@/lib/i18n";
import { RateLimitError, createInstagramContext, sendOutboundMessage } from "@/lib/instagram/provider";
import { classifySendError, isConfirmedSendRejection, isDeliveryUnconfirmed } from "@/lib/instagram/delivery-errors";
import { complete, LlmRateLimitError, type ChatTurn } from "./llm";
import { unsupportedFacts } from "./guard";
import { cleanAnswer, systemPrompt } from "./prompt";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Earlier exchanges the model sees, so "and the price?" has something to refer to. */
const MEMORY_TURNS = 6;
/** Most AI replies one workspace can use in 24 hours, whoever asks (AI_MAX_REPLIES_PER_DAY). */
const DEFAULT_WORKSPACE_DAILY_REPLIES = 300;
const HANDOFF_PREFIX = "Handoff: ";

function workspaceDailyLimit(): number {
  const n = Number(process.env.AI_MAX_REPLIES_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_WORKSPACE_DAILY_REPLIES;
}

/**
 * What the customer gets when the model cannot be used or its answer cannot be
 * trusted: no guess, only the promise that a person will answer. Follows the
 * instance language, like the form prompts.
 */
export function handoffText(): string {
  return defaultLocale() === "fa"
    ? "پیام شما ثبت شد. یکی از مشاوران ما در اولین فرصت پاسخ می‌دهد."
    : "We received your message. One of our team will reply as soon as possible.";
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002";
}

export type AiOutcome = "SENT" | "HANDOFF" | "OFF" | "LIMIT" | "DUPLICATE" | "FAILED" | "UNCONFIRMED";

/** Visible in the dashboard's failed-job and event lists, so a silent assistant is noticed. */
async function recordEvent(workspaceId: string, level: "WARNING" | "ERROR", message: string, payload: Record<string, unknown>) {
  await prisma.operationalEvent.create({ data: { workspaceId, source: "WORKER", level, message, payload: payload as never } }).catch(() => {});
}

/**
 * Answers a DM nothing else answered. The reply row is claimed before the
 * model is called; a redelivered webhook finds it and does nothing, unless
 * the answer was written but Instagram asked us to slow down, in which case
 * the stored answer is sent without a second model call.
 *
 * When the model fails, or writes a price, figure or link that nothing it was
 * given contains, the customer gets a fixed handoff message instead and the
 * workspace gets an event, so nobody is left unanswered and nothing invented
 * is sent.
 */
export async function answerWithAi({
  instagramId,
  accountConnectionId,
  igsid,
  messageId,
  text,
}: {
  instagramId: string;
  accountConnectionId?: string;
  igsid: string;
  messageId: string;
  text: string;
}): Promise<AiOutcome> {
  const assistant = await prisma.aiAssistant.findFirst({
    where: {
      enabled: true,
      instagramAccount: { instagramId, ...(accountConnectionId ? { id: accountConnectionId } : {}) },
    },
    include: { instagramAccount: true },
  });
  if (!assistant || !text.trim()) return "OFF";
  const workspaceId = assistant.instagramAccount.workspaceId;

  let reply = await prisma.aiReply.findUnique({
    where: { assistantId_triggerId: { assistantId: assistant.id, triggerId: messageId } },
  });
  if (reply && !(reply.status === "PENDING" && reply.answer)) return "DUPLICATE";

  if (!reply) {
    const since = new Date(Date.now() - DAY_MS);
    // Every attempt counts, not only the ones that reached Instagram: a model
    // call is paid for whether or not the reply was delivered.
    const [attemptsByPerson, attemptsInWorkspace] = await Promise.all([
      prisma.aiReply.count({ where: { assistantId: assistant.id, igsid, createdAt: { gte: since } } }),
      prisma.aiReply.count({ where: { assistant: { instagramAccount: { workspaceId } }, createdAt: { gte: since } } }),
    ]);
    if (attemptsByPerson >= assistant.dailyLimitPerPerson) return "LIMIT";
    if (attemptsInWorkspace >= workspaceDailyLimit()) {
      // Once a day is enough to be noticed.
      const already = await prisma.operationalEvent.findFirst({
        where: { workspaceId, message: "The AI assistant reached its daily limit", createdAt: { gte: since } },
        select: { id: true },
      });
      if (!already) await recordEvent(workspaceId, "WARNING", "The AI assistant reached its daily limit", { limit: workspaceDailyLimit() });
      return "LIMIT";
    }
    try {
      reply = await prisma.aiReply.create({
        data: { assistantId: assistant.id, igsid, triggerId: messageId, question: text.slice(0, 2000) },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return "DUPLICATE";
      throw error;
    }
  }
  const claimed = reply;

  let answer = claimed.answer;
  // Set when the customer gets the handoff message instead of a model answer
  // (also restored when a retry resumes a handoff that was waiting to be sent).
  let handoff = claimed.error?.startsWith(HANDOFF_PREFIX) ? claimed.error : null;

  if (!answer) {
    const earlier = await prisma.aiReply.findMany({
      where: { assistantId: assistant.id, igsid, status: "SENT", id: { not: claimed.id } },
      orderBy: { createdAt: "desc" },
      take: MEMORY_TURNS,
    });
    const turns: ChatTurn[] = earlier
      .reverse()
      .flatMap((r) => [
        { role: "user" as const, content: r.question },
        { role: "assistant" as const, content: r.answer ?? "" },
      ]);
    turns.push({ role: "user", content: text });

    let modelAnswer = "";
    let failure: string | null = null;
    try {
      modelAnswer = cleanAnswer(
        await complete(
          { provider: assistant.provider === "OPENAI" ? "OPENAI" : "ANTHROPIC", model: assistant.model, baseUrl: assistant.baseUrl, apiKey: decryptToken(assistant.apiKey) },
          systemPrompt({ username: assistant.instagramAccount.username, persona: assistant.persona, tone: assistant.tone, knowledge: assistant.knowledge }),
          turns,
        ),
      );
    } catch (error) {
      if (error instanceof LlmRateLimitError) {
        // Nothing was produced: free the claim so the job's retry asks again.
        await prisma.aiReply.delete({ where: { id: claimed.id } });
        throw error;
      }
      failure = `model error: ${error instanceof Error ? error.message : String(error)}`;
      await recordEvent(workspaceId, "ERROR", "The AI assistant could not answer", { assistantId: assistant.id, igsid, reason: failure });
    }
    if (!failure && !modelAnswer) {
      failure = "the model returned an empty answer";
      await recordEvent(workspaceId, "WARNING", "The AI assistant could not answer", { assistantId: assistant.id, igsid, reason: failure });
    }
    if (!failure) {
      // What the model may rely on: what the owner wrote and what was said in this conversation.
      const allowed = [assistant.persona, assistant.knowledge, ...turns.map((t) => t.content)].join("\n");
      const unsupported = unsupportedFacts(modelAnswer, allowed);
      if (unsupported.length > 0) {
        failure = `unsupported in the answer: ${unsupported.join(", ")}`;
        await recordEvent(workspaceId, "WARNING", "The AI assistant's answer was held back", { assistantId: assistant.id, igsid, unsupported, heldBack: modelAnswer });
      }
    }

    if (failure) {
      handoff = `${HANDOFF_PREFIX}${failure}`.slice(0, 500);
      answer = handoffText();
      await prisma.aiReply.update({ where: { id: claimed.id }, data: { answer, error: handoff } });
    } else {
      answer = modelAnswer;
      await prisma.aiReply.update({ where: { id: claimed.id }, data: { answer } });
    }
  }

  try {
    const context = await createInstagramContext(assistant.instagramAccount, `ai:${claimed.id}`);
    await sendOutboundMessage({
      context,
      instagramAccountId: assistant.instagramAccount.instagramId,
      recipient: { userId: igsid },
      message: { type: "text", text: answer },
    });
  } catch (raw) {
    // Instagram asked us to wait: the answer stays stored (PENDING) and the
    // retry sends it as written.
    if (raw instanceof RateLimitError) throw raw;
    const error = classifySendError(raw);
    const status = isDeliveryUnconfirmed(error) || !isConfirmedSendRejection(error) ? "UNCONFIRMED" : "FAILED";
    await prisma.aiReply.update({ where: { id: claimed.id }, data: { status, error: error instanceof Error ? error.message : String(error) } });
    return status;
  }
  await prisma.aiReply.update({ where: { id: claimed.id }, data: { status: handoff ? "HANDOFF" : "SENT", error: handoff } });
  return handoff ? "HANDOFF" : "SENT";
}
