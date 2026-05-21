import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFetchHandler, type ServerDeps } from "./server.ts";
import type { ResolvedConfig } from "./config-schema.ts";
import type { Cleaner } from "./providers.ts";
import type { ScribeConfig } from "./config.ts";

const RESOLVED: ResolvedConfig = {
  transcribeProvider: "parakeet-mlx",
  transcribeProviders: {},
  cleanupProvider: "none",
  cleanupDefault: false,
  cleanupProviders: {},
  cleanupSystemPrompt: null,
  cleanupContextTemplate: null,
  port: 1943,
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
      // GET /.parachute/config returns the resolved-config shape — top-level
      // boot fields match RESOLVED; the per-provider blocks are computed
      // per-request and exercised in dedicated tests.
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.transcribeProvider).toBe(RESOLVED.transcribeProvider);
      expect(body.cleanupProvider).toBe(RESOLVED.cleanupProvider);
      expect(body.cleanupDefault).toBe(RESOLVED.cleanupDefault);
      expect(body.port).toBe(RESOLVED.port);
      expect(body.transcribeProviders).toBeDefined();
      expect(body.cleanupProviders).toBeDefined();
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
    cleanupProvider: "anthropic",
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

  test("threads cleanup.system_prompt + context_template from config into cleaner opts", async () => {
    let seenOpts: { systemPrompt?: string; contextTemplate?: string } | undefined;
    const handler = buildHandler({
      transcribe: async () => "raw",
      cleanup: async (text, _nouns, opts) => {
        seenOpts = opts;
        return `cleaned(${text})`;
      },
      resolvedConfig: CLEANUP_RESOLVED,
      scribeConfig: {
        cleanup: {
          system_prompt: "OVERRIDE PROMPT",
          context_template: "\n\nCONTEXT: {{proper_nouns}}",
        },
      },
    });
    const res = await handler(transcribeReq());
    expect(res.status).toBe(200);
    expect(seenOpts?.systemPrompt).toBe("OVERRIDE PROMPT");
    expect(seenOpts?.contextTemplate).toBe("\n\nCONTEXT: {{proper_nouns}}");
  });
});

describe("createFetchHandler — context-in-payload (only source of proper nouns)", () => {
  const CLEANUP_RESOLVED: ResolvedConfig = {
    ...RESOLVED,
    cleanupProvider: "anthropic",
    cleanupDefault: true,
  };
  const EMPTY_CONFIG: ScribeConfig = {};

  let originalToken: string | undefined;
  let realFetch: typeof globalThis.fetch;
  let outboundCalls: URL[];

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
    realFetch = globalThis.fetch;
    outboundCalls = [];
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      outboundCalls.push(url);
      throw new Error(`unexpected outbound fetch: ${url.toString()}`);
    }) as unknown as typeof fetch;
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

  test("context part present → cleaner sees payload-derived nouns, no outbound fetch", async () => {
    let seenNouns = "";
    const handler = buildHandler({
      cleanup: async (text, nouns) => {
        seenNouns = nouns ?? "";
        return `cleaned(${text})`;
      },
      resolvedConfig: CLEANUP_RESOLVED,
      scribeConfig: EMPTY_CONFIG,
    });
    const contextJson = JSON.stringify({
      entries: [{ name: "Margaret", summary: "Close friend", aliases: ["Marg"] }],
    });
    const res = await handler(reqWithContext(contextJson));

    expect(res.status).toBe(200);
    expect(outboundCalls.length).toBe(0);
    expect(seenNouns).toContain("## Known names in this context");
    expect(seenNouns).toContain("- Margaret — Close friend (also: \"Marg\")");
  });

  test("no context part → cleaner gets empty nouns, no outbound fetch", async () => {
    let seenNouns = "sentinel";
    const handler = buildHandler({
      cleanup: async (text, nouns) => {
        seenNouns = nouns ?? "";
        return `cleaned(${text})`;
      },
      resolvedConfig: CLEANUP_RESOLVED,
      scribeConfig: EMPTY_CONFIG,
    });
    const res = await handler(reqWithContext(null));

    expect(res.status).toBe(200);
    expect(outboundCalls.length).toBe(0);
    expect(seenNouns).toBe("");
  });

  test("malformed context JSON → logged + cleanup runs with empty nouns", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map((a) => String(a)).join(" ")); };
    try {
      let seenNouns = "sentinel";
      const handler = buildHandler({
        cleanup: async (text, nouns) => {
          seenNouns = nouns ?? "";
          return `cleaned(${text})`;
        },
        resolvedConfig: CLEANUP_RESOLVED,
        scribeConfig: EMPTY_CONFIG,
      });
      const res = await handler(reqWithContext("not valid json"));

      expect(res.status).toBe(200);
      expect(warnings.some((w) => w.includes("malformed 'context' part"))).toBe(true);
      expect(seenNouns).toBe("");
      expect(outboundCalls.length).toBe(0);
    } finally {
      console.warn = origWarn;
    }
  });

  test("empty entries context part → cleaner gets empty nouns", async () => {
    let seenNouns = "sentinel";
    const handler = buildHandler({
      cleanup: async (text, nouns) => {
        seenNouns = nouns ?? "";
        return text;
      },
      resolvedConfig: CLEANUP_RESOLVED,
      scribeConfig: EMPTY_CONFIG,
    });
    const res = await handler(reqWithContext(JSON.stringify({ entries: [] })));

    expect(res.status).toBe(200);
    expect(seenNouns).toBe("");
    expect(outboundCalls.length).toBe(0);
  });
});
