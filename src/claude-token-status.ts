/**
 * Read-only signal: does `~/.claude.json` carry a usable Claude Code
 * subscription token?
 *
 * The `claude-code` cleanup provider doesn't take an API key — it shells to
 * the `claude` CLI which reads its credentials from `~/.claude.json`
 * (populated by `claude setup-token`). The SPA can't run that command for
 * the operator (browser can't open a subprocess on the host); it can only
 * surface a status pill + a Refresh button. This module is the read side.
 *
 * Status values:
 *
 *   - `configured`    — file exists + carries a token-shaped field.
 *   - `not-configured` — file doesn't exist OR carries no token-shaped field.
 *   - `expired`       — file carries a token field with an explicit expiry
 *                       in the past (Claude Code rotates these — see the
 *                       `expiresAt` field on `oauthAccount` blocks).
 *   - `unknown`       — file exists but unreadable / unparseable. Surfaced
 *                       so the SPA can show "couldn't determine" rather than
 *                       falsely claim "not configured."
 *
 * What we look for:
 *
 *   `~/.claude.json` is a JSON object that (when claude setup-token has run)
 *   carries an `oauthAccount` block with `accessToken` + `expiresAt`. The
 *   exact shape isn't a stable contract — Anthropic owns it — so this reader
 *   is permissive: if anything that *looks like* a token field is present,
 *   we report `configured`; if the file carries an expiry field that's a
 *   past timestamp, we report `expired`.
 *
 * Honors `HOME` and `CLAUDE_CONFIG_DIR` (the CLI's own override env) so
 * test fixtures + alternate-home setups work without coupling to a real
 * `$HOME`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { SetupTokenStatus } from "./config-schema.ts";

/** Resolve the path to `~/.claude.json`. Test-overridable via `CLAUDE_CONFIG_DIR`. */
export function resolveClaudeConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.CLAUDE_CONFIG_DIR;
  const base = explicit ?? env.HOME ?? homedir();
  return join(base, ".claude.json");
}

type RawClaudeConfig = Record<string, unknown>;

function safeReadJson(path: string): RawClaudeConfig | "unreadable" | "missing" {
  if (!existsSync(path)) return "missing";
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.trim() === "") return "missing";
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RawClaudeConfig;
    }
    return "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * Heuristic: does this object carry a token-shaped field anywhere we look?
 *
 * We accept any of the known shapes seen in real `~/.claude.json` files:
 *
 *   - `oauthAccount.accessToken` — current shape from `claude setup-token`
 *   - `oauthAccount.access_token` — defensively, snake_case variant
 *   - `accessToken` at top level — older shape
 *   - `tokens.<provider>.accessToken` — possible future shape
 *
 * Returns the expiry timestamp if one is found alongside the token, else
 * undefined.
 */
function findToken(
  obj: RawClaudeConfig,
): { found: false } | { found: true; expiresAt?: number } {
  const candidates: Array<{ token?: unknown; expiry?: unknown }> = [];

  const oauthAccount = obj.oauthAccount;
  if (oauthAccount && typeof oauthAccount === "object" && !Array.isArray(oauthAccount)) {
    const oa = oauthAccount as Record<string, unknown>;
    candidates.push({
      token: oa.accessToken ?? oa.access_token,
      expiry: oa.expiresAt ?? oa.expires_at,
    });
  }
  // Top-level fallback shapes.
  candidates.push({
    token: obj.accessToken ?? obj.access_token,
    expiry: obj.expiresAt ?? obj.expires_at,
  });
  // Per-provider nested.
  const tokens = obj.tokens;
  if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
    for (const v of Object.values(tokens as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const t = v as Record<string, unknown>;
        candidates.push({
          token: t.accessToken ?? t.access_token,
          expiry: t.expiresAt ?? t.expires_at,
        });
      }
    }
  }

  for (const c of candidates) {
    if (typeof c.token === "string" && c.token.length > 0) {
      const expiry = parseExpiry(c.expiry);
      return expiry !== undefined ? { found: true, expiresAt: expiry } : { found: true };
    }
  }
  return { found: false };
}

function parseExpiry(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Both ms-since-epoch and seconds-since-epoch are common. Treat numbers
    // below ~10**12 as seconds and bump to ms; everything else as ms.
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === "string" && raw.length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n)) return parseExpiry(n);
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/**
 * Return the current setup-token status. Pure-read, no side effects, fast
 * (single file read + parse). The endpoint that calls this is rate-limited
 * by the SPA's Refresh button, not by us.
 */
export function readSetupTokenStatus(
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): SetupTokenStatus {
  const path = resolveClaudeConfigPath(env);
  const result = safeReadJson(path);
  if (result === "missing") return "not-configured";
  if (result === "unreadable") return "unknown";

  const token = findToken(result);
  if (!token.found) return "not-configured";
  if (token.expiresAt !== undefined && token.expiresAt < now) return "expired";
  return "configured";
}
