import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFetchHandler, type ServerDeps } from "./server.ts";
import type { ResolvedConfig } from "./config-schema.ts";

const RESOLVED: ResolvedConfig = {
  transcribeProvider: "parakeet-mlx",
  cleanupProvider: "none",
  cleanupDefault: false,
  port: 1943,
  vault: { configured: false, url: null, cacheTtlSeconds: null },
};

function buildHandler(): (req: Request) => Promise<Response> {
  const deps: ServerDeps = {
    transcribe: async () => "stub text",
    cleanup: async (text) => text,
    resolvedConfig: RESOLVED,
    scribeConfig: {},
  };
  return createFetchHandler(deps);
}

describe("createFetchHandler — auth gate", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  describe("SCRIBE_AUTH_TOKEN unset — open mode", () => {
    beforeEach(() => {
      delete process.env.SCRIBE_AUTH_TOKEN;
    });

    test("any caller can reach /health, /v1/models, /.parachute/config", async () => {
      const handler = buildHandler();
      for (const path of ["/health", "/v1/models", "/.parachute/config", "/.parachute/info"]) {
        const res = await handler(new Request(`http://localhost${path}`));
        expect(res.status).toBe(200);
      }
    });
  });

  describe("SCRIBE_AUTH_TOKEN set — closed mode", () => {
    beforeEach(() => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    });

    test("/health passes without a token (exempt — liveness probes)", async () => {
      const res = await buildHandler()(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
    });

    test("/.parachute/info passes without a token (exempt — module identity)", async () => {
      const res = await buildHandler()(new Request("http://localhost/.parachute/info"));
      expect(res.status).toBe(200);
    });

    test("/v1/models returns 401 without a token", async () => {
      const res = await buildHandler()(new Request("http://localhost/v1/models"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "unauthorized",
        message: "SCRIBE_AUTH_TOKEN required",
      });
    });

    test("/.parachute/config returns 401 without a token", async () => {
      const res = await buildHandler()(new Request("http://localhost/.parachute/config"));
      expect(res.status).toBe(401);
    });

    test("/.parachute/config returns 401 on wrong token", async () => {
      const res = await buildHandler()(
        new Request("http://localhost/.parachute/config", {
          headers: { Authorization: "Bearer wrong" },
        }),
      );
      expect(res.status).toBe(401);
    });

    test("/.parachute/config returns 200 on matching token", async () => {
      const res = await buildHandler()(
        new Request("http://localhost/.parachute/config", {
          headers: { Authorization: "Bearer s3cret" },
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RESOLVED);
    });

    test("/v1/audio/transcriptions returns 401 without a token", async () => {
      const form = new FormData();
      form.set("file", new File(["fake audio"], "test.wav"));
      const res = await buildHandler()(
        new Request("http://localhost/v1/audio/transcriptions", {
          method: "POST",
          body: form,
        }),
      );
      expect(res.status).toBe(401);
    });

    test("OPTIONS preflight passes through without auth (CORS)", async () => {
      const res = await buildHandler()(
        new Request("http://localhost/v1/audio/transcriptions", { method: "OPTIONS" }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    test("401 responses carry CORS headers (browser clients can read the error)", async () => {
      const res = await buildHandler()(new Request("http://localhost/v1/models"));
      expect(res.status).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
