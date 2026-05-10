/**
 * Hub-issued JWT validation. Scribe as resource server: trusts tokens that the
 * hub signs against keys we fetch from the hub's `/.well-known/jwks.json`.
 *
 * The trust kernel — JWKS fetch + verify, issuer pin, RFC 7519 string-or-array
 * `aud` handling — lives in the shared `@openparachute/scope-guard` library
 * so vault, scribe, and paraclaw can't silently drift on the worst place to
 * drift. This file is the scribe-side adapter: hub-origin resolution
 * (env-var precedence + loopback fallback), a process-wide guard instance,
 * and re-exports preserving the public surface every existing call site
 * already imports.
 *
 * Scribe is a single endpoint, not a multi-resource dispatcher — we don't pass
 * `expectedAudience`. The lib's claim shape is richer than what scribe's
 * callers historically used (it surfaces `aud`, `jti`, `clientId` in addition
 * to `sub`/`scopes`). That's additive — `auth.ts` only consumes `scopes`.
 *
 * Scope-guard adoption: Step 3 of 4 (after vault, before paraclaw).
 */
import {
  createScopeGuard,
  HubJwtError,
  type HubJwtClaims,
  looksLikeJwt,
} from "@openparachute/scope-guard";

const DEFAULT_HUB_LOOPBACK = "http://127.0.0.1:1939";

/**
 * Resolve the hub origin used to fetch JWKS and validate `iss`. Strips a
 * trailing slash so we get a single canonical form.
 *
 * Order: env var → loopback fallback. We deliberately don't read
 * `~/.parachute/services.json` — the hub is the dispatcher, not a registered
 * service in that file. If a deployment exposes the hub on a non-default
 * origin, the env var is the contract.
 */
export function getHubOrigin(): string {
  const env = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  return DEFAULT_HUB_LOOPBACK;
}

// Process-wide guard. The resolver form lets tests flip
// `PARACHUTE_HUB_ORIGIN` between cases — the lib re-resolves on every
// `validateHubJwt` and `resetJwksCache` call so the env-var change picks up
// without a server restart. JWKS cache (5min/30s defaults) lives inside the
// guard, shared across requests.
const guard = createScopeGuard({ hubOrigin: () => getHubOrigin() });

/**
 * Verify a presented JWT against the hub's JWKS. Throws `HubJwtError` on any
 * failure (bad signature, wrong issuer, expired, missing kid, JWKS
 * unreachable). On success returns the surfaced claims plus the parsed
 * scope list.
 *
 * Trust pin: `iss` MUST equal the configured hub origin. Without that check,
 * a token signed by any RSA key would pass verification.
 */
export async function validateHubJwt(token: string): Promise<HubJwtClaims> {
  return guard.validateHubJwt(token);
}

/**
 * Reset the cached JWKS getter. Tests use this to switch origins between
 * cases; production callers shouldn't need it (origin is process-stable).
 */
export function resetJwksCache(): void {
  guard.resetJwksCache();
}

/**
 * Reset the cached revocation list. Tests use this to start from a clean
 * fail-closed state between cases; production callers shouldn't need it
 * (the cache refreshes itself on TTL expiry).
 */
export function resetRevocationCache(): void {
  guard.resetRevocationCache();
}

export { HubJwtError, looksLikeJwt };
export type { HubJwtClaims };
