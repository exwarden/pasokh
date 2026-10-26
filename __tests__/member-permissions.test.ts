/**
 * What a plain MEMBER may do. A member reads, answers in the inbox, edits
 * contacts and reads logs and reports; changing or deleting shared
 * configuration needs an owner or admin. Each route is called with a role and
 * a database that rejects everything, so a 403 can only come from the role
 * check and nothing is written on the way to it.
 */
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ role: "MEMBER" as "MEMBER" | "ADMIN" | "OWNER", touched: [] as string[] }));

vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: "u1" } }),
  getCurrentUserId: async () => "u1",
  getCurrentWorkspaceId: async () => "w1",
}));

vi.mock("@/lib/db/client", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_m, method: string) => () => {
              if (model === "workspaceMember" && method === "findFirst") {
                return Promise.resolve({ workspaceId: "w1", role: state.role, workspace: { id: "w1" } });
              }
              state.touched.push(`${model}.${method}`);
              return Promise.reject(new Error(`unexpected database use: ${model}.${method}`));
            },
          },
        ),
    },
  ),
}));

const API = path.resolve(__dirname, "../app/api");
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function call(route: string, method: Method): Promise<number> {
  const mod = (await import(/* @vite-ignore */ path.join(API, route, "route.ts"))) as Record<string, (r: Request, c: unknown) => Promise<Response>>;
  const request = new Request("http://localhost/api/x?id=x&accountId=x", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({}),
  });
  try {
    return (await mod[method](request, { params: Promise.resolve({ id: "x" }) })).status;
  } catch {
    return 500; // got past the role check and failed on the empty database
  }
}

const MANAGER_ONLY: [string, Method][] = [
  ["commands", "POST"],
  ["commands/[id]", "PATCH"],
  ["commands/[id]", "DELETE"],
  ["forms", "POST"],
  ["forms/[id]", "PUT"],
  ["forms/[id]", "DELETE"],
  ["sequences", "POST"],
  ["sequences/[id]", "PUT"],
  ["sequences/[id]", "DELETE"],
  ["showcases", "POST"],
  ["showcases/[id]", "PUT"],
  ["showcases/[id]", "DELETE"],
  ["media", "POST"],
  ["media/[id]", "DELETE"],
  ["simulator", "GET"],
  ["simulator", "POST"],
  ["ai/test", "POST"],
  ["contacts/export", "GET"],
  ["sms/campaigns/preview", "POST"],
  ["sms/campaigns", "POST"],
  ["sms/test", "POST"],
  ["automations", "POST"],
  ["automations", "DELETE"],
];

const MEMBER_ALLOWED: [string, Method][] = [
  ["commands", "GET"],
  ["commands/[id]", "GET"],
  ["forms", "GET"],
  ["forms/[id]", "GET"],
  ["forms/[id]/results", "GET"],
  ["sequences", "GET"],
  ["showcases", "GET"],
  ["contacts", "GET"],
  ["contacts/[id]", "PATCH"],
  ["logs", "GET"],
  ["reports", "GET"],
  ["media", "GET"],
];

beforeEach(() => {
  state.touched.length = 0;
});

describe("a plain member", () => {
  it.each(MANAGER_ONLY)("cannot use %s %s, and nothing is read or written", async (route, method) => {
    state.role = "MEMBER";
    expect(await call(route, method)).toBe(403);
    expect(state.touched).toEqual([]);
  });

  it.each(MEMBER_ALLOWED)("can still use %s %s", async (route, method) => {
    state.role = "MEMBER";
    expect(await call(route, method)).not.toBe(403);
  });
});

describe("an admin", () => {
  it.each(MANAGER_ONLY)("is let past the role check on %s %s", async (route, method) => {
    state.role = "ADMIN";
    expect(await call(route, method)).not.toBe(403);
  });
});
