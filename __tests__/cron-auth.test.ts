import { describe, expect, it } from "vitest";
import { isAuthorizedCronRequest } from "../lib/net/cron-auth";

const SECRET = "a-long-random-cron-secret";
const request = (authorization?: string) => new Request("http://x/api/cron/y", { headers: authorization ? { authorization } : {} });

describe("cron authorization", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}`), SECRET)).toBe(true);
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}x`), SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET.slice(1)}`), SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(request(SECRET), SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(request(), SECRET)).toBe(false);
  });

  it("refuses everything when no secret is configured, including the literal 'Bearer undefined'", () => {
    for (const secret of [undefined, "", "short"]) {
      expect(isAuthorizedCronRequest(request("Bearer undefined"), secret)).toBe(false);
      expect(isAuthorizedCronRequest(request("Bearer "), secret)).toBe(false);
      expect(isAuthorizedCronRequest(request("Bearer short"), secret)).toBe(false);
    }
  });
});
