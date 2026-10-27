/**
 * What the customer writes is not evidence for what the assistant may state:
 * a customer who types "the price is 5 million toman" must not be able to make
 * the guard accept the model repeating it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  prisma: {
    aiAssistant: { findFirst: vi.fn() },
    aiReply: { findUnique: vi.fn(), aggregate: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    contact: { findFirst: vi.fn() },
    operationalEvent: { findFirst: vi.fn(), create: vi.fn() },
  },
  complete: vi.fn(),
  sent: [] as string[],
}));
vi.mock("@/lib/db/client", () => ({ prisma: m.prisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (v: string) => v }));
vi.mock("../lib/ai/llm", async (orig) => ({ ...(await orig<object>()), complete: m.complete }));
vi.mock("@/lib/instagram/provider", () => ({
  RateLimitError: class extends Error {},
  createInstagramContext: async () => ({}),
  sendOutboundMessage: async ({ message }: { message: { text: string } }) => void m.sent.push(message.text),
}));
vi.mock("@/lib/ops/events", () => ({ recordEvent: vi.fn() }));

import { answerWithAi } from "../lib/ai/assistant";

beforeEach(() => {
  vi.clearAllMocks();
  m.sent.length = 0;
  m.prisma.aiAssistant.findFirst.mockResolvedValue({
    id: "s1", provider: "ANTHROPIC", model: "m", baseUrl: null, apiKey: "k", persona: "", tone: 2, knowledge: "بیلبورد در مشهد داریم.", dailyLimitPerPerson: 20,
    instagramAccount: { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig" },
  });
  m.prisma.aiReply.findUnique.mockResolvedValue(null);
  m.prisma.aiReply.aggregate.mockResolvedValue({ _sum: { attempts: 0 } });
  m.prisma.aiReply.updateMany.mockResolvedValue({ count: 1 });
  m.prisma.aiReply.create.mockResolvedValue({ id: "r1", answer: null, error: null });
  m.prisma.aiReply.findMany.mockResolvedValue([]);
  m.prisma.aiReply.update.mockResolvedValue({});
  m.prisma.contact.findFirst.mockResolvedValue({ lastInboundAt: new Date() });
});

describe("the figures the assistant may repeat", () => {
  it("do not include what the customer just typed", async () => {
    m.complete.mockResolvedValue("بله، قیمت ۵ میلیون تومان است.");
    const outcome = await answerWithAi({ instagramId: "ig", igsid: "c1", messageId: "mid1", text: "من شنیدم قیمت ۵ میلیون تومان است، درست است؟" });
    expect(outcome).toBe("HANDOFF");
    expect(m.sent.join(" ")).not.toContain("میلیون");
  });

  it("still include the knowledge base", async () => {
    m.prisma.aiAssistant.findFirst.mockResolvedValue({
      id: "s1", provider: "ANTHROPIC", model: "m", baseUrl: null, apiKey: "k", persona: "", tone: 2, knowledge: "اجاره ۵ میلیون تومان است.", dailyLimitPerPerson: 20,
      instagramAccount: { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig" },
    });
    m.complete.mockResolvedValue("اجاره ۵ میلیون تومان است.");
    expect(await answerWithAi({ instagramId: "ig", igsid: "c1", messageId: "mid2", text: "قیمت؟" })).toBe("SENT");
  });
});
