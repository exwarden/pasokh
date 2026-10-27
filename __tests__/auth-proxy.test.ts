import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { config, proxy } from "../proxy";

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

describe("auth proxy", () => {
  it("sends a signed-out visitor from the dashboard to /login with a way back", () => {
    const response = proxy(request("/dashboard"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?callbackUrl=%2Fdashboard");
  });

  it("does not bounce /login to the dashboard on a cookie it cannot validate, which looped forever", () => {
    // A session cookie signed with another secret (reinstall, another app on
    // localhost) still *exists*; only the server can tell it is unreadable.
    expect(config.matcher).not.toContain("/login");
    const response = proxy(request("/login", "authjs.session-token=from-another-secret"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets a request with a session cookie through to the page, which checks the session itself", () => {
    const response = proxy(request("/dashboard", "__Secure-authjs.session-token=x"));
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("which pages the proxy guards", () => {
  const groupDir = path.resolve(__dirname, "../app/(dashboard)");
  // /reports is both a dashboard page and the prefix of public share links
  // (/reports/<slug>), so the proxy cannot guard it by prefix; its layout checks the session.
  const pageGuardedOnly = new Set(["reports"]);
  const folders = readdirSync(groupDir).filter((name) => statSync(path.join(groupDir, name)).isDirectory());

  it.each(folders.filter((f) => !pageGuardedOnly.has(f)))("sends a signed-out visitor from /%s to /login", (folder) => {
    expect(proxy(request(`/${folder}`)).headers.get("location")).toContain("/login?callbackUrl=");
    expect(proxy(request(`/${folder}/x`)).headers.get("location")).toContain("/login?callbackUrl=");
  });

  it.each(["contacts", "sms", "ai", "inbox"])("covers /%s in the matcher as well", (folder) => {
    expect(config.matcher).toContain(`/${folder}/:path*`);
  });

  it("does not guard public share links", () => {
    expect(proxy(request("/reports/some-share-slug")).headers.get("location")).toBeNull();
  });
});

it("keeps the literal matcher and the prefix list in step", () => {
  const redirected = config.matcher.map((m) => m.replace("/:path*", ""));
  for (const prefix of redirected) {
    expect(proxy(request(prefix)).headers.get("location"), prefix).toContain("/login");
  }
});
