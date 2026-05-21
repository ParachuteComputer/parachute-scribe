/**
 * Tests for the MCP server transport + tool surface at `/scribe/mcp`.
 *
 * We exercise the JSON-RPC interface directly (the SDK's
 * `tools/list` and `tools/call` methods), no MCP client SDK needed —
 * stateless mode means we just POST a JSON-RPC body and read the
 * response.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFetchHandler, type ServerDeps } from "../server.ts";
import type { ResolvedConfig } from "../config-schema.ts";

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

function mcpRequest(body: object, token?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost/scribe/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
}

async function rpcResult(res: Response): Promise<{ result?: unknown; error?: unknown }> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return (await res.json()) as { result?: unknown; error?: unknown };
  }
  // SSE fallback — pull `data: ...` lines.
  const text = await res.text();
  const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
  for (const line of dataLines.reverse()) {
    try {
      const parsed = JSON.parse(line.slice("data: ".length));
      return parsed;
    } catch {
      // skip
    }
  }
  return {};
}

describe("/scribe/mcp — list + call tools", () => {
  let originalToken: string | undefined;
  let originalLoopbackFlag: string | undefined;
  let originServer: ReturnType<typeof Bun.serve> | null = null;
  let originPort = 0;

  beforeAll(() => {
    originalLoopbackFlag = process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK;
    process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK = "1";
    originServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          headers: { "Content-Type": "audio/mpeg" },
        });
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

  test("tools/list advertises both transcribe + transcribe-url", async () => {
    const handler = buildHandler();
    const res = await handler(mcpRequest({ method: "tools/list", params: {} }));
    expect(res.status).toBe(200);
    const body = await rpcResult(res);
    const result = body.result as { tools: { name: string }[] };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["transcribe", "transcribe-url"]);
  });

  test("tools/call transcribe with base64 audio → text result", async () => {
    const handler = buildHandler();
    const audioB64 = Buffer.from("hello bytes").toString("base64");
    const res = await handler(
      mcpRequest({
        method: "tools/call",
        params: {
          name: "transcribe",
          arguments: { audio_base64: audioB64, filename: "memo.wav" },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await rpcResult(res);
    const result = body.result as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("transcribed(memo.wav,11b)");
  });

  test("tools/call transcribe-url → text + structured source", async () => {
    const handler = buildHandler();
    const res = await handler(
      mcpRequest({
        method: "tools/call",
        params: {
          name: "transcribe-url",
          arguments: { url: `http://127.0.0.1:${originPort}/feed.mp3` },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await rpcResult(res);
    const result = body.result as {
      content: { text: string }[];
      structuredContent?: { source: { url: string; bytes: number } };
    };
    expect(result.content[0]?.text).toBe("transcribed(feed.mp3,5b)");
    expect(result.structuredContent?.source.url).toBe(`http://127.0.0.1:${originPort}/feed.mp3`);
    expect(result.structuredContent?.source.bytes).toBe(5);
  });

  test("tools/call transcribe-url with SSRF target → tool returns isError + blocked_host", async () => {
    const handler = buildHandler();
    const res = await handler(
      mcpRequest({
        method: "tools/call",
        params: {
          name: "transcribe-url",
          arguments: { url: "http://192.168.0.5/x.mp3" },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await rpcResult(res);
    const result = body.result as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("blocked_host");
  });

  test("tools/call transcribe with no audio_base64 → invalid_args", async () => {
    const handler = buildHandler();
    const res = await handler(
      mcpRequest({
        method: "tools/call",
        params: {
          name: "transcribe",
          arguments: { filename: "memo.wav" },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await rpcResult(res);
    const result = body.result as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid_args");
  });

  test("missing provider → tool error missing_provider", async () => {
    const handler = buildHandler({ transcribe: null });
    const audioB64 = Buffer.from("x").toString("base64");
    const res = await handler(
      mcpRequest({
        method: "tools/call",
        params: { name: "transcribe", arguments: { audio_base64: audioB64 } },
      }),
    );
    const body = await rpcResult(res);
    const result = body.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("missing_provider");
  });

  test("auth required when SCRIBE_AUTH_TOKEN set", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "secret-token";
    const handler = buildHandler();
    const unauth = await handler(mcpRequest({ method: "tools/list", params: {} }));
    expect(unauth.status).toBe(401);
    const ok = await handler(mcpRequest({ method: "tools/list", params: {} }, "secret-token"));
    expect(ok.status).toBe(200);
  });
});
