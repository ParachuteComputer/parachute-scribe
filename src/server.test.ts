import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFetchHandler, type ServerDeps } from "./server.ts";
import type { ResolvedConfig } from "./config-schema.ts";
import type { Cleaner } from "./providers.ts";
import type { ScribeConfig } from "./config.ts";
import { clearVaultCache } from "./vault.ts";

const RESOLVED: ResolvedConfig = {
  transcribeProvider: "parakeet-mlx",
  cleanupProvider: "none",
  cleanupDefault: false,
  port: 1943,
  vault: { configured: false, url: null, cacheTtlSeconds: null, mode: "fallback" },
};

function buildHandler(overrides: Partial<ServerDeps> = {}): (req: Request) => Promise<Response> {
  const deps: ServerDeps = {
    transcribe: async () => "stub text",
    cleanup: async (text) => text,
    resolvedConfig: RESOLVED,
    scribeConfig: {},
    ...overrides,
  };
  return createFetchHandler(deps);
}

function transcribeReq(): Request {
  const form = new FormData();
  form.set("file", new File(["fake audio"], "test.wav"));
  return new Request("http://localhost/v1/audio/transcriptions", {
    method: "POST",
    body: form,
  });
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
      const res = await buildHandler()(transcribeReq());
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

describe("createFetchHandler — cleanup failure behavior", () => {
  const CLEANUP_RESOLVED: ResolvedConfig = {
    ...RESOLVED,
    cleanupProvider: "claude",
    cleanupDefault: true,
  };

  let originalToken: string | undefined;
  let originalError: typeof console.error;
  let errors: string[];

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
    errors = [];
    originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
    console.error = originalError;
  });

  test("cleanup throw → 200 with raw transcription, not 500", async () => {
    const throwingCleanup: Cleaner = async () => {
      throw new Error("upstream LLM unreachable");
    };
    const handler = buildHandler({
      transcribe: async () => "raw transcribed words",
      cleanup: throwingCleanup,
      resolvedConfig: CLEANUP_RESOLVED,
    });

    const res = await handler(transcribeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "raw transcribed words" });
    expect(errors.some((e) => e.includes("Cleanup failed") && e.includes("upstream LLM unreachable"))).toBe(true);
  });

  test("transcription throw → still 500 (cleanup fallback only covers cleanup)", async () => {
    const handler = buildHandler({
      transcribe: async () => {
        throw new Error("audio decode failed");
      },
      resolvedConfig: CLEANUP_RESOLVED,
    });
    const res = await handler(transcribeReq());
    expect(res.status).toBe(500);
  });

  test("cleanup success → 200 with cleaned text", async () => {
    const handler = buildHandler({
      transcribe: async () => "raw",
      cleanup: async (text) => `cleaned(${text})`,
      resolvedConfig: CLEANUP_RESOLVED,
    });
    const res = await handler(transcribeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "cleaned(raw)" });
  });
});

