/**
 * Hub-issued JWT validation for scribe.
 *
 * Mirrors `parachute-vault/src/hub-jwt.ts` (the canonical implementation) with
 * scribe's narrower needs:
 *   - No per-resource audience binding — scribe is a single endpoint, not
 *     a multi-vault dispatcher. We accept any aud claim.
 *   - Only the `scope` claim is surfaced; downstream is `scribe:transcribe`
 *     vs `scribe:admin` exact-match enforcement.
 *
 * Trust pin: `iss` MUST equal the configured hub origin. Without that check,
 * a token signed by any RSA key would pass.
 */
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from "jose";

const DEFAULT_HUB_LOOPBACK = "http://127.0.0.1:1939";

export function getHubOrigin(): string {
  const env = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  return DEFAULT_HUB_LOOPBACK;
}

/**
 * A presented bearer token is JWT-shaped iff it begins with `eyJ` — the
 * base64url encoding of `{"` from a `{"alg":...}` JSON header. Cheap
 * pre-check so non-JWT tokens (the SCRIBE_AUTH_TOKEN shared secret) skip
 * JWKS verification entirely.
 */
export function looksLikeJwt(token: string): boolean {
  return token.startsWith("eyJ");
}

export interface HubJwtClaims {
  sub: string;
  scopes: string[];
}

export class HubJwtError extends Error {
  override name = "HubJwtError";
}

type JwksGetter = ReturnType<typeof createRemoteJWKSet>;
let cachedGetter: JwksGetter | null = null;
let cachedOrigin: string | null = null;

function getJwksGetter(origin: string): JwksGetter {
  if (cachedGetter && cachedOrigin === origin) return cachedGetter;
  cachedGetter = createRemoteJWKSet(new URL(`${origin}/.well-known/jwks.json`), {
    cacheMaxAge: 5 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  cachedOrigin = origin;
  return cachedGetter;
}

export function resetJwksCache(): void {
  cachedGetter = null;
  cachedOrigin = null;
}

export async function validateHubJwt(token: string): Promise<HubJwtClaims> {
  const origin = getHubOrigin();
  const getter = getJwksGetter(origin);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getter, { issuer: origin });
    payload = verified.payload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HubJwtError(`hub JWT verification failed: ${msg}`);
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new HubJwtError("hub JWT missing required `sub` claim");
  }

  const scopeRaw = (payload as { scope?: unknown }).scope;
  const scopes =
    typeof scopeRaw === "string"
      ? scopeRaw.split(/\s+/).map((s) => s.trim()).filter(Boolean)
      : [];

  return { sub: payload.sub, scopes };
}
