import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOAuthState,
  decryptToken,
  decryptTokenWithKeyInfo,
  encryptToken,
  verifyOAuthState,
} from "../lib/meta/oauth";

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
});

describe("OAuth state and token encryption", () => {
  it("round-trips encrypted tokens", () => {
    const encrypted = encryptToken("long-lived-token");
    expect(encrypted).not.toBe("long-lived-token");
    expect(decryptToken(encrypted)).toBe("long-lived-token");
  });

  it("signs and verifies Instagram OAuth state", () => {
    const state = createOAuthState("workspace_123", "user_1");
    expect(verifyOAuthState(state)?.workspaceId).toBe("workspace_123");
  });

  it("carries the user who started the connection", () => {
    expect(verifyOAuthState(createOAuthState("workspace_123", "user_1"))?.userId).toBe("user_1");
  });

  it("rejects tampered OAuth state", () => {
    const state = createOAuthState("workspace_123", "user_1");
    expect(verifyOAuthState(`${state}tampered`)).toBeNull();
  });
});

describe("rotating the encryption key", () => {
  const OLD = "a".repeat(64);
  const NEW = "b".repeat(64);
  const encryptedWith = (key: string, text: string) => {
    vi.stubEnv("ENCRYPTION_KEY", key);
    return encryptToken(text);
  };

  it("reads a secret written with the previous key once that key is listed, and says so", () => {
    const stored = encryptedWith(OLD, "ig-token");
    vi.stubEnv("ENCRYPTION_KEY", NEW);
    expect(() => decryptToken(stored)).toThrow();
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", `${"c".repeat(64)}, ${OLD}`);
    expect(decryptTokenWithKeyInfo(stored)).toEqual({ plaintext: "ig-token", previous: true });
  });

  it("writes with the current key, so a re-encrypted secret no longer needs the old one", () => {
    const stored = encryptedWith(OLD, "ig-token");
    vi.stubEnv("ENCRYPTION_KEY", NEW);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", OLD);
    const rotated = encryptToken(decryptToken(stored));
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "");
    expect(decryptTokenWithKeyInfo(rotated)).toEqual({ plaintext: "ig-token", previous: false });
  });

  it("still fails on a value no key can read", () => {
    const stranger = encryptedWith("d".repeat(64), "x");
    vi.stubEnv("ENCRYPTION_KEY", NEW);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", OLD);
    expect(() => decryptToken(stranger)).toThrow();
  });

  it("refuses a malformed previous key instead of ignoring it", () => {
    const stored = encryptedWith(OLD, "x");
    vi.stubEnv("ENCRYPTION_KEY", NEW);
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", "not-hex");
    expect(() => decryptToken(stored)).toThrow(/ENCRYPTION_KEY_PREVIOUS/);
  });
});
