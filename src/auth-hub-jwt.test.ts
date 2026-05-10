/**
 * Integration tests for the hub-JWT path through scribe's auth boundary.
 *
 * Scope:
 *   - signed valid JWT (not in revocation list) → accepted with hub-jwt mode
 *   - revoked jti rejected (revocation list integration; client-facing
 *     message is sanitized so the jti doesn't leak)
 *   - revocation list unavailable on cold start → fail-closed 401 sanitized
 *
 * Each test owns a fake hub fixture that serves BOTH `/.well-known/jwks.json`
 * and `/.well-known/parachute-revocation.json`. scope-guard's own unit suite
 * covers the cache mechanics (TTL refresh, fail-open with last-good,
 * single-flight); this file pins the scribe-side wiring and the response-shape
 * contract.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { enforceAuth, validateToken } from "./auth.ts";
import { resetJwksCache, resetRevocationCache } from "./hub-jwt.ts";

interface Keypair {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  kid: string;
}

async function makeKeypair(kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" },
    kid,
  };
}

interface HubFixture {
  origin: string;
  /** Drive the revocation list contents; cleared by default. */
  setRevoked(jtis: string[]): void;
  /** When true, the revocation endpoint returns 503 — exercises fail-closed. */
  setRevocationFails(fails: boolean): void;
  stop: () => void;
}

function startHubFixture(keys: Keypair[]): HubFixture {
  let revokedJtis: string[] = [];
  let revocationFails = false;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") {
        return Response.json({ keys: keys.map((k) => k.publicJwk) });
      }
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        if (revocationFails) {
          return new Response("hub down", { status: 503 });
        }
        return Response.json({
          generated_at: new Date().toISOString(),
          jtis: revokedJtis,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    setRevoked: (jtis) => {
      revokedJtis = jtis;
    },
    setRevocationFails: (fails) => {
      revocationFails = fails;
    },
    stop: () => server.stop(true),
  };
}

interface SignOpts {
  iss: string;
  aud: string;
  scope: string;
  sub?: string;
  ttlSeconds?: number;
  /** Override the random jti — needed when a test wants to revoke this exact token. */
  jti?: string;
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (opts.ttlSeconds ?? 60);
  return new SignJWT({ scope: opts.scope })
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(opts.iss)
    .setSubject(opts.sub ?? "operator-test")
    .setAudience(opts.aud)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(opts.jti ?? `jti-${Math.random().toString(36).slice(2)}`)
    .sign(kp.privateKey);
}

function bearerReq(token: string): Request {
  return new Request("http://localhost/v1/audio/transcriptions", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

let prevHubOrigin: string | undefined;
let prevAuthToken: string | undefined;
let fixture: HubFixture;
let kp: Keypair;

beforeEach(async () => {
  prevAuthToken = process.env.SCRIBE_AUTH_TOKEN;
  // SCRIBE_AUTH_TOKEN must be set to engage the auth path; the value itself
  // is irrelevant for hub-JWT cases (JWT-shaped tokens skip the shared-secret
  // compare entirely).
  process.env.SCRIBE_AUTH_TOKEN = "shared-secret-not-used-for-jwt-cases";

  kp = await makeKeypair("k1");
  fixture = startHubFixture([kp]);
  prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
  resetJwksCache();
  resetRevocationCache();
});

afterEach(() => {
  fixture.stop();
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHubOrigin;
  if (prevAuthToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
  else process.env.SCRIBE_AUTH_TOKEN = prevAuthToken;
  resetJwksCache();
  resetRevocationCache();
});

describe("hub JWT integration — revocation enforcement", () => {
  test("happy path: signed valid JWT not in revocation list → accepted with hub-jwt mode", async () => {
    fixture.setRevoked([]);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "scribe",
      scope: "scribe:transcribe",
    });
    const result = await validateToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mode).toBe("hub-jwt");
      expect(result.scopes).toEqual(["scribe:transcribe"]);
    }
  });

  test("non-revoked jti against populated list → still honored (active revocations don't poison unrelated tokens)", async () => {
    fixture.setRevoked(["some-other-revoked-jti"]);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "scribe",
      scope: "scribe:transcribe",
      jti: "jti-still-good",
    });
    const result = await validateToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.mode).toBe("hub-jwt");
  });

  test("revoked jti → 401 sanitized; full diagnostic (with jti) routed to console.warn audit log", async () => {
    const revokedJti = "jti-revoked-by-operator";
    fixture.setRevoked([revokedJti]);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "scribe",
      scope: "scribe:transcribe",
      jti: revokedJti,
    });

    // Spy + suppress so the assertion is the audit-trail invariant for this
    // scenario, not a stderr inspection. Pattern carries from vault PR #281
    // and propagates to agent.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await enforceAuth(bearerReq(token), "/v1/audio/transcriptions");
      expect(result).toBeInstanceOf(Response);
      const res = result as Response;
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; message: string };
      // Client-facing message must NOT carry the jti — that's a server-side
      // audit-log concern only. See the `code === "revoked"` branch in
      // auth.ts:validateToken for the sanitization.
      expect(body.message).toBe("token has been revoked");
      expect(body.message).not.toContain(revokedJti);

      // Audit-log invariant: console.warn fires exactly once with a message
      // that carries the jti, so an operator chasing a 401 in production logs
      // can correlate to which token was retired.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0]![0] as string;
      expect(warnArg).toContain(revokedJti);
      expect(warnArg).toContain("revoked");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("revocation list unreachable on cold start → fail-closed 401 sanitized; full diagnostic routed to console.warn", async () => {
    // Hub is reachable for JWKS but the revocation endpoint 503s. Cold cache
    // + first-fetch-fail = "unknown" outcome, surfaced as
    // HubJwtError(code: "revocation_unavailable"). Client gets a code-shaped
    // sentence; the implementation-detail phrasing ("no last-good cache")
    // stays in the server-side audit log.
    fixture.setRevocationFails(true);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      aud: "scribe",
      scope: "scribe:transcribe",
    });

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await enforceAuth(bearerReq(token), "/v1/audio/transcriptions");
      expect(result).toBeInstanceOf(Response);
      const res = result as Response;
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; message: string };
      // Client message: code-shaped, no internals.
      expect(body.message).toBe("token cannot be validated: revocation list unavailable");
      // The internal phrase "no last-good cache" is a scope-guard
      // implementation detail and must not leak into the public response.
      expect(body.message).not.toContain("last-good cache");

      // Audit-log invariant: full diagnostic routed to console.warn so
      // operators can distinguish cold-start from sustained outage.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0]![0] as string;
      expect(warnArg).toContain("no last-good cache");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
