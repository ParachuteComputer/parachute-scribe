/**
 * Single seam for all authorization decisions.
 *
 * Two token shapes coexist:
 *   - **Shared secret** — opaque string compared against `SCRIBE_AUTH_TOKEN`.
 *     A match grants the full scope set (`scribe:transcribe scribe:admin`).
 *     This is the legacy / loopback / first-party path; vault auto-wires its
 *     scribe calls through this.
 *   - **Hub-issued JWT** — `eyJ…`-shaped token verified against the hub's
 *     JWKS (`PARACHUTE_HUB_ORIGIN/.well-known/jwks.json`, default loopback
 *     `http://127.0.0.1:1939`). Granted scopes come from the token's `scope`
 *     claim and are enforced exact-match per route.
 *
 * Open mode (`SCRIBE_AUTH_TOKEN` unset) preserves current behavior: no auth
 * check, no scope check. Loopback-trusted by configuration.
 *
 * Per-route scope mapping happens in the server, not here — this seam decides
 * "valid? what scopes?", not "does this scope satisfy this route?".
 */

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { HubJwtError, looksLikeJwt, validateHubJwt } from "./hub-jwt.ts";

export const SCOPE_TRANSCRIBE = "scribe:transcribe" as const;
export const SCOPE_ADMIN = "scribe:admin" as const;

/**
 * Scopes a shared-secret bearer (or open-mode pass-through) is treated as
 * carrying. The shared secret is owner-equivalent — granting both verbs lets
 * the existing first-party flow keep working unchanged after JWT enforcement
 * lands.
 */
const FULL_SCOPES: readonly string[] = [SCOPE_TRANSCRIBE, SCOPE_ADMIN];

export type AuthResult =
  | { valid: true; scopes: readonly string[]; mode: "open" | "shared-secret" | "hub-jwt" }
  | { valid: false; reason: "token-required" | "token-mismatch" | "jwt-invalid"; message?: string };

export const AUTH_EXEMPT_PATHS = new Set(["/health", "/.parachute/info"]);

/**
 * Paths whose GET responses are the admin SPA *page render* — no auth required
 * so the browser can load the HTML (which then mints its own Bearer from the
 * hub and attaches it to subsequent data/mutation fetches). Mirrors the pattern
 * channel's admin page uses.
 *
 * ONLY the bare page-path is in this set. Sub-paths like `/admin/backend-availability`
 * and `/admin/clear-credential/*` are NOT here — those remain `scribe:admin`-gated
 * via `requiredScopeFor`.
 */
export const ADMIN_PAGE_PATHS = new Set(["/admin", "/scribe/admin"]);

