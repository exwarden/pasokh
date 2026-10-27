/**
 * The stored API key is only ever sent to the address and provider it was
 * saved for. Re-using it for another endpoint would let an admin point the key
 * at a server they control and read it from the request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceMember: { findFirst: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    aiAssistant: { findUnique: vi.fn(), upsert: vi.fn(), findFirst: vi.fn() },
    aiReply: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => "u1" }));
vi.mock("@/lib/meta/oauth", () => ({ encryptToken: (v: string) => `enc(${v})`, decryptToken: (v: string) => v }));

import { PUT } from "../app/api/ai/route";

const base = { instagramAccountId: "a1", enabled: true, model: "m", persona: "", tone: 2, knowledge: "", dailyLimitPerPerson: 20 };
const put = (body: object) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ ...base, ...body }) }) as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspaceMember.findFirst.mockResolvedValue({ workspaceId: "w1", role: "ADMIN", workspace: {} });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "a1" });
  mockPrisma.aiAssistant.findUnique.mockResolvedValue({ id: "s1", provider: "OPENAI", baseUrl: "https://llm.example.com/v1", apiKey: "stored" });
  mockPrisma.aiAssistant.upsert.mockResolvedValue({});
  mockPrisma.aiReply.findMany.mockResolvedValue([]);
});

describe("saving the assistant without re-entering the API key", () => {
  it("is refused when the base URL changes", async () => {
    const res = await put({ provider: "OPENAI", baseUrl: "https://attacker.example.net/v1" });
    expect(res.status).toBe(400);
    expect(mockPrisma.aiAssistant.upsert).not.toHaveBeenCalled();
  });

  it("is refused when the provider changes", async () => {
    const res = await put({ provider: "ANTHROPIC" });
    expect(res.status).toBe(400);
    expect(mockPrisma.aiAssistant.upsert).not.toHaveBeenCalled();
  });

  it("is allowed when provider and address are unchanged", async () => {
    const res = await put({ provider: "OPENAI", baseUrl: "https://llm.example.com/v1", model: "other-model" });
    expect(res.status).toBe(200);
    expect(mockPrisma.aiAssistant.upsert.mock.calls[0][0].update.apiKey).toBe("stored");
  });

  it("is allowed with a new address when a new key is sent with it", async () => {
    const res = await put({ provider: "OPENAI", baseUrl: "https://other.example.com/v1", apiKey: "sk-new" });
    expect(res.status).toBe(200);
    expect(mockPrisma.aiAssistant.upsert.mock.calls[0][0].update.apiKey).toBe("enc(sk-new)");
  });
});
