/**
 * Integration tests for `POST /v1/audio/transcriptions-url`.
 *
 * Uses a real `Bun.serve()` instance as the audio origin and exercises
 * the full pipeline (parse → SSRF guard → fetch → transcribe stub →
 * optional cleanup → response). The loopback bypass flag is set so the
 * fetcher allows 127.0.0.1.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFetchHandler, type ServerDeps } from "./server.ts";
import type { ResolvedConfig } from "./config-schema.ts";

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
    transcribe: async (file) => `transcribed(${file.name},${file.size}b)`,
    cleanup: async (text) => text,
    resolvedConfig: RESOLVED,
    scribeConfig: {},
    ...overrides,
  };
  return createFetchHandler(deps);
}

describe("POST /v1/audio/transcriptions-url", () => {
  let originServer: ReturnType<typeof Bun.serve> | null = null;
  let originPort = 0;
  let originalLoopbackFlag: string | undefined;
  let originalToken: string | undefined;

  beforeAll(() => {
    originalLoopbackFlag = process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK;
    process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK = "1";
    originServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/show.mp3") {
          return new Response(
            new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            { headers: { "Content-Type": "audio/mpeg" } },
          );
        }
        if (url.pathname === "/notes.html") {
          return new Response("<html>hi</html>", {
            headers: { "Content-Type": "text/html" },
          });
        }
        return new Response("nope", { status: 404 });
      },
    });
    originPort = originServer.port ?? 0;
  });

  afterAll(() => {
    originServer?.stop();
    if (originalLoopbackFlag === undefined)
      delete process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK;
    else process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK = originalLoopbackFlag;
  });

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  test("happy path — URL → transcribed text + source echo", async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/show.mp3` }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; source: { url: string; bytes: number } };
    expect(body.text).toContain("transcribed(show.mp3");
    expect(body.source.url).toBe(`http://127.0.0.1:${originPort}/show.mp3`);
    expect(body.source.bytes).toBe(12);
  });

  test("missing `url` field → 400", async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("url");
  });

  test("invalid JSON body → 400 invalid_json", async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_json");
  });

  test("SSRF attempt (private IP literal) → 400 blocked_host", async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://192.168.1.1/audio.mp3" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("blocked_host");
  });

  test("SSRF attempt (localhost name) → 400 blocked_host", async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://localhost:1939/x.mp3" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("blocked_host");
  });

  test("unsupported scheme (file://) → 400 unsupported_scheme", async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "file:///etc/passwd" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_scheme");
  });

  test("non-audio content-type → 415 not_audio", async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/notes.html` }),
      }),
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("not_audio");
  });

  test("404 from origin → 502 fetch_failed", async () => {
    const handler = buildHandler();
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/missing.mp3` }),
      }),
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("fetch_failed");
  });

  test("missing provider returns 400 missing_provider (graceful first-boot)", async () => {
    const handler = buildHandler({ transcribe: null });
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/show.mp3` }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_code: string }).error_code).toBe("missing_provider");
  });

  test("cleanup=true with cleanup configured → runs cleanup pass", async () => {
    const handler = buildHandler({
      cleanup: async (text) => `cleaned(${text})`,
      resolvedConfig: { ...RESOLVED, cleanupProvider: "anthropic", cleanupDefault: false },
    });
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `http://127.0.0.1:${originPort}/show.mp3`,
          cleanup: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    expect(body.text.startsWith("cleaned(transcribed(show.mp3")).toBe(true);
  });

  test("context payload threaded into cleaner", async () => {
    let seenNouns = "";
    const handler = buildHandler({
      cleanup: async (text, nouns) => {
        seenNouns = nouns ?? "";
        return `cleaned(${text})`;
      },
      resolvedConfig: { ...RESOLVED, cleanupProvider: "anthropic", cleanupDefault: true },
    });
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `http://127.0.0.1:${originPort}/show.mp3`,
          context: {
            entries: [{ name: "Margaret", summary: "Close friend", aliases: ["Marg"] }],
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(seenNouns).toContain("Margaret");
    expect(seenNouns).toContain("Marg");
  });

  test("requires scribe:transcribe when auth is enabled (401 → 200 with token)", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    const handler = buildHandler();
    const unauth = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/show.mp3` }),
      }),
    );
    expect(unauth.status).toBe(401);
    const ok = await handler(
      new Request("http://localhost/v1/audio/transcriptions-url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer s3cret",
        },
        body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/show.mp3` }),
      }),
    );
    expect(ok.status).toBe(200);
  });
});
