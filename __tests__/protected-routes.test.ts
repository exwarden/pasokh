/**
 * Every API route that is not meant to be public must refuse a request with no
 * session before touching the database. The list of routes is read from disk,
 * so a route added later is covered without anyone remembering to add it here.
 *
 * Public by design, each with its own check (tested below or elsewhere):
 * Auth.js itself, the two webhooks (signature), cron (bearer secret), health,
 * and the Meta OAuth callback (redirects to login without a session).
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { touched } = vi.hoisted(() => ({ touched: [] as string[] }));

vi.mock("@/lib/auth", () => ({
  auth: async () => null,
  getCurrentUserId: async () => null,
  getCurrentWorkspaceId: async () => null,
  signIn: async () => undefined,
  signOut: async () => undefined,
  handlers: {},
  PASSWORD_PROVIDER_ID: "password",
  EMAIL_PROVIDER_ID: "nodemailer",
  isEmailLoginEnabled: () => false,
}));

// Alerting on a bad signature uses Redis; it is not what these tests are about.
vi.mock("@/lib/ops/webhook-alerts", () => ({ noteBadWebhookSignature: async () => undefined }));

// Any use of the database or the queue without a session is a failure.
vi.mock("@/lib/db/client", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, model: string) =>
        new Proxy(
          {},
          {
            get: (_t, method: string) => () => {
              touched.push(`${model}.${method}`);
              return Promise.reject(new Error(`database touched without a session: ${model}.${method}`));
            },
          },
        ),
    },
  ),
}));

const API_DIR = path.resolve(__dirname, "../app/api");
const PUBLIC = [
  "auth/[...nextauth]/route.ts",
  "webhook/route.ts",
  "zernio/webhook/[workspaceId]/route.ts",
  "health/route.ts",
  "cron/attach-next-reel/route.ts",
  "cron/refresh-tokens/route.ts",
  "cron/snapshot-followers/route.ts",
  "cron/cleanup/route.ts",
  "instagram/callback/route.ts",
];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function routeFiles(dir: string, base = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = base ? `${base}/${name}` : name;
    return statSync(path.join(dir, name)).isDirectory() ? routeFiles(path.join(dir, name), rel) : name === "route.ts" ? [rel] : [];
  });
}

beforeEach(() => {
  touched.length = 0;
});

const protectedRoutes = routeFiles(API_DIR).filter((f) => !PUBLIC.includes(f));

// The first import of a route pulls in its whole module graph; under a loaded machine that exceeded 10 s once.
describe("API routes without a session", { timeout: 30_000 }, () => {
  it("finds the routes to check", () => {
    expect(protectedRoutes.length).toBeGreaterThan(30);
  });

  for (const file of protectedRoutes) {
    it(`${file} refuses before reading or writing anything`, async () => {
      const mod = (await import(/* @vite-ignore */ path.join(API_DIR, file))) as Record<string, unknown>;
      const handlers = METHODS.filter((m) => typeof mod[m] === "function");
      expect(handlers.length, `${file} exports no HTTP handler`).toBeGreaterThan(0);

      for (const method of handlers) {
        const request = new Request("http://localhost/api/x?id=x&accountId=x&instagramAccountId=x", {
          method,
          headers: { "content-type": "application/json" },
          body: method === "GET" ? undefined : JSON.stringify({ id: "x" }),
        });
        const context = { params: Promise.resolve({ id: "x", workspaceId: "x", file: "x" }) };
        const response = (await (mod[method] as (r: Request, c: unknown) => Promise<Response>)(request, context)) as Response;
        const refused = response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400);
        expect(refused, `${method} ${file} answered ${response.status} with no session`).toBe(true);
      }
      expect(touched).toEqual([]);
    });
  }
});

describe("public routes with their own check", () => {
  it("cron endpoints reject a missing or wrong bearer secret", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-cron-secret-for-tests");
    for (const route of ["attach-next-reel", "refresh-tokens", "snapshot-followers", "cleanup"]) {
      const mod = await import(/* @vite-ignore */ path.join(API_DIR, `cron/${route}/route.ts`));
      const attempts: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: "Bearer undefined" }];
      for (const headers of attempts) {
        const response = await mod.GET(new Request("http://localhost/api/cron/x", { headers }) as never);
        expect(response.status, `${route} with ${JSON.stringify(headers)}`).toBe(401);
      }
    }
    expect(touched).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("the Meta webhook rejects an unsigned body", async () => {
    vi.stubEnv("FACEBOOK_APP_SECRET", "app-secret-for-tests");
    const mod = await import(/* @vite-ignore */ path.join(API_DIR, "webhook/route.ts"));
    const response = await mod.POST(new Request("http://localhost/api/webhook", { method: "POST", body: "{}" }) as never);
    expect(response.status).toBe(401);
    vi.unstubAllEnvs();
  });

  it("the OAuth callback sends a visitor with no session to the login page without exchanging a code", async () => {
    const mod = await import(/* @vite-ignore */ path.join(API_DIR, "instagram/callback/route.ts"));
    const response = await mod.GET(new NextRequest("http://localhost/api/instagram/callback?code=abc&state=forged"));
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location") ?? "").not.toContain("dashboard");
  });
});
