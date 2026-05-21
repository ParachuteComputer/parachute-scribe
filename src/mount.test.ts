import { describe, expect, test } from "bun:test";
import { normalizeMount, stripMount } from "./mount.ts";
import { createFetchHandler, type ServerDeps } from "./server.ts";
import type { ResolvedConfig } from "./config-schema.ts";

describe("normalizeMount", () => {
  test("empty string normalizes to ''", () => {
    expect(normalizeMount("")).toBe("");
  });

  test("'/' normalizes to '' (no prefix)", () => {
    expect(normalizeMount("/")).toBe("");
  });

  test("'/scribe' stays '/scribe'", () => {
    expect(normalizeMount("/scribe")).toBe("/scribe");
  });

  test("'/scribe/' strips trailing slash → '/scribe'", () => {
    expect(normalizeMount("/scribe/")).toBe("/scribe");
  });

  test("'scribe' (no leading slash) auto-prepends → '/scribe'", () => {
    expect(normalizeMount("scribe")).toBe("/scribe");
  });

  test("'/scribe/v2' multi-segment stays as-is", () => {
    expect(normalizeMount("/scribe/v2")).toBe("/scribe/v2");
  });

  test("'/scribe///' multiple trailing slashes all stripped", () => {
    expect(normalizeMount("/scribe///")).toBe("/scribe");
  });
});

describe("stripMount", () => {
  test("empty mount returns pathname unchanged", () => {
    expect(stripMount("/health", "")).toBe("/health");
    expect(stripMount("/v1/audio/transcriptions", "")).toBe("/v1/audio/transcriptions");
    expect(stripMount("/", "")).toBe("/");
  });

  test("mount = pathname exactly returns '/'", () => {
    expect(stripMount("/scribe", "/scribe")).toBe("/");
  });

  test("mount + trailing strips correctly", () => {
    expect(stripMount("/scribe/health", "/scribe")).toBe("/health");
    expect(stripMount("/scribe/v1/audio/transcriptions", "/scribe")).toBe(
      "/v1/audio/transcriptions",
    );
    expect(stripMount("/scribe/.parachute/info", "/scribe")).toBe("/.parachute/info");
  });

  test("nested mount works", () => {
    expect(stripMount("/scribe/v2/health", "/scribe/v2")).toBe("/health");
  });

  test("non-matching pathname returns null", () => {
    // `--mount /scribe` deployed scribe should NOT serve `/health` — only
    // `/scribe/health`. Returning null surfaces that as 404 in the handler.
    expect(stripMount("/health", "/scribe")).toBeNull();
    expect(stripMount("/", "/scribe")).toBeNull();
    expect(stripMount("/scribed/health", "/scribe")).toBeNull();
    // Partial-prefix match is NOT a match — `/scribe-old/...` doesn't
    // belong to `--mount /scribe`.
    expect(stripMount("/scribe-old/health", "/scribe")).toBeNull();
  });
});

