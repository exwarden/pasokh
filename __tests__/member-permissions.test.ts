/**
 * What each role may do on every API route.
 *
 * A route is called with a given role and an in-memory stand-in for the
 * database that records every query. The test then checks, per route:
 *   - the exact status (403 for a member on a manager-only route; the same
 *     status as an admin everywhere a member is allowed);
 *   - that nothing was read or written on the way to a 403;
 *   - that every query that did run carries the caller's workspace id.
 *
 * The list of routes is read from disk. A route or method that is in neither
 * the matrix nor PUBLIC fails the test, so a new endpoint cannot ship without
 * someone deciding who may call it. The status listed for each entry is what an
 * empty request gets from the route past the role check (400 validation, 404
 * unknown id, ...); pinning it makes a silent change of behaviour show up here.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Role = "MEMBER" | "ADMIN" | "OWNER";
type Call = { model: string; method: string; args: unknown };

const state = vi.hoisted(() => ({ role: "MEMBER" as Role, calls: [] as Call[] }));

vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: "u1" } }),
  getCurrentUserId: async () => "u1",
  getCurrentWorkspaceId: async () => "w1",
}));

// No Redis in this test: a route that reaches for the queue gets an object
// whose every method answers at once with nothing, instead of waiting for a
// connection that will never come.
const idle = vi.hoisted(() => {
  const handler: ProxyHandler<object> = { get: (_t, prop) => (prop === "then" ? undefined : new Proxy(() => Promise.resolve([]), handler)) };
  return new Proxy(() => Promise.resolve([]), handler) as never;
});
vi.mock("@/lib/queue/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRedisConnection: () => idle,
  getDMQueue: () => idle,
}));

const READS_EMPTY: Record<string, unknown> = {
  findFirst: null,
  findUnique: null,
  findMany: [],
  count: 0,
  groupBy: [],
  aggregate: { _sum: {}, _count: 0 },
};

vi.mock("@/lib/db/client", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_m, method: string) => (args: unknown) => {
              if (model === "workspaceMember" && method === "findFirst") {
                return Promise.resolve({ workspaceId: "w1", userId: "u1", role: state.role, workspace: { id: "w1" } });
              }
              state.calls.push({ model, method, args });
              if (method in READS_EMPTY) return Promise.resolve(READS_EMPTY[method]);
              // A write is recorded (a 403 must leave state.calls empty) and succeeds.
              return Promise.resolve({ id: "x", count: 0 });
            },
          },
        ),
    },
  ),
}));

const API = path.resolve(__dirname, "../app/api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

async function call(route: string, method: Method): Promise<{ status: number; location: string }> {
  const mod = (await import(/* @vite-ignore */ path.join(API, route, "route.ts"))) as Record<string, (r: NextRequest, c: unknown) => Promise<Response>>;
  const request = new NextRequest("http://localhost/api/x?id=x&accountId=x&instagramAccountId=x", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({}),
  });
  try {
    const response = await mod[method](request, { params: Promise.resolve({ id: "x", workspaceId: "w1" }) });
    return { status: response.status, location: response.headers.get("location") ?? "" };
  } catch {
    return { status: 500, location: "" }; // threw past the role check, on the empty database
  }
}

/**
 * [route directory, method, status an authorised caller gets for an empty
 * request, status a plain member gets (403 unless the route redirects)].
 */
type Entry = [string, Method, number, number?];

