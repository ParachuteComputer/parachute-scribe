/**
 * Wire-level tests for the site#52 Part 1 surfaces:
 *
 *   - `GET /.parachute/config` omits writeOnly apiKey fields (omit, don't redact)
 *   - `PUT /.parachute/config` omit-to-keep: empty/absent apiKey preserves
 *     stored value; non-empty replaces
 *   - `POST /admin/refresh-claude-token-status` returns the current status
 *   - `POST /v1/audio/transcriptions` returns 400 missing_provider when
 *     no transcribe provider is wired up (graceful first-boot path)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
import type { ScribeConfig } from "./config.ts";

const BASE_RESOLVED: ResolvedConfig = {
  transcribeProvider: "groq",
  transcribeProviders: {},
  cleanupProvider: "anthropic",
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
    resolvedConfig: BASE_RESOLVED,
    scribeConfig: {},
    configPath,
    setupTokenStatusFn: () => "not-configured",
    ...overrides,
  };
  return createFetchHandler(deps);
}

function getConfigReq(): Request {
  return new Request("http://localhost/.parachute/config");
}

function putConfigReq(body: unknown): Request {
  return new Request("http://localhost/.parachute/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /.parachute/config — writeOnly omission + setupTokenStatus inline", () => {
  let dir: string;
  let configPath: string;
  let originalToken: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-get-cfg-"));
    configPath = join(dir, "scribe", "config.json");
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  test("apiKey is OMITTED from every per-provider block (writeOnly contract)", async () => {
    const scribeConfig: ScribeConfig = {
      transcribeProviders: { groq: { apiKey: "sekrit", model: "whisper-large-v3" } },
      cleanupProviders: {
        anthropic: { apiKey: "another-sekrit", model: "claude-3-5-haiku-20241022" },
      },
    };
    const handler = buildHandler(configPath, { scribeConfig });
    const res = await handler(getConfigReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      transcribeProviders: Record<string, Record<string, unknown> | undefined>;
      cleanupProviders: Record<string, Record<string, unknown> | undefined>;
    };
    // Top-level secrets gone — every apiKey field absent.
    expect(body.transcribeProviders.groq?.apiKey).toBeUndefined();
    expect(body.cleanupProviders.anthropic?.apiKey).toBeUndefined();
    // But the SPA can still see that an apiKey is stored (placeholder UX).
    expect(body.transcribeProviders.groq?.apiKeyConfigured).toBe(true);
    expect(body.cleanupProviders.anthropic?.apiKeyConfigured).toBe(true);
    // Non-secret fields ARE on the wire.
    expect(body.transcribeProviders.groq?.model).toBe("whisper-large-v3");
    expect(body.cleanupProviders.anthropic?.model).toBe("claude-3-5-haiku-20241022");
  });

  test("setupTokenStatus is embedded under cleanupProviders['claude-code']", async () => {
    const handler = buildHandler(configPath, {
      setupTokenStatusFn: () => "configured",
    });
    const res = await handler(getConfigReq());
    const body = (await res.json()) as {
      cleanupProviders: { "claude-code": { setupTokenStatus?: string } };
    };
    expect(body.cleanupProviders["claude-code"].setupTokenStatus).toBe("configured");
  });

  test("setupTokenStatus reflects 'not-configured' on a fresh deploy", async () => {
    const handler = buildHandler(configPath, {
      setupTokenStatusFn: () => "not-configured",
    });
    const res = await handler(getConfigReq());
    const body = (await res.json()) as {
      cleanupProviders: { "claude-code": { setupTokenStatus?: string } };
    };
    expect(body.cleanupProviders["claude-code"].setupTokenStatus).toBe("not-configured");
  });

  test("cleanupProviders includes a block per registered cleaner", async () => {
    const handler = buildHandler(configPath);
    const res = await handler(getConfigReq());
    const body = (await res.json()) as {
      cleanupProviders: Record<string, unknown>;
    };
    for (const name of ["anthropic", "claude-code", "ollama", "openai", "gemini", "groq", "custom", "none"]) {
      expect(body.cleanupProviders[name]).toBeDefined();
    }
  });
});

describe("PUT /.parachute/config — omit-to-keep semantics for writeOnly apiKey", () => {
  let dir: string;
  let configPath: string;
  let originalToken: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-put-omit-"));
    configPath = join(dir, "scribe", "config.json");
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  function seed(body: object): void {
    mkdirSync(join(dir, "scribe"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(body), { mode: 0o600 });
  }

  test("absent apiKey on PUT preserves the stored value", async () => {
    seed({ transcribeProviders: { groq: { apiKey: "old-key", model: "old-model" } } });
    const handler = buildHandler(configPath);
    const res = await handler(
      putConfigReq({ transcribeProviders: { groq: { model: "new-model" } } }),
    );
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.transcribeProviders.groq.apiKey).toBe("old-key");
    expect(onDisk.transcribeProviders.groq.model).toBe("new-model");
  });

  test("empty-string apiKey on PUT preserves the stored value", async () => {
    seed({ transcribeProviders: { groq: { apiKey: "old-key" } } });
    const handler = buildHandler(configPath);
    const res = await handler(
      putConfigReq({ transcribeProviders: { groq: { apiKey: "" } } }),
    );
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.transcribeProviders.groq.apiKey).toBe("old-key");
  });

  test("non-empty apiKey on PUT replaces the stored value", async () => {
    seed({ transcribeProviders: { groq: { apiKey: "old-key" } } });
    const handler = buildHandler(configPath);
    const res = await handler(
      putConfigReq({ transcribeProviders: { groq: { apiKey: "new-key" } } }),
    );
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.transcribeProviders.groq.apiKey).toBe("new-key");
  });

  test("a PUT that doesn't mention transcribeProviders leaves the existing block alone", async () => {
    seed({
      cleanup: { provider: "anthropic" },
      transcribeProviders: { groq: { apiKey: "untouched-key" } },
    });
    const handler = buildHandler(configPath);
    const res = await handler(
      putConfigReq({ cleanupSystemPrompt: "PROMPT" }),
    );
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.transcribeProviders.groq.apiKey).toBe("untouched-key");
  });

  test("partial provider block — setting just model preserves apiKey", async () => {
    seed({ cleanupProviders: { anthropic: { apiKey: "akey", model: "old" } } });
    const handler = buildHandler(configPath);
    const res = await handler(
      putConfigReq({ cleanupProviders: { anthropic: { model: "new" } } }),
    );
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.cleanupProviders.anthropic.apiKey).toBe("akey");
    expect(onDisk.cleanupProviders.anthropic.model).toBe("new");
  });

  test("setupTokenStatus echoed in body is silently ignored on PUT (readOnly)", async () => {
    seed({});
    const handler = buildHandler(configPath);
    const res = await handler(
      putConfigReq({
        cleanupProviders: {
          "claude-code": { setupTokenStatus: "configured" },
        },
      }),
    );
    // No validation error — we tolerate the field echoing back on a SPA save.
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    // The status isn't persisted (it's read from ~/.claude.json per-request).
    expect(onDisk.cleanupProviders?.["claude-code"]?.setupTokenStatus).toBeUndefined();
  });

  test("unknown provider name in transcribeProviders → 400 validation", async () => {
    const handler = buildHandler(configPath);
    const res = await handler(
      putConfigReq({
        transcribeProviders: { "not-real": { apiKey: "x" } },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { path: string }[] };
    expect(body.errors.some((e) => e.path.includes("not-real"))).toBe(true);
  });

  test("PUT updates the in-process scribeConfig so the next request sees new values", async () => {
    seed({});
    const scribeConfig: ScribeConfig = {};
    const handler = buildHandler(configPath, { scribeConfig });
    await handler(
      putConfigReq({
        transcribeProviders: { groq: { apiKey: "new-key" } },
      }),
    );
    // In-process scribeConfig was patched.
    expect(scribeConfig.transcribeProviders?.groq?.apiKey).toBe("new-key");
  });
});

describe("POST /admin/refresh-claude-token-status", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  test("returns the current status as { setupTokenStatus: ... }", async () => {
    const handler = buildHandler("/tmp/unused", {
      setupTokenStatusFn: () => "configured",
    });
    const res = await handler(
      new Request("http://localhost/admin/refresh-claude-token-status", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setupTokenStatus: "configured" });
  });

  test("re-reads status on each call (not-configured then configured)", async () => {
    let status: "configured" | "not-configured" = "not-configured";
    const handler = buildHandler("/tmp/unused", { setupTokenStatusFn: () => status });

    let res = await handler(
      new Request("http://localhost/admin/refresh-claude-token-status", { method: "POST" }),
    );
    expect(await res.json()).toEqual({ setupTokenStatus: "not-configured" });

    status = "configured";
    res = await handler(
      new Request("http://localhost/admin/refresh-claude-token-status", { method: "POST" }),
    );
    expect(await res.json()).toEqual({ setupTokenStatus: "configured" });
  });

  test("requires scribe:admin in closed mode (401 without bearer)", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    const handler = buildHandler("/tmp/unused");
    const res = await handler(
      new Request("http://localhost/admin/refresh-claude-token-status", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  test("shared-secret bearer passes in closed mode", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    const handler = buildHandler("/tmp/unused", {
      setupTokenStatusFn: () => "unknown",
    });
    const res = await handler(
      new Request("http://localhost/admin/refresh-claude-token-status", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setupTokenStatus: "unknown" });
  });
});

describe("POST /v1/audio/transcriptions — graceful missing-provider 400", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  function audioReq(): Request {
    const form = new FormData();
    form.set("file", new File(["audio bytes"], "test.wav"));
    return new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
  }

  test("returns 400 missing_provider when transcribe is null", async () => {
    const handler = buildHandler("/tmp/unused", {
      transcribe: null,
    });
    const res = await handler(audioReq());
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("no transcription provider configured");
    expect(body.error_code).toBe("missing_provider");
    expect(body.message).toBeString();
  });

  test("still rejects missing file with 400 (missing 'file' check runs first)", async () => {
    const handler = buildHandler("/tmp/unused", { transcribe: null });
    const res = await handler(
      new Request("http://localhost/v1/audio/transcriptions", {
        method: "POST",
        body: new FormData(),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("missing");
  });

  test("happy path proceeds when transcribe is non-null", async () => {
    const handler = buildHandler("/tmp/unused", {
      transcribe: async () => "transcribed",
    });
    const res = await handler(audioReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "transcribed" });
  });
});

describe("PUT /.parachute/config — empty-body no-op", () => {
  let dir: string;
  let configPath: string;
  let originalToken: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-put-empty-"));
    configPath = join(dir, "scribe", "config.json");
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  test("PUT {} returns 200 + restart_required:[] + leaves existing values alone", async () => {
    mkdirSync(join(dir, "scribe"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        transcribeProviders: { groq: { apiKey: "k", model: "m" } },
      }),
      { mode: 0o600 },
    );
    const handler = buildHandler(configPath);
    const res = await handler(putConfigReq({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restart_required: string[] };
    expect(body.restart_required).toEqual([]);
    // Original on-disk values survive.
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.transcribeProviders.groq.apiKey).toBe("k");
    expect(onDisk.transcribeProviders.groq.model).toBe("m");
  });
});

describe("POST /admin/clear-credential/<kind>/<name> — Phase 2 (scribe#47 follow-up)", () => {
  let dir: string;
  let configPath: string;
  let originalToken: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-clear-cred-"));
    configPath = join(dir, "scribe", "config.json");
    originalToken = process.env.SCRIBE_AUTH_TOKEN;
    delete process.env.SCRIBE_AUTH_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.SCRIBE_AUTH_TOKEN;
    else process.env.SCRIBE_AUTH_TOKEN = originalToken;
  });

  function clearReq(path: string, token?: string): Request {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    return new Request(`http://localhost${path}`, { method: "POST", headers });
  }

  function seedConfig(cfg: Record<string, unknown>): void {
    mkdirSync(join(dir, "scribe"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
  }

  test("happy path: clears cleanup/anthropic apiKey + returns 200 with hadStoredValue:true", async () => {
    seedConfig({
      cleanupProviders: { anthropic: { apiKey: "sk-ant-real", model: "claude-3-5-sonnet" } },
    });
    const scribeConfig: ScribeConfig = {
      cleanupProviders: { anthropic: { apiKey: "sk-ant-real", model: "claude-3-5-sonnet" } },
    };
    const handler = buildHandler(configPath, { scribeConfig });

    const res = await handler(clearReq("/admin/clear-credential/cleanup/anthropic"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      cleared: { kind: string; name: string; field: string };
      hadStoredValue: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.cleared).toEqual({ kind: "cleanup", name: "anthropic", field: "apiKey" });
    expect(body.hadStoredValue).toBe(true);

    // On-disk: model survives, apiKey is gone.
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.cleanupProviders.anthropic.apiKey).toBeUndefined();
    expect(onDisk.cleanupProviders.anthropic.model).toBe("claude-3-5-sonnet");
    // In-process scribeConfig mirrors disk so the next request doesn't keep the stale key.
    expect(scribeConfig.cleanupProviders?.anthropic?.apiKey).toBeUndefined();
    expect(scribeConfig.cleanupProviders?.anthropic?.model).toBe("claude-3-5-sonnet");
  });

  test("idempotent no-op: clearing when nothing stored returns 200 with hadStoredValue:false", async () => {
    // No seed — config doesn't exist yet on disk.
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/cleanup/anthropic"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hadStoredValue: boolean };
    expect(body.ok).toBe(true);
    expect(body.hadStoredValue).toBe(false);
  });

  test("idempotent no-op: clearing apiKey-only provider drops the empty entry", async () => {
    // Provider entry that holds ONLY apiKey gets removed entirely so the
    // on-disk file doesn't accumulate `{provider: {}}` shells.
    seedConfig({
      cleanupProviders: { anthropic: { apiKey: "sk-ant-real" } },
    });
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/cleanup/anthropic"));
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    // Provider entry gone AND cleanupProviders map gone (it's now empty).
    expect(onDisk.cleanupProviders).toBeUndefined();
  });

  test("transcribe kind: clears groq apiKey while preserving model", async () => {
    seedConfig({
      transcribeProviders: { groq: { apiKey: "gsk_real", model: "whisper-large-v3" } },
    });
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/transcribe/groq"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cleared: { kind: string; name: string; field: string } };
    expect(body.cleared.kind).toBe("transcribe");
    expect(body.cleared.name).toBe("groq");
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.transcribeProviders.groq.apiKey).toBeUndefined();
    expect(onDisk.transcribeProviders.groq.model).toBe("whisper-large-v3");
  });

  test("GET /.parachute/config reflects the clear: apiKeyConfigured is false after", async () => {
    seedConfig({
      cleanupProviders: { anthropic: { apiKey: "sk-ant-real", model: "claude-3-5-sonnet" } },
    });
    const scribeConfig: ScribeConfig = {
      cleanupProviders: { anthropic: { apiKey: "sk-ant-real", model: "claude-3-5-sonnet" } },
    };
    const handler = buildHandler(configPath, { scribeConfig });

    // Pre: GET shows apiKeyConfigured: true.
    const preRes = await handler(getConfigReq());
    const preBody = (await preRes.json()) as { cleanupProviders: Record<string, { apiKeyConfigured?: boolean; model?: string }> };
    expect(preBody.cleanupProviders.anthropic?.apiKeyConfigured).toBe(true);

    // Clear.
    await handler(clearReq("/admin/clear-credential/cleanup/anthropic"));

    // Post: GET no longer reports apiKeyConfigured (writeOnly omission + no value).
    const postRes = await handler(getConfigReq());
    const postBody = (await postRes.json()) as { cleanupProviders: Record<string, { apiKeyConfigured?: boolean; model?: string }> };
    expect(postBody.cleanupProviders.anthropic?.apiKeyConfigured).toBeUndefined();
    // Model survives in the GET response too.
    expect(postBody.cleanupProviders.anthropic?.model).toBe("claude-3-5-sonnet");
  });

  test("400 invalid_kind: kind not in enum", async () => {
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/bogus/anthropic"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_kind");
    expect(body.message).toContain("transcribe");
    expect(body.message).toContain("cleanup");
  });

  test("400 unknown_provider: kind valid but name not in registry", async () => {
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/cleanup/not-a-thing"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_provider");
    expect(body.message).toContain("not-a-thing");
  });

  test("400 unknown_provider: name from the OTHER kind's registry is rejected", async () => {
    // `parakeet-mlx` is a transcribe provider — not valid under cleanup.
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/cleanup/parakeet-mlx"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_provider");
  });

  test("400 invalid_path: missing name segment", async () => {
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/cleanup"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_path");
  });

  test("400 invalid_path: extra segments past kind/name", async () => {
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/cleanup/anthropic/apiKey"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_path");
  });

  test("401 missing bearer in closed mode", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    seedConfig({ cleanupProviders: { anthropic: { apiKey: "sk-ant" } } });
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/cleanup/anthropic"));
    expect(res.status).toBe(401);
    // On-disk apiKey untouched.
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.cleanupProviders.anthropic.apiKey).toBe("sk-ant");
  });

  test("401 wrong bearer in closed mode", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    seedConfig({ cleanupProviders: { anthropic: { apiKey: "sk-ant" } } });
    const handler = buildHandler(configPath);
    const res = await handler(
      clearReq("/admin/clear-credential/cleanup/anthropic", "wrong"),
    );
    expect(res.status).toBe(401);
  });

  test("200 with matching shared-secret bearer (grants scribe:admin)", async () => {
    process.env.SCRIBE_AUTH_TOKEN = "s3cret";
    seedConfig({ cleanupProviders: { anthropic: { apiKey: "sk-ant", model: "m" } } });
    const handler = buildHandler(configPath);
    const res = await handler(
      clearReq("/admin/clear-credential/cleanup/anthropic", "s3cret"),
    );
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.cleanupProviders.anthropic.apiKey).toBeUndefined();
    expect(onDisk.cleanupProviders.anthropic.model).toBe("m");
  });

  test("405-ish: GET on the clear-credential path falls through to 404", async () => {
    // The route only matches POST. GET hits the catch-all 404 — by design,
    // since this is a side-effecting verb only.
    const handler = buildHandler(configPath);
    const res = await handler(
      new Request("http://localhost/admin/clear-credential/cleanup/anthropic"),
    );
    // Either 404 or 405 is acceptable here; the contract is "not a GET endpoint."
    expect([404, 405]).toContain(res.status);
  });

  test("clearing one provider's apiKey doesn't touch siblings", async () => {
    seedConfig({
      cleanupProviders: {
        anthropic: { apiKey: "sk-ant-real", model: "claude-3-5-sonnet" },
        openai: { apiKey: "sk-openai-real", model: "gpt-4o" },
      },
    });
    const handler = buildHandler(configPath);
    const res = await handler(clearReq("/admin/clear-credential/cleanup/anthropic"));
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.cleanupProviders.anthropic.apiKey).toBeUndefined();
    expect(onDisk.cleanupProviders.openai.apiKey).toBe("sk-openai-real");
    expect(onDisk.cleanupProviders.openai.model).toBe("gpt-4o");
  });
});
