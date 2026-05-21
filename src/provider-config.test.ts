/**
 * Per-request API-key reads — the load-bearing test for the
 * "paste apiKey, save, next request uses the new value (no restart)" UX
 * claim in site#52 Part 1.
 *
 * Strategy: drive `loadConfig()` through a tmp `PARACHUTE_HOME`, write the
 * config file directly between calls, and assert the resolver returns
 * different values on each call. No module-scope env-var caching, no boot-
 * time freezing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCleanupProviderConfig,
  getTranscribeProviderConfig,
  resolveCleanupProviderConfig,
  resolveTranscribeProviderConfig,
} from "./provider-config.ts";

function seedConfig(home: string, body: object): string {
  const path = join(home, "scribe", "config.json");
  mkdirSync(join(home, "scribe"), { recursive: true });
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

describe("provider-config — precedence (config > env > defaults)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "scribe-pc-"));
    prevHome = process.env.PARACHUTE_HOME;
    process.env.PARACHUTE_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = prevHome;
  });

  test("config.json apiKey wins over env apiKey (transcribe groq)", async () => {
    seedConfig(home, {
      transcribeProviders: { groq: { apiKey: "from-config" } },
    });
    const cfg = await getTranscribeProviderConfig("groq", { GROQ_API_KEY: "from-env" });
    expect(cfg.apiKey).toBe("from-config");
  });

  test("env apiKey wins over default when config absent (transcribe groq)", async () => {
    seedConfig(home, {});
    const cfg = await getTranscribeProviderConfig("groq", { GROQ_API_KEY: "from-env" });
    expect(cfg.apiKey).toBe("from-env");
  });

  test("default model used when neither config nor env model set (transcribe groq)", async () => {
    seedConfig(home, {});
    const cfg = await getTranscribeProviderConfig("groq", {});
    expect(cfg.model).toBe("whisper-large-v3");
  });

  test("config model wins over default (transcribe groq)", async () => {
    seedConfig(home, {
      transcribeProviders: { groq: { model: "custom-model" } },
    });
    const cfg = await getTranscribeProviderConfig("groq", {});
    expect(cfg.model).toBe("custom-model");
  });

  test("empty-string apiKey in config falls through to env (so a writeOnly placeholder doesn't shadow env)", async () => {
    seedConfig(home, {
      transcribeProviders: { groq: { apiKey: "" } },
    });
    const cfg = await getTranscribeProviderConfig("groq", { GROQ_API_KEY: "from-env" });
    expect(cfg.apiKey).toBe("from-env");
  });

  test("cleanup anthropic: config.cleanupProviders.anthropic.apiKey wins over ANTHROPIC_API_KEY env", async () => {
    seedConfig(home, {
      cleanupProviders: { anthropic: { apiKey: "from-config", model: "claude-3-5-haiku-20241022" } },
    });
    const cfg = await getCleanupProviderConfig("anthropic", { ANTHROPIC_API_KEY: "from-env" });
    expect(cfg.apiKey).toBe("from-config");
    expect(cfg.model).toBe("claude-3-5-haiku-20241022");
  });

  test("ollama url + model resolved from config", async () => {
    seedConfig(home, {
      cleanupProviders: { ollama: { url: "http://example:11434", model: "llama3" } },
    });
    const cfg = await getCleanupProviderConfig("ollama", {});
    expect(cfg.url).toBe("http://example:11434");
    expect(cfg.model).toBe("llama3");
  });

  test("ollama defaults when nothing set", async () => {
    seedConfig(home, {});
    const cfg = await getCleanupProviderConfig("ollama", {});
    expect(cfg.url).toBe("http://localhost:11434");
    expect(cfg.model).toBe("gemma4:e4b");
  });
});

describe("provider-config — per-request reads (no module-scope cache)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "scribe-pc-live-"));
    prevHome = process.env.PARACHUTE_HOME;
    process.env.PARACHUTE_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = prevHome;
  });

  test("rewriting config.json between calls returns the new apiKey on the next call (no restart)", async () => {
    seedConfig(home, {
      transcribeProviders: { groq: { apiKey: "v1" } },
    });
    const first = await getTranscribeProviderConfig("groq", {});
    expect(first.apiKey).toBe("v1");

    // Operator clicks Save in the SPA — config.json now carries v2.
    seedConfig(home, {
      transcribeProviders: { groq: { apiKey: "v2" } },
    });
    const second = await getTranscribeProviderConfig("groq", {});
    expect(second.apiKey).toBe("v2");
  });
});

describe("provider-config — synchronous variant", () => {
  test("resolveTranscribeProviderConfig honors precedence (config > env > default)", () => {
    const cfg = resolveTranscribeProviderConfig(
      "groq",
      { transcribeProviders: { groq: { apiKey: "k", model: "m" } } },
      {},
    );
    expect(cfg.apiKey).toBe("k");
    expect(cfg.model).toBe("m");
  });

  test("resolveCleanupProviderConfig handles claude-code (no apiKey, no env)", () => {
    const cfg = resolveCleanupProviderConfig("claude-code", {}, {});
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.model).toBeUndefined();
    expect(cfg.url).toBeUndefined();
  });
});