/** Changing or removing shared configuration, or sending in bulk: owners and admins only. */
const MANAGER_ONLY: Entry[] = [
  ["commands", "POST", 400],
  ["commands/[id]", "PATCH", 404],
  ["commands/[id]", "DELETE", 404],
  ["forms", "POST", 400],
  ["forms/[id]", "PUT", 404],
  ["forms/[id]", "DELETE", 404],
  ["sequences", "POST", 400],
  ["sequences/[id]", "PUT", 404],
  ["sequences/[id]", "DELETE", 404],
  ["showcases", "POST", 400],
  ["showcases/[id]", "PUT", 404],
  ["showcases/[id]", "DELETE", 404],
  ["media", "POST", 400],
  ["media/[id]", "DELETE", 404],
  ["simulator", "GET", 200],
  ["simulator", "POST", 400],
  ["ai", "PUT", 400],
  ["ai/test", "POST", 400],
  ["contacts/export", "GET", 200],
  ["sms/campaigns", "POST", 400],
  ["sms/campaigns/[id]", "PATCH", 404],
  ["sms/campaigns/preview", "POST", 400],
  ["sms/settings", "PUT", 400],
  ["sms/test", "POST", 400],
  ["automations", "POST", 400],
  ["automations", "PATCH", 404],
  ["automations", "DELETE", 404],
  ["automations/import", "POST", 400],
  ["automations/duplicate", "POST", 404],
  ["templates", "POST", 400],
  ["ice-breakers", "PUT", 400],
  ["instagram/connect", "GET", 307, 307],
  ["instagram/disconnect", "POST", 200],
  ["workspace/members", "POST", 400],
  ["workspace/members", "PATCH", 400],
  ["workspace/members", "DELETE", 400],
  ["zernio/accounts", "POST", 400],
  ["zernio/connect", "POST", 400],
  ["zernio/settings", "GET", 200],
  ["zernio/settings", "POST", 400],
  ["zernio/settings", "PUT", 400],
  ["zernio/settings", "DELETE", 502],
];

/** A plain member may read, answer in the inbox and edit contacts. */
const MEMBER_ALLOWED: Entry[] = [
  ["commands", "GET", 200],
  ["commands/[id]", "GET", 404],
  ["forms", "GET", 200],
  ["forms/[id]", "GET", 404],
  ["forms/[id]/results", "GET", 404],
  ["sequences", "GET", 200],
  ["sequences/[id]", "GET", 404],
  ["showcases", "GET", 200],
  ["showcases/[id]", "GET", 404],
  ["media", "GET", 200],
  ["contacts", "GET", 200],
  ["contacts/[id]", "PATCH", 404],
  ["logs", "GET", 200],
  ["reports", "GET", 200],
  ["ai", "GET", 404],
  ["automations", "GET", 200],
  ["ice-breakers", "GET", 404],
  ["sms/recipients", "GET", 200],
  ["sms/campaigns", "GET", 200],
  ["sms/settings", "GET", 200],
  ["workspace/members", "GET", 200],
  ["dashboard/stats", "GET", 200],
  ["admin/diagnostics", "GET", 200],
  ["instagram/accounts", "GET", 200],
  ["instagram/conversations", "GET", 400],
  ["instagram/conversations", "POST", 400],
  ["instagram/conversations/[id]", "GET", 400],
  ["instagram/overview", "GET", 400],
  ["instagram/posts", "GET", 400],
  ["instagram/profile", "GET", 400],
  ["instagram/stories", "GET", 400],
];

/** No session by design; each has its own check, tested in protected-routes.test.ts. */
const PUBLIC = [
  "auth/[...nextauth]",
  "webhook",
  "zernio/webhook/[workspaceId]",
  "health",
  "cron/attach-next-reel",
  "cron/refresh-tokens",
  "cron/snapshot-followers",
  "cron/cleanup",
  "instagram/callback",
  "workspace/invitations/accept", // a signed-in user with the invitation token, checked against the invited email
];

function routeDirs(dir: string, base = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = base ? `${base}/${name}` : name;
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) return name === "route.ts" ? [base] : [];
    return routeDirs(full, rel);
  });
}

const key = ([route, method]: Entry) => `${method} ${route}`;

beforeEach(() => {
  state.calls.length = 0;
});

