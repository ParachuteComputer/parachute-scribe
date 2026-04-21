import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AUTH_EXEMPT_PATHS,
  enforceAuth,
  extractBearer,
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
    test("accepts any token as valid with empty scopes", () => {
      expect(validateToken(undefined)).toEqual({ valid: true, scopes: [] });
      expect(validateToken("whatever")).toEqual({ valid: true, scopes: [] });
    });

    test("isAuthRequired reports false", () => {
      expect(isAuthRequired()).toBe(false);
    });
  });

  describe("validateToken (closed mode — SCRIBE_AUTH_TOKEN set)", () => {
    beforeEach(() => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    });

    test("rejects a missing token", () => {
      const result = validateToken(undefined);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("token-required");
    });

    test("rejects a mismatched token", () => {
      const result = validateToken("wrong");
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("token-mismatch");
    });

    test("accepts the matching token and grants scopes", () => {
      const result = validateToken("s3cret");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.scopes).toContain("scribe:transcribe");
        expect(result.scopes).toContain("scribe:admin");
      }
    });

    test("isAuthRequired reports true", () => {
      expect(isAuthRequired()).toBe(true);
    });
  });

  describe("enforceAuth middleware", () => {
    test("exempt paths pass without a token even when auth is required", () => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
      for (const path of AUTH_EXEMPT_PATHS) {
        const req = new Request(`http://localhost${path}`);
        expect(enforceAuth(req, path)).toBeNull();
      }
    });

    test("returns 401 on non-exempt paths when token is missing", async () => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
      const req = new Request("http://localhost/v1/models");
      const res = enforceAuth(req, "/v1/models");
      expect(res).not.toBeNull();
      expect(res?.status).toBe(401);
      const body = await res?.json();
      expect(body).toEqual({ error: "unauthorized", message: "SCRIBE_AUTH_TOKEN required" });
    });

    test("returns 401 on non-exempt paths when token is wrong", () => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
      const req = new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer nope" },
      });
      expect(enforceAuth(req, "/v1/models")?.status).toBe(401);
    });

    test("returns null on non-exempt paths when token matches", () => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
      const req = new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer s3cret" },
      });
      expect(enforceAuth(req, "/v1/models")).toBeNull();
    });

    test("open mode (SCRIBE_AUTH_TOKEN unset) never challenges", () => {
      const req = new Request("http://localhost/v1/models");
      expect(enforceAuth(req, "/v1/models")).toBeNull();
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
