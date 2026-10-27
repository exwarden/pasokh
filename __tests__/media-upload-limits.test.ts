import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ usedBytes: 0, created: 0 }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => "u1" }));
vi.mock("@/lib/media/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/media/store")>()),
  writeMediaFile: async () => undefined,
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    workspaceMember: { findFirst: async () => ({ workspaceId: "w1", role: "ADMIN", workspace: {} }) },
    mediaAsset: {
      aggregate: async () => ({ _sum: { sizeBytes: m.usedBytes } }),
      create: async () => ((m.created += 1), { id: "a", publicId: "p".repeat(48), kind: "image", mimeType: "image/png", extension: "png", fileName: "x.png", sizeBytes: 8, createdAt: new Date() }),
    },
  },
}));

import { POST } from "../app/api/media/route";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
function multipart(bytes: Uint8Array, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], "x.png", { type: "image/png" }));
  return new Request("http://x/api/media", { method: "POST", body: form, headers });
}

beforeEach(() => {
  m.usedBytes = 0;
  m.created = 0;
  delete process.env.MEDIA_QUOTA_MB;
});

describe("media upload limits", () => {
  it("accepts an ordinary upload", async () => {
    expect((await POST(multipart(PNG) as never)).status).toBe(201);
  });

  it("refuses an oversized upload from its declared size, before reading the body", async () => {
    const request = multipart(PNG, { "content-length": String(27 * 1024 * 1024) });
    const response = await POST(request as never);
    expect(response.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  it("stops reading a body that is bigger than it declared, or that declared nothing", async () => {
    const big = new Uint8Array(27 * 1024 * 1024);
    big.set(PNG);
    const response = await POST(multipart(big) as never);
    expect(response.status).toBe(413);
    expect(m.created).toBe(0);
  });

  it("refuses an upload that would take the workspace over its quota", async () => {
    process.env.MEDIA_QUOTA_MB = "10";
    m.usedBytes = 9 * 1024 * 1024;
    const response = await POST(multipart(PNG, { "content-length": String(2 * 1024 * 1024) }) as never);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Your uploaded files take too much space. Delete some first." });
  });

  it("counts the real size too, when the declared one was missing or small", async () => {
    process.env.MEDIA_QUOTA_MB = "1";
    m.usedBytes = 1024 * 1024 - 4;
    expect((await POST(multipart(PNG) as never)).status).toBe(413);
    expect(m.created).toBe(0);
  });
});