describe("createFetchHandler — context-in-payload + vault.mode", () => {
  const CLEANUP_RESOLVED: ResolvedConfig = {
    ...RESOLVED,
    cleanupProvider: "claude",
    cleanupDefault: true,
  };
  const VAULT_CONFIG: ScribeConfig = {
    vault: {
      url: "http://localhost:1940",
      contexts: [{ tag: "person" }],
    },
  };

  let originalToken: string | undefined;
  let realFetch: typeof globalThis.fetch;
  let vaultCalls: number;

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
    realFetch = globalThis.fetch;
    vaultCalls = 0;
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      if (url.pathname.startsWith("/api/notes")) {
        vaultCalls++;
        return Response.json([{ path: "People/FromVault", metadata: { summary: "vault-side" } }]);
      }
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;
    clearVaultCache();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
    globalThis.fetch = realFetch;
  });

  function reqWithContext(contextJson: string | null): Request {
    const form = new FormData();
    form.set("file", new File(["fake audio"], "test.wav"));
    if (contextJson !== null) {
      form.set("context", new Blob([contextJson], { type: "application/json" }), "context.json");
    }
    return new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
  }

  test("context part present → cleaner sees payload-derived nouns, vault is NOT called", async () => {
    let seenNouns = "";
    const handler = buildHandler({
      cleanup: async (text, nouns) => {
        seenNouns = nouns ?? "";
        return `cleaned(${text})`;
      },
      resolvedConfig: CLEANUP_RESOLVED,
      scribeConfig: VAULT_CONFIG,
    });
    const contextJson = JSON.stringify({
      entries: [{ name: "Margaret", summary: "Close friend", aliases: ["Marg"] }],
    });
    const res = await handler(reqWithContext(contextJson));

    expect(res.status).toBe(200);
    expect(vaultCalls).toBe(0);
    expect(seenNouns).toContain("## Known names in this context");
    expect(seenNouns).toContain("- Margaret — Close friend (also: \"Marg\")");
    expect(seenNouns).not.toContain("FromVault");
  });

  test("no context part + vault configured (default mode) → vault IS called", async () => {
    const handler = buildHandler({
      cleanup: async (text) => `cleaned(${text})`,
      resolvedConfig: CLEANUP_RESOLVED,
      scribeConfig: VAULT_CONFIG,
    });
    const res = await handler(reqWithContext(null));

    expect(res.status).toBe(200);
    expect(vaultCalls).toBeGreaterThan(0);
  });

  test("no context part + vault.mode='off' → vault is NOT called", async () => {
    const handler = buildHandler({
      cleanup: async (text) => `cleaned(${text})`,
      resolvedConfig: CLEANUP_RESOLVED,
      scribeConfig: {
        vault: { ...VAULT_CONFIG.vault!, mode: "off" },
      },
    });
    const res = await handler(reqWithContext(null));

    expect(res.status).toBe(200);
    expect(vaultCalls).toBe(0);
  });

  test("malformed context JSON → logged + falls through to vault", async () => {
    let warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map((a) => String(a)).join(" ")); };
    try {
      const handler = buildHandler({
        cleanup: async (text) => `cleaned(${text})`,
        resolvedConfig: CLEANUP_RESOLVED,
        scribeConfig: VAULT_CONFIG,
      });
      const res = await handler(reqWithContext("not valid json"));

      expect(res.status).toBe(200);
      expect(warnings.some((w) => w.includes("malformed 'context' part"))).toBe(true);
      expect(vaultCalls).toBeGreaterThan(0);
    } finally {
      console.warn = origWarn;
    }
  });

  test("vault.mode='required' + vault unreachable + no context → 200 with raw transcription, cleanup skipped, error logged", async () => {
    // Point the mocked fetch at "ECONNREFUSED" for vault calls.
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      if (url.pathname.startsWith("/api/notes")) {
        throw new Error("ECONNREFUSED");
      }
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map((a) => String(a)).join(" ")); };

    try {
      const handler = buildHandler({
        transcribe: async () => "raw transcribed words",
        cleanup: async (text) => `cleaned(${text})`, // should not be invoked — vault throws first
        resolvedConfig: CLEANUP_RESOLVED,
        scribeConfig: {
          vault: { ...VAULT_CONFIG.vault!, mode: "required" },
        },
      });
      const res = await handler(reqWithContext(null));

      // The wrapper from PR #18 is the backstop — transcription always survives.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: "raw transcribed words" });
      expect(errors.some((e) => e.includes("Cleanup failed") && e.includes("ECONNREFUSED"))).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  test("empty entries context part → vault NOT called, cleaner gets empty nouns", async () => {
    let seenNouns = "sentinel";
    const handler = buildHandler({
      cleanup: async (text, nouns) => {
        seenNouns = nouns ?? "";
        return text;
      },
      resolvedConfig: CLEANUP_RESOLVED,
      scribeConfig: VAULT_CONFIG,
    });
    const res = await handler(reqWithContext(JSON.stringify({ entries: [] })));

    expect(res.status).toBe(200);
    expect(vaultCalls).toBe(0);
    expect(seenNouns).toBe("");
  });
});
