import { afterEach, describe, expect, it } from "vitest";
import { isSetupEnabled, setupTokenMatches } from "../lib/users/setup-token";

const original = process.env.SETUP_TOKEN;
afterEach(() => {
  if (original === undefined) delete process.env.SETUP_TOKEN;
  else process.env.SETUP_TOKEN = original;
});

describe("setup token", () => {
  it("first-run setup stays closed when SETUP_TOKEN is unset, so a fresh public install cannot be claimed by a stranger", () => {
    delete process.env.SETUP_TOKEN;
    expect(isSetupEnabled()).toBe(false);
    expect(setupTokenMatches("")).toBe(false);
    expect(setupTokenMatches(undefined)).toBe(false);
  });

  it("a token shorter than 16 characters counts as unset", () => {
    process.env.SETUP_TOKEN = "short";
    expect(isSetupEnabled()).toBe(false);
    expect(setupTokenMatches("short")).toBe(false);
  });

  it("accepts exactly the configured token", () => {
    process.env.SETUP_TOKEN = "0123456789abcdef0123";
    expect(isSetupEnabled()).toBe(true);
    expect(setupTokenMatches("0123456789abcdef0123")).toBe(true);
    expect(setupTokenMatches(" 0123456789abcdef0123 ")).toBe(true);
    expect(setupTokenMatches("0123456789abcdef0124")).toBe(false);
    expect(setupTokenMatches("")).toBe(false);
  });
});
