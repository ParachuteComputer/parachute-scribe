import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AUTH_EXEMPT_PATHS,
  SCOPE_ADMIN,
  SCOPE_TRANSCRIBE,
  enforceAuth,
  extractBearer,
  hasScope,
  insufficientScopeResponse,
  isAuthRequired,
  unauthorizedResponse,
  validateToken,
} from "./auth.ts";

describe("auth", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  describe("extractBearer", () => {
    test("pulls the token out of 'Bearer <token>'", () => {
      expect(extractBearer("Bearer abc123")).toBe("abc123");
    });

    test("is case-insensitive on the 'Bearer' prefix", () => {
      expect(extractBearer("bearer abc123")).toBe("abc123");
      expect(extractBearer("BEARER abc123")).toBe("abc123");
    });

    test("trims surrounding whitespace on the token", () => {
      expect(extractBearer("Bearer   abc123  ")).toBe("abc123");
    });

    test("returns undefined for a missing or malformed header", () => {
      expect(extractBearer(null)).toBeUndefined();
      expect(extractBearer(undefined)).toBeUndefined();
      expect(extractBearer("")).toBeUndefined();
      expect(extractBearer("abc123")).toBeUndefined();
      expect(extractBearer("Basic abc123")).toBeUndefined();
    });
  });

  describe("validateToken (open mode — SCRIBE_AUTH_TOKEN unset)", () => {
    test("any caller passes with full scope set", async () => {
      const result = await validateToken(undefined);
      expect(result).toEqual({
        valid: true,
        scopes: [SCOPE_TRANSCRIBE, SCOPE_ADMIN],
        mode: "open",
      });
    });

    test("isAuthRequired reports false", () => {
      expect(isAuthRequired()).toBe(false);
    });
  });

  describe("validateToken (closed mode — SCRIBE_AUTH_TOKEN set)", () => {
    beforeEach(() => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    });

    test("rejects a missing token", async () => {
      const result = await validateToken(undefined);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("token-required");
    });

    test("rejects a mismatched token", async () => {
      const result = await validateToken("wrong");
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("token-mismatch");
    });

    test("accepts the matching shared-secret token and grants full scopes", async () => {
      const result = await validateToken("s3cret");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.mode).toBe("shared-secret");
        expect(result.scopes).toContain(SCOPE_TRANSCRIBE);
        expect(result.scopes).toContain(SCOPE_ADMIN);
      }
    });

    test("isAuthRequired reports true", () => {
      expect(isAuthRequired()).toBe(true);
    });

    test("rejects a JWT-shaped token that doesn't verify (no JWKS reachable)", async () => {
      const malformedJwt = "eyJhbGciOiJSUzI1NiJ9.notreallyajwt.signature";
      const result = await validateToken(malformedJwt);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("jwt-invalid");
    });
  });

  describe("hasScope (exact-match for non-vault scopes)", () => {
    test("matches exact scope", () => {
      expect(hasScope([SCOPE_TRANSCRIBE], SCOPE_TRANSCRIBE)).toBe(true);
    });

    test("does not inherit (admin does NOT imply transcribe)", () => {
      expect(hasScope([SCOPE_ADMIN], SCOPE_TRANSCRIBE)).toBe(false);
      expect(hasScope([SCOPE_TRANSCRIBE], SCOPE_ADMIN)).toBe(false);
    });

    test("returns true when granted contains the required scope alongside others", () => {
      expect(hasScope([SCOPE_TRANSCRIBE, SCOPE_ADMIN], SCOPE_TRANSCRIBE)).toBe(true);
    });

    test("empty granted list satisfies nothing", () => {
      expect(hasScope([], SCOPE_TRANSCRIBE)).toBe(false);
    });
  });

  describe("insufficientScopeResponse", () => {
    test("returns 403 with the canonical insufficient_scope shape", async () => {
      const res = insufficientScopeResponse(SCOPE_TRANSCRIBE, [SCOPE_ADMIN]);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({
        error: "Forbidden",
        error_type: "insufficient_scope",
        message: `This endpoint requires the '${SCOPE_TRANSCRIBE}' scope.`,
        required_scope: SCOPE_TRANSCRIBE,
        granted_scopes: [SCOPE_ADMIN],
      });
    });
  });

  describe("enforceAuth middleware", () => {
    test("exempt paths pass without a token even when auth is required", async () => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
      for (const path of AUTH_EXEMPT_PATHS) {
        const req = new Request(`http://localhost${path}`);
        const result = await enforceAuth(req, path);
        expect(result).not.toBeInstanceOf(Response);
      }
    });

    test("returns 401 on non-exempt paths when token is missing", async () => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
      const req = new Request("http://localhost/v1/models");
      const result = await enforceAuth(req, "/v1/models");
      expect(result).toBeInstanceOf(Response);
      const res = result as Response;
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "unauthorized", message: "SCRIBE_AUTH_TOKEN required" });
    });

    test("returns 401 on non-exempt paths when token is wrong", async () => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
      const req = new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer nope" },
      });
      const result = await enforceAuth(req, "/v1/models");
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    });

    test("returns scopes on non-exempt paths when token matches", async () => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
      const req = new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer s3cret" },
      });
      const result = await enforceAuth(req, "/v1/models");
      expect(result).not.toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        expect(result.scopes).toContain(SCOPE_TRANSCRIBE);
        expect(result.scopes).toContain(SCOPE_ADMIN);
      }
    });

    test("open mode (SCRIBE_AUTH_TOKEN unset) passes with full scopes", async () => {
      const req = new Request("http://localhost/v1/models");
      const result = await enforceAuth(req, "/v1/models");
      expect(result).not.toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        expect(result.scopes).toContain(SCOPE_TRANSCRIBE);
        expect(result.scopes).toContain(SCOPE_ADMIN);
      }
    });

    test("rejects malformed JWT-shaped tokens with 401 + jwt-validation message", async () => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
      const req = new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.broken.sig" },
      });
      const result = await enforceAuth(req, "/v1/models");
      expect(result).toBeInstanceOf(Response);
      const res = result as Response;
      expect(res.status).toBe(401);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain("hub JWT verification failed");
    });
  });

  test("unauthorizedResponse shape is stable and CORS-compatible", async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized", message: "SCRIBE_AUTH_TOKEN required" });
  });
});