describe("the permission matrix covers every API route", { timeout: 60_000 }, () => {
  it("has no route or method outside MANAGER_ONLY, MEMBER_ALLOWED or PUBLIC", async () => {
    const known = new Set([...MANAGER_ONLY, ...MEMBER_ALLOWED].map(key));
    const unlisted: string[] = [];
    for (const dir of routeDirs(API)) {
      if (PUBLIC.includes(dir)) continue;
      const mod = (await import(/* @vite-ignore */ path.join(API, dir, "route.ts"))) as Record<string, unknown>;
      for (const method of METHODS) {
        if (typeof mod[method] === "function" && !known.has(`${method} ${dir}`)) unlisted.push(`${method} ${dir}`);
      }
    }
    expect(unlisted, "decide who may call these and add them to the matrix").toEqual([]);
  });

  it("lists nothing that no longer exists", async () => {
    const dirs = new Set(routeDirs(API));
    const gone: string[] = [];
    for (const entry of [...MANAGER_ONLY, ...MEMBER_ALLOWED]) {
      if (!dirs.has(entry[0])) {
        gone.push(key(entry));
        continue;
      }
      const mod = (await import(/* @vite-ignore */ path.join(API, entry[0], "route.ts"))) as Record<string, unknown>;
      if (typeof mod[entry[1]] !== "function") gone.push(key(entry));
    }
    expect(gone).toEqual([]);
    for (const p of PUBLIC) expect(dirs.has(p), `${p} is listed as public but does not exist`).toBe(true);
  });

  it("has no entry in both lists", () => {
    const manager = new Set(MANAGER_ONLY.map(key));
    expect(MEMBER_ALLOWED.map(key).filter((k) => manager.has(k))).toEqual([]);
  });
});

/**
 * Queries that are not filtered by the workspace id themselves. Each is
 * reached only with ids taken from an earlier query that was.
 */
const SCOPED_BY_EARLIER_QUERY = new Set([
  "smsMessage.groupBy", // campaign ids from smsCampaign.findMany({ where: { workspaceId } })
  "formSubmission.groupBy", // form ids from form.findMany({ where: { workspaceId } })
  "sequenceEnrollment.groupBy", // sequence ids from sequence.findMany({ where: { workspaceId } })
  "user.findUnique", // the caller's own row, by the session's user id
]);

/** Every query that ran must carry the caller's workspace id. */
function expectScoped(calls: Call[], label: string) {
  // The test lab reads and writes rows that hang off the workspace's own
  // simulator account, whose id comes from a scoped lookup made first.
  if (label.endsWith(" simulator")) return;
  for (const c of calls) {
    if (SCOPED_BY_EARLIER_QUERY.has(`${c.model}.${c.method}`)) continue;
    expect(JSON.stringify(c.args ?? null), `${label}: ${c.model}.${c.method} ran without the workspace id`).toContain('"w1"');
  }
}

describe("a plain member", { timeout: 30_000 }, () => {
  it.each(MANAGER_ONLY)("is refused %s %s and nothing is read or written", async (route, method, _admin, refusal = 403) => {
    state.role = "MEMBER";
    const result = await call(route, method);
    expect(result.status).toBe(refusal);
    if (refusal !== 403) expect(result.location, "a redirect refusal must say why").toContain("forbidden");
    expect(state.calls).toEqual([]);
  });

  it.each(MEMBER_ALLOWED)("can use %s %s and gets status %i, as an admin does", async (route, method, status) => {
    state.role = "MEMBER";
    expect((await call(route, method)).status).toBe(status);
    expectScoped(state.calls, `${method} ${route}`);
  });
});

describe("an admin", { timeout: 30_000 }, () => {
  it.each([...MANAGER_ONLY, ...MEMBER_ALLOWED])("gets %s %s past the role check, with status %i", async (route, method, status) => {
    state.role = "ADMIN";
    const result = await call(route, method);
    expect(result.status).toBe(status);
    expect(result.location).not.toContain("forbidden");
    expectScoped(state.calls, `${method} ${route}`);
  });
});

describe("an owner", { timeout: 30_000 }, () => {
  it.each(MANAGER_ONLY)("is let past the role check on %s %s", async (route, method, status) => {
    state.role = "OWNER";
    expect((await call(route, method)).status).toBe(status);
  });
});
