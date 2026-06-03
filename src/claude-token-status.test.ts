/**
 * Tests for the `~/.claude.json` status reader. Drives the file at a tmp
 * path via the `CLAUDE_CONFIG_DIR` override env to avoid touching the real
 * operator's claude config.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSetupTokenStatus,
  resolveClaudeConfigPath,
} from "./claude-token-status.ts";

function seed(dir: string, body: unknown): string {
  const path = join(dir, ".claude.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

// Pin the platform explicitly in token-absence tests so the expected verdict
// is deterministic across host OSes (on macOS, file-absence maps to `unknown`,
// not `not-configured` — the credential may live in the login keychain).
const LINUX: NodeJS.Platform = "linux";
const DARWIN: NodeJS.Platform = "darwin";

describe("claude-token-status", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-claude-token-"));
    env = { CLAUDE_CONFIG_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolveClaudeConfigPath honors CLAUDE_CONFIG_DIR", () => {
    expect(resolveClaudeConfigPath(env)).toBe(join(dir, ".claude.json"));
  });

  test("not-configured when file is missing (non-macOS)", () => {
    expect(readSetupTokenStatus(env, Date.now(), LINUX)).toBe("not-configured");
  });

  test("not-configured when file is empty (non-macOS)", () => {
    seed(dir, "");
    expect(readSetupTokenStatus(env, Date.now(), LINUX)).toBe("not-configured");
  });

  test("unknown when file is unparseable", () => {
    seed(dir, "{not json");
    expect(readSetupTokenStatus(env)).toBe("unknown");
  });

  test("configured when oauthAccount.accessToken is present", () => {
    seed(dir, { oauthAccount: { accessToken: "sk-ant-xxxx" } });
    expect(readSetupTokenStatus(env)).toBe("configured");
  });

  test("configured when top-level accessToken is present (older shape)", () => {
    seed(dir, { accessToken: "sk-ant-xxxx" });
    expect(readSetupTokenStatus(env)).toBe("configured");
  });

  test("expired when oauthAccount.expiresAt is in the past", () => {
    seed(dir, {
      oauthAccount: { accessToken: "sk-ant-xxxx", expiresAt: 1_000_000 },
    });
    expect(readSetupTokenStatus(env, 2_000_000_000)).toBe("expired");
  });

  test("configured when expiresAt is in the future", () => {
    seed(dir, {
      oauthAccount: { accessToken: "sk-ant-xxxx", expiresAt: 9_999_999_999_000 },
    });
    expect(readSetupTokenStatus(env)).toBe("configured");
  });

  test("not-configured when oauthAccount block exists but accessToken empty (non-macOS)", () => {
    seed(dir, { oauthAccount: { accessToken: "" } });
    expect(readSetupTokenStatus(env, Date.now(), LINUX)).toBe("not-configured");
  });

  test("not-configured when file is an object with no token-shaped fields (non-macOS)", () => {
    seed(dir, { otherField: 1, deeply: { nested: {} } });
    expect(readSetupTokenStatus(env, Date.now(), LINUX)).toBe("not-configured");
  });

  test("unknown when file is a JSON array (unreadable shape)", () => {
    seed(dir, ["not", "an", "object"]);
    expect(readSetupTokenStatus(env)).toBe("unknown");
  });

  test("handles seconds-since-epoch expiresAt (auto-promoted to ms)", () => {
    // Token expires at second 1_000_000 — well in the past for now > 1e12 ms.
    seed(dir, {
      oauthAccount: { accessToken: "x", expiresAt: 1_000_000 },
    });
    expect(readSetupTokenStatus(env, Date.now())).toBe("expired");
  });

  // --- macOS advisory behavior -------------------------------------------
  // On macOS the credential may live in the login keychain, so file-absence
  // is NOT definitive — it maps to `unknown` (advisory), deferring to the
  // live `claude -p` probe rather than falsely reporting "not configured."

  test("macOS: missing file → unknown (keychain may hold the credential)", () => {
    expect(readSetupTokenStatus(env, Date.now(), DARWIN)).toBe("unknown");
  });

  test("macOS: file present but no token-shaped field → unknown, not not-configured", () => {
    seed(dir, { otherField: 1 });
    expect(readSetupTokenStatus(env, Date.now(), DARWIN)).toBe("unknown");
  });

  test("macOS: a real token in the file is still authoritative → configured", () => {
    // A file-based setup-token sidesteps the keychain — when one is present we
    // still report `configured` on macOS.
    seed(dir, { oauthAccount: { accessToken: "sk-ant-xxxx" } });
    expect(readSetupTokenStatus(env, Date.now(), DARWIN)).toBe("configured");
  });
});
