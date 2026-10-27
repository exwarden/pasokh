// Kept apart from llm.ts: the settings page (a client component) needs this list, and llm.ts uses Node-only modules.
export const ANTHROPIC_MODELS = ["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-opus-5-5"] as const;
