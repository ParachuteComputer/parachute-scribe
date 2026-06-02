/**
 * End-to-end tests for the admin surfaces:
 *   - PUT /.parachute/config (validation, auth, atomic write, restart_required)
 *   - GET /scribe/admin (HTML render + key form fields)
 *
 * The handler is constructed via `createFetchHandler` so we exercise the same
 * auth + scope gates the live server does. Tests sandbox the on-disk write
 * via the `configPath` dep — never touches the operator's real ~/.parachute.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFetchHandler, type ServerDeps } from "./server.ts";
import type { ResolvedConfig } from "./config-schema.ts";

const RESOLVED: ResolvedConfig = {
  transcribeProvider: "parakeet-mlx",
  transcribeProviders: {},
  cleanupProvider: "none",
  cleanupDefault: true,
  cleanupProviders: {},
  cleanupSystemPrompt: null,
  cleanupContextTemplate: null,
  port: 1943,
};

function buildHandler(
  configPath: string,
  overrides: Partial<ServerDeps> = {},
): (req: Request) => Promise<Response> {
  const deps: ServerDeps = {
    transcribe: async () => "stub",
    cleanup: async (text) => text,
    resolvedConfig: RESOLVED,
    scribeConfig: {},
    configPath,
    ...overrides,
  };
  return createFetchHandler(deps);
}

function putReq(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost/.parachute/config", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PUT /.parachute/config", () => {
  let dir: string;
  let configPath: string;
  let originalToken: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-put-"));
    configPath = join(dir, "scribe", "config.json");
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  describe("open mode (SCRIBE_AUTH_TOKEN unset)", () => {
    beforeEach(() => {
      delete process.env.SCRIBE_AUTH_TOKEN;
    });

    test("happy path: 200 + restart_required + file written", async () => {
      const handler = buildHandler(configPath);
      const res = await handler(
        putReq({
          transcribeProvider: "whisper",
          cleanupProvider: "ollama",
          cleanupDefault: false,
          cleanupSystemPrompt: "PROMPT",
          cleanupContextTemplate: "ctx {{proper_nouns}}",
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown> & { errors?: { path: string; message?: string }[] };
      expect(body.ok).toBe(true);
      // Both provider changes require restart; prompt/default do not.
      expect((body.restart_required as string[]).sort()).toEqual(["cleanupProvider", "transcribeProvider"]);
      expect(existsSync(configPath)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        transcribe: { provider: "whisper" },
        cleanup: {
          provider: "ollama",
          default: false,
          system_prompt: "PROMPT",
          context_template: "ctx {{proper_nouns}}",
        },
      });
    });

    test("idempotent — second identical PUT still returns 200", async () => {
      const handler = buildHandler(configPath);
      const body = { transcribeProvider: "whisper", cleanupProvider: "ollama" };
      const a = await handler(putReq(body));
      const b = await handler(putReq(body));
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(existsSync(configPath)).toBe(true);
    });

    test("partial body — only the cleanup prompt changes, restart_required empty", async () => {
      const handler = buildHandler(configPath);
      const res = await handler(putReq({ cleanupSystemPrompt: "JUST THE PROMPT" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown> & { errors?: { path: string; message?: string }[] };
      expect(body.restart_required).toEqual([]);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        cleanup: { system_prompt: "JUST THE PROMPT" },
      });
    });

    test("dynamic field changes take effect on the in-process scribeConfig (no restart needed)", async () => {
      const scribeConfig: ServerDeps["scribeConfig"] = {
        cleanup: { system_prompt: "OLD", default: true },
      };
      const handler = buildHandler(configPath, { scribeConfig });
      const res = await handler(
        putReq({ cleanupSystemPrompt: "NEW", cleanupDefault: false }),
      );
      expect(res.status).toBe(200);
      expect(scribeConfig.cleanup?.system_prompt).toBe("NEW");
      expect(scribeConfig.cleanup?.default).toBe(false);
    });

    test("null-clear via HTTP: PUT { cleanupSystemPrompt: null } removes prompt on disk", async () => {
      // Wire-level regression for scribe#45 must-fix 1. Seed the file with an
      // OLD prompt, PUT with explicit null, verify the disk file no longer
      // carries `system_prompt` AND the in-process scribeConfig no longer
      // carries it either (otherwise the running handler would still send
      // the old prompt to the cleanup LLM).
      mkdirSync(configPath.replace(/\/[^/]+$/, ""), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          cleanup: { provider: "ollama", system_prompt: "OLD PROMPT", default: true },
        }),
      );
      const scribeConfig: ServerDeps["scribeConfig"] = {
        cleanup: { provider: "ollama", system_prompt: "OLD PROMPT", default: true },
      };
      const handler = buildHandler(configPath, { scribeConfig });

      const res = await handler(putReq({ cleanupSystemPrompt: null }));
      expect(res.status).toBe(200);

      const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
      expect(onDisk.cleanup.system_prompt).toBeUndefined();
      // Sibling fields survive — the clear is targeted.
      expect(onDisk.cleanup.provider).toBe("ollama");
      expect(onDisk.cleanup.default).toBe(true);
      // In-process config matches disk so the next transcription request
      // doesn't keep sending the old prompt.
      expect(scribeConfig.cleanup?.system_prompt).toBeUndefined();
    });

    test("null-clear via HTTP: PUT { cleanupContextTemplate: null } removes template on disk", async () => {
      mkdirSync(configPath.replace(/\/[^/]+$/, ""), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          cleanup: { provider: "ollama", context_template: "OLD {{proper_nouns}}" },
        }),
      );
      const scribeConfig: ServerDeps["scribeConfig"] = {
        cleanup: { provider: "ollama", context_template: "OLD {{proper_nouns}}" },
      };
      const handler = buildHandler(configPath, { scribeConfig });

      const res = await handler(putReq({ cleanupContextTemplate: null }));
      expect(res.status).toBe(200);

      const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
      expect(onDisk.cleanup.context_template).toBeUndefined();
      expect(onDisk.cleanup.provider).toBe("ollama");
      expect(scribeConfig.cleanup?.context_template).toBeUndefined();
    });

    test("bad payload — non-enum provider → 400 + error message + NO file written", async () => {
      const handler = buildHandler(configPath);
      const res = await handler(putReq({ transcribeProvider: "not-a-real-thing" }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown> & { errors?: { path: string; message?: string }[] };
      expect(body.error).toBe("validation_failed");
      expect(body.errors).toBeArray();
      expect(body.errors?.[0]?.path).toBe("transcribeProvider");
      expect(existsSync(configPath)).toBe(false);
    });

    test("invalid JSON body → 400, no file written", async () => {
      const handler = buildHandler(configPath);
      const req = new Request("http://localhost/.parachute/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const res = await handler(req);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown> & { errors?: { path: string; message?: string }[] };
      expect(body.error).toBe("invalid_json");
      expect(existsSync(configPath)).toBe(false);
    });

    test("write failure → 500, no half-written file", async () => {
      // Pass a path whose parent exists but is a *file*, not a directory —
      // mkdirSync will throw EEXIST/ENOTDIR. Verifies the error path returns
      // a 500 rather than crashing the handler.
      const blocker = join(dir, "blocker");
      // Create a file at the position we'll try to mkdir under.
      writeFileSync(blocker, "x");
      const handler = buildHandler(join(blocker, "config.json"));
      const res = await handler(putReq({ transcribeProvider: "whisper" }));
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown> & { errors?: { path: string; message?: string }[] };
      expect(body.error).toBe("write_failed");
    });
  });

  describe("closed mode (SCRIBE_AUTH_TOKEN set)", () => {
    beforeEach(() => {
      process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    });

    test("missing bearer → 401", async () => {
      const handler = buildHandler(configPath);
      const res = await handler(putReq({ transcribeProvider: "whisper" }));
      expect(res.status).toBe(401);
      expect(existsSync(configPath)).toBe(false);
    });

    test("wrong bearer → 401", async () => {
      const handler = buildHandler(configPath);
      const res = await handler(putReq({ transcribeProvider: "whisper" }, "wrong"));
      expect(res.status).toBe(401);
    });

    test("matching shared-secret bearer → 200 (shared secret grants both scopes)", async () => {
      const handler = buildHandler(configPath);
      const res = await handler(
        putReq({ transcribeProvider: "whisper" }, "s3cret"),
      );
      expect(res.status).toBe(200);
      expect(existsSync(configPath)).toBe(true);
    });
  });

  describe("method check", () => {
    beforeEach(() => {
      delete process.env.SCRIBE_AUTH_TOKEN;
    });

    test("POST /.parachute/config → 405 (only GET + PUT)", async () => {
      const handler = buildHandler(configPath);
      const req = new Request("http://localhost/.parachute/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const res = await handler(req);
      expect(res.status).toBe(405);
    });

    test("DELETE /.parachute/config → 405", async () => {
      const handler = buildHandler(configPath);
      const res = await handler(
        new Request("http://localhost/.parachute/config", { method: "DELETE" }),
      );
      expect(res.status).toBe(405);
    });
  });
});

describe("GET /scribe/admin", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  test("returns 200 with HTML body in open mode", async () => {
    delete process.env.SCRIBE_AUTH_TOKEN;
    const handler = buildHandler("/tmp/unused");
    const res = await handler(new Request("http://localhost/scribe/admin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  test("HTML contains the key form field names", async () => {
    delete process.env.SCRIBE_AUTH_TOKEN;
    const handler = buildHandler("/tmp/unused");
    const res = await handler(new Request("http://localhost/scribe/admin"));
    const html = await res.text();
    for (const name of [
      "transcribeProvider",
      "cleanupProvider",
      "cleanupDefault",
      "cleanupSystemPrompt",
      "cleanupContextTemplate",
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
  });

  test("HTML contains JS that fetches schema + config on load", async () => {
    delete process.env.SCRIBE_AUTH_TOKEN;
    const handler = buildHandler("/tmp/unused");
    const res = await handler(new Request("http://localhost/scribe/admin"));
    const html = await res.text();
    expect(html).toContain("/.parachute/config/schema");
    expect(html).toContain("/.parachute/config");
    expect(html).toContain("DOMContentLoaded");
    expect(html).toContain("PUT");
  });

  test("HTML contains the restart-required banner copy and field labels", async () => {
    delete process.env.SCRIBE_AUTH_TOKEN;
    const handler = buildHandler("/tmp/unused");
    const res = await handler(new Request("http://localhost/scribe/admin"));
    const html = await res.text();
    // Change 4 — restart-required banner copy. The phrasing now leads with
    // "Saved — but not live yet" (rendered from the &mdash; entity) and spells
    // out the exact restart command so the operator doesn't assume a new
    // backend is live before restarting.
    expect(html).toContain("Saved &mdash; but not live yet");
    expect(html).toContain("parachute restart scribe");
    expect(html).toContain("Transcription provider");
    expect(html).toContain("Cleanup provider");
  });

  test("HTML contains the port-hint footnote (services.json / SCRIBE_PORT)", async () => {
    // scribe#45 review nit 1 — the restart-required banner needs to tell the
    // operator that `port` is NOT writable from config.json. Pin the copy.
    delete process.env.SCRIBE_AUTH_TOKEN;
    const handler = buildHandler("/tmp/unused");
    const res = await handler(new Request("http://localhost/scribe/admin"));
    const html = await res.text();
    expect(html).toContain("services.json");
    expect(html).toContain("SCRIBE_PORT");
  });

  test("HTML uses trustedHtml as the setBanner parameter name (nit 2)", async () => {
    // Light-touch pin so a future author can't silently drop the rename
    // without thinking about the contract it documents.
    delete process.env.SCRIBE_AUTH_TOKEN;
    const handler = buildHandler("/tmp/unused");
    const res = await handler(new Request("http://localhost/scribe/admin"));
    const html = await res.text();
    expect(html).toContain("trustedHtml");
  });

  test("closed mode without bearer → 401", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    const handler = buildHandler("/tmp/unused");
    const res = await handler(new Request("http://localhost/scribe/admin"));
    expect(res.status).toBe(401);
  });

  test("closed mode with shared-secret bearer → 200", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    const handler = buildHandler("/tmp/unused");
    const res = await handler(
      new Request("http://localhost/scribe/admin", {
        headers: { Authorization: "Bearer s3cret" },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/backend-availability", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  test("open mode → 200 with transcribe + cleanup report shape", async () => {
    delete process.env.SCRIBE_AUTH_TOKEN;
    // Inject a setup-token stub so the claude-code probe doesn't read the
    // real ~/.claude.json on the test host.
    const handler = buildHandler("/tmp/unused", {
      setupTokenStatusFn: () => "not-configured",
    });
    const res = await handler(
      new Request("http://localhost/admin/backend-availability"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      transcribe: Record<string, { status: string }>;
      cleanup: Record<string, { status: string }>;
    };
    expect(body.transcribe).toBeObject();
    expect(body.cleanup).toBeObject();
    // Every backend gets a verdict with a status string.
    expect(body.cleanup["none"]?.status).toBe("ok-no-check");
    expect(typeof body.transcribe["onnx-asr"]?.status).toBe("string");
  });

  test("closed mode without bearer → 401 (scribe:admin gated)", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    const handler = buildHandler("/tmp/unused");
    const res = await handler(
      new Request("http://localhost/admin/backend-availability"),
    );
    expect(res.status).toBe(401);
  });

  test("POST to the availability endpoint → 404 (GET-only)", async () => {
    delete process.env.SCRIBE_AUTH_TOKEN;
    const handler = buildHandler("/tmp/unused");
    const res = await handler(
      new Request("http://localhost/admin/backend-availability", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });
});