describe("createFetchHandler — mount-aware routing (issue #39)", () => {
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

  function buildHandler(mount: string | undefined): (req: Request) => Promise<Response> {
    const deps: ServerDeps = {
      transcribe: async () => "stub text",
      cleanup: async (text) => text,
      resolvedConfig: RESOLVED,
      scribeConfig: {},
      mount,
    };
    return createFetchHandler(deps);
  }

  describe("default mount (no prefix)", () => {
    test("undefined mount → routes at root, identical to pre-#39", async () => {
      const handler = buildHandler(undefined);
      const res = await handler(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    test("empty-string mount → routes at root", async () => {
      const handler = buildHandler("");
      const res = await handler(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
    });

    test("'/' mount → equivalent to empty (no prefix)", async () => {
      const handler = buildHandler("/");
      const res = await handler(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
    });

    test("`/scribe/admin` legacy SPA URL still serves the admin page", async () => {
      const handler = buildHandler("");
      const res = await handler(new Request("http://localhost/scribe/admin"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });

    test("`/admin` canonical SPA URL also serves the admin page", async () => {
      const handler = buildHandler("");
      const res = await handler(new Request("http://localhost/admin"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });

    test("admin page bakes empty-string mount into fetch URLs", async () => {
      const handler = buildHandler("");
      const res = await handler(new Request("http://localhost/admin"));
      const html = await res.text();
      // No prefix when mount is empty — fetches go to root.
      expect(html).toContain('"/.parachute/config"');
      expect(html).toContain('"/.parachute/config/schema"');
    });
  });

  describe("`--mount /scribe`", () => {
    test("`/scribe/health` reaches /health route", async () => {
      const handler = buildHandler("/scribe");
      const res = await handler(new Request("http://localhost/scribe/health"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    test("`/scribe/.parachute/info` reaches info handler", async () => {
      const handler = buildHandler("/scribe");
      const res = await handler(new Request("http://localhost/scribe/.parachute/info"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("parachute-scribe");
    });

    test("`/scribe/.parachute/config` reaches config-get", async () => {
      const handler = buildHandler("/scribe");
      const res = await handler(new Request("http://localhost/scribe/.parachute/config"));
      expect(res.status).toBe(200);
    });

    test("`/scribe/v1/audio/transcriptions` reaches transcribe handler", async () => {
      const handler = buildHandler("/scribe");
      const form = new FormData();
      form.set("file", new File(["fake audio"], "test.wav"));
      const res = await handler(
        new Request("http://localhost/scribe/v1/audio/transcriptions", {
          method: "POST",
          body: form,
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: "stub text" });
    });

    test("`/scribe/admin` reaches admin SPA", async () => {
      const handler = buildHandler("/scribe");
      const res = await handler(new Request("http://localhost/scribe/admin"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });

    test("admin page bakes mount prefix into fetch URLs", async () => {
      const handler = buildHandler("/scribe");
      const res = await handler(new Request("http://localhost/scribe/admin"));
      const html = await res.text();
      // Mount-prefixed URLs so in-page fetches resolve back through the
      // proxy that handed us /scribe/admin.
      expect(html).toContain('"/scribe/.parachute/config"');
      expect(html).toContain('"/scribe/.parachute/config/schema"');
    });

    test("bare `/health` (no mount prefix) returns 404", async () => {
      const handler = buildHandler("/scribe");
      const res = await handler(new Request("http://localhost/health"));
      expect(res.status).toBe(404);
    });

    test("bare `/v1/audio/transcriptions` (no mount prefix) returns 404", async () => {
      const handler = buildHandler("/scribe");
      const form = new FormData();
      form.set("file", new File(["fake audio"], "test.wav"));
      const res = await handler(
        new Request("http://localhost/v1/audio/transcriptions", {
          method: "POST",
          body: form,
        }),
      );
      expect(res.status).toBe(404);
    });

    test("OPTIONS preflight still passes through without mount-strip (CORS)", async () => {
      const handler = buildHandler("/scribe");
      const res = await handler(
        new Request("http://localhost/scribe/v1/audio/transcriptions", { method: "OPTIONS" }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("normalization edge cases", () => {
    test("`--mount scribe` (no leading slash) is auto-normalized", async () => {
      const handler = buildHandler("scribe");
      const res = await handler(new Request("http://localhost/scribe/health"));
      expect(res.status).toBe(200);
    });

    test("`--mount /scribe/` (trailing slash) is auto-normalized", async () => {
      const handler = buildHandler("/scribe/");
      const res = await handler(new Request("http://localhost/scribe/health"));
      expect(res.status).toBe(200);
    });

    test("multi-segment mount `/scribe/v2` works end-to-end", async () => {
      const handler = buildHandler("/scribe/v2");
      const res = await handler(new Request("http://localhost/scribe/v2/health"));
      expect(res.status).toBe(200);
      const miss = await handler(new Request("http://localhost/scribe/health"));
      expect(miss.status).toBe(404);
    });
  });
});
