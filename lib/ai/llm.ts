/**
 * Chat completions from Anthropic (Claude) or any OpenAI-compatible API,
 * which covers OpenAI itself and the gateways used from Iran. Plain fetch,
 * so no SDK has to keep up with either.
 */

import { postJson, ResponseTooLargeError, type PostResult } from "@/lib/net/safe-fetch";
import { UnsafeUrlError } from "@/lib/net/safe-url";

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type LlmConfig = { provider: "ANTHROPIC" | "OPENAI"; model: string; apiKey: string; baseUrl?: string | null };

export { ANTHROPIC_MODELS } from "./models";
const MAX_TOKENS = 500;
const TIMEOUT_MS = 45_000;

/** The provider said slow down (429/529): nothing was produced, try again later. */
export class LlmRateLimitError extends Error {
  name = "LlmRateLimitError";
}

/** Anything else: a wrong key, a model that does not exist, a refusal. Not retried. */
export class LlmError extends Error {
  name = "LlmError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  // The address of an OpenAI-compatible gateway is typed in by an admin, and
  // the server sends the API key to it: it must be a public https host, never
  // something inside the deployment (Redis, Postgres, the cloud metadata API).
  // postJson checks the address the socket actually connects to, follows no
  // redirect and reads a bounded answer.
  let response: PostResult;
  try {
    response = await postJson(url, { "Content-Type": "application/json", ...headers }, body, { timeoutMs: TIMEOUT_MS });
  } catch (error) {
    if (error instanceof UnsafeUrlError || error instanceof ResponseTooLargeError) throw new LlmError(error.message);
    // Nothing came back, so nothing was produced: worth another try.
    throw new LlmRateLimitError(`AI request did not complete: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status >= 300 && response.status < 400) throw new LlmError(`AI provider redirected (HTTP ${response.status}); use its final address`);
  const text = response.text;
  if (response.status === 429 || response.status === 529 || response.status >= 500) {
    throw new LlmRateLimitError(`AI provider busy (HTTP ${response.status})`);
  }
  if (response.status < 200 || response.status >= 300) {
    // The error body may echo the request; keep only a short, keyless excerpt.
    let detail = "";
    try {
      const parsed = JSON.parse(text);
      detail = String(parsed?.error?.message ?? parsed?.message ?? "").slice(0, 200);
    } catch {}
    throw new LlmError(`AI provider refused (HTTP ${response.status})${detail ? `: ${detail}` : ""}`, response.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError("AI provider answered with something that is not JSON");
  }
}

export function anthropicRequest(config: LlmConfig, system: string, turns: ChatTurn[]) {
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
    body: { model: config.model, max_tokens: MAX_TOKENS, system, messages: turns },
  };
}

export function openAiRequest(config: LlmConfig, system: string, turns: ChatTurn[]) {
  const base = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    url: `${base}/chat/completions`,
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: { model: config.model, max_tokens: MAX_TOKENS, messages: [{ role: "system", content: system }, ...turns] },
  };
}

/** The model's text answer, trimmed; throws LlmRateLimitError or LlmError. */
export async function complete(config: LlmConfig, system: string, turns: ChatTurn[]): Promise<string> {
  if (config.provider === "ANTHROPIC") {
    const req = anthropicRequest(config, system, turns);
    const data = (await post(req.url, req.headers, req.body)) as { content?: { type: string; text?: string }[] };
    return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  }
  const req = openAiRequest(config, system, turns);
  const data = (await post(req.url, req.headers, req.body)) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}