export function extractBearer(authHeader: string | null | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

/**
 * Resolve a presented token to an AuthResult. JWT-shaped tokens go through
 * hub JWKS verification; everything else falls back to the shared-secret
 * compare. When SCRIBE_AUTH_TOKEN is unset, all callers pass with full scopes
 * — open mode is loopback-trusted.
 */
export async function validateToken(token: string | undefined): Promise<AuthResult> {
  const required = process.env.SCRIBE_AUTH_TOKEN;
  if (!required) return { valid: true, scopes: FULL_SCOPES, mode: "open" };
  if (!token) return { valid: false, reason: "token-required" };

  if (looksLikeJwt(token)) {
    try {
      const claims = await validateHubJwt(token);
      return { valid: true, scopes: claims.scopes, mode: "hub-jwt" };
    } catch (err) {
      // Revocation-related codes get sanitized client messages: server-side
      // audit log carries the full diagnostic (jti for `revoked`,
      // implementation-detail phrasing for `revocation_unavailable`); the
      // unauthenticated caller gets a code-shaped sentence with no internals.
      // Inheritable pattern across vault/scribe/agent — all revocation-related
      // codes get sanitized client messages, full detail lives in server-side
      // audit logs. Other HubJwtError codes (signature, audience, expired,
      // etc.) carry generic messages and are forwarded as-is.
      if (err instanceof HubJwtError && err.code === "revoked") {
        console.warn(`[scribe-auth] hub JWT rejected: ${err.message}`);
        return { valid: false, reason: "jwt-invalid", message: "token has been revoked" };
      }
      if (err instanceof HubJwtError && err.code === "revocation_unavailable") {
        console.warn(`[scribe-auth] hub JWT rejected: ${err.message}`);
        return {
          valid: false,
          reason: "jwt-invalid",
          message: "token cannot be validated: revocation list unavailable",
        };
      }
      const message = err instanceof HubJwtError ? err.message : err instanceof Error ? err.message : "JWT validation failed";
      return { valid: false, reason: "jwt-invalid", message };
    }
  }

  if (!constantTimeStringEqual(token, required)) {
    return { valid: false, reason: "token-mismatch" };
  }
  return { valid: true, scopes: FULL_SCOPES, mode: "shared-secret" };
}

/**
 * Constant-time string compare for the shared-secret path. The risk on a
 * loopback-only deployment is negligible (an attacker with same-host access
 * has bigger problems), but timing-safe is the standard hygiene for any
 * secret compare. `timingSafeEqual` requires equal-length buffers; the
 * length pre-check leaks length only — the secret length is fixed per
 * deployment, not the secret itself, so this is fine.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function isAuthRequired(): boolean {
  return Boolean(process.env.SCRIBE_AUTH_TOKEN);
}

/**
 * Bridge a token configured on disk (`config.json` `auth.required_token`)
 * into `SCRIBE_AUTH_TOKEN` so the env-driven auth gate (`isAuthRequired` /
 * `validateToken`) actually enforces it.
 *
 * The hub's install-time auto-wire writes the shared secret into scribe's
 * `config.json` (`{ auth: { required_token: "<value>" } }`) but does NOT
 * export `SCRIBE_AUTH_TOKEN` into scribe's process env. Without this bridge,
 * `isAuthRequired()` (which reads only the env var) returns false even when a
 * token IS configured — so scribe ran fully open despite the operator having
 * set a secret. See scribe#66.
 *
 * Precedence: an explicit `SCRIBE_AUTH_TOKEN` in the env always wins — the
 * operator (or a supervisor) set it deliberately, and we never silently
 * override it with the on-disk value. Only when the env var is unset/blank do
 * we adopt the config token. Returns the source that won so the caller can
 * log it; mutates `env` in place (default `process.env`) so `validateToken`
 * sees the bridged value.
 */
export function bridgeConfigAuthToken(
  configuredToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): "env" | "config" | "none" {
  const fromEnv = env.SCRIBE_AUTH_TOKEN;
  if (fromEnv && fromEnv.trim()) return "env";
  if (configuredToken && configuredToken.trim()) {
    env.SCRIBE_AUTH_TOKEN = configuredToken;
    return "config";
  }
  return "none";
}

/**
 * Operator footgun guard. The shared-secret compare in `validateToken` runs
 * AFTER the JWT-shape branch — so if SCRIBE_AUTH_TOKEN itself starts with
 * `eyJ` (the base64 prefix of a JWT header), inbound bearers matching that
 * value get routed into JWKS verification and fail with `jwt-invalid` rather
 * than ever reaching the shared-secret compare. Warn loudly at startup so
 * the operator notices before clients start 401-ing.
 */
export function warnIfTokenLooksJwt(): void {
  const token = process.env.SCRIBE_AUTH_TOKEN;
  if (token && looksLikeJwt(token)) {
    console.warn(
      "[scribe] SCRIBE_AUTH_TOKEN looks JWT-shaped (eyJ… prefix). " +
        "Inbound bearers matching this value will be routed to hub JWKS verification " +
        "instead of shared-secret compare and will likely 401. " +
        "Pick an opaque value (e.g. `openssl rand -hex 32`).",
    );
  }
}

export function unauthorizedResponse(reason?: string): Response {
  return Response.json(
    { error: "unauthorized", message: reason ?? "SCRIBE_AUTH_TOKEN required" },
    { status: 401 },
  );
}

/**
 * 403 response for a valid bearer that lacks the scope a route requires.
 * Shape matches the canonical pattern in `parachute-patterns/patterns/oauth-scopes.md`
 * — `error_type: "insufficient_scope"` is the machine-readable key clients
 * branch on to show "reconnect with broader access" UI.
 */
export function insufficientScopeResponse(required: string, granted: readonly string[]): Response {
  return Response.json(
    {
      error: "Forbidden",
      error_type: "insufficient_scope",
      message: `This endpoint requires the '${required}' scope.`,
      required_scope: required,
      granted_scopes: granted,
    },
    { status: 403 },
  );
}

/** Exact-match scope check. Non-vault scopes don't inherit (per oauth-scopes.md). */
export function hasScope(granted: readonly string[], required: string): boolean {
  return granted.includes(required);
}

/**
 * Resolve auth + return either a 401 response or the granted scope list.
 * Exempt paths (`/health`, `/.parachute/info`) skip auth entirely.
 * Admin SPA page-render paths (`/admin`, `/scribe/admin`) also skip auth so
 * the browser can load the HTML; the page's inline JS then mints its own
 * Bearer from the hub and attaches it to every data/mutation call. This
 * mirrors channel's admin page pattern. Full scopes are granted so the
 * scope gate in `route()` passes — the page render itself is safe to serve
 * open (it contains no secrets), and all actual data endpoints remain gated.
 */
export async function enforceAuth(
  req: Request,
  pathname: string,
): Promise<Response | { scopes: readonly string[] }> {
  if (AUTH_EXEMPT_PATHS.has(pathname)) return { scopes: FULL_SCOPES };
  // Admin SPA page: exempt for GET only — POST/PUT to these paths (there are
  // none today but be explicit) still go through normal auth.
  if (ADMIN_PAGE_PATHS.has(pathname) && req.method === "GET") return { scopes: FULL_SCOPES };
  const token = extractBearer(req.headers.get("authorization"));
  const result = await validateToken(token);
  if (result.valid) return { scopes: result.scopes };
  if (result.reason === "jwt-invalid") {
    return unauthorizedResponse(result.message ?? "JWT validation failed");
  }
  return unauthorizedResponse();
}
