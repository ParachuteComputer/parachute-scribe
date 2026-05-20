import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config-schema.ts";
import {
  detectRestartRequired,
  toFileShape,
  validateConfig,
  writeConfigFileAtomic,
} from "./config-write.ts";

const BASE_RESOLVED: ResolvedConfig = {
  transcribeProvider: "parakeet-mlx",
  cleanupProvider: "none",
  cleanupDefault: true,
  cleanupSystemPrompt: null,
  cleanupContextTemplate: null,
  port: 1943,
};

describe("validateConfig", () => {
  test("accepts a complete, well-typed body and returns it verbatim", () => {
    const body = {
      transcribeProvider: "parakeet-mlx",
      cleanupProvider: "ollama",
      cleanupDefault: false,
      cleanupSystemPrompt: "PROMPT",
      cleanupContextTemplate: "ctx {{proper_nouns}}",
      port: 1943,
    };
    const result = validateConfig(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(body);
  });

  test("accepts an empty object (partial PUT)", () => {
    const result = validateConfig({});
    expect(result.ok).toBe(true);
  });

  test("rejects non-object bodies", () => {
    for (const v of [null, undefined, "string", 5, true, []]) {
      const r = validateConfig(v as unknown);
      expect(r.ok).toBe(false);
    }
  });

  test("rejects unknown top-level keys", () => {
    const r = validateConfig({ frobnicator: "x", transcribeProvider: "parakeet-mlx" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "frobnicator")).toBe(true);
  });

  test("rejects transcribeProvider not in enum", () => {
    const r = validateConfig({ transcribeProvider: "not-a-real-provider" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe("transcribeProvider");
  });

  test("rejects cleanupProvider not in enum (case-sensitive)", () => {
    const r = validateConfig({ cleanupProvider: "Claude" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe("cleanupProvider");
  });

  test("rejects port outside 1..65535", () => {
    const high = validateConfig({ port: 70000 });
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.errors[0]?.path).toBe("port");
    const low = validateConfig({ port: 0 });
    expect(low.ok).toBe(false);
    const float = validateConfig({ port: 19.43 });
    expect(float.ok).toBe(false);
  });

  test("rejects cleanupDefault that is not a boolean", () => {
    const r = validateConfig({ cleanupDefault: "true" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe("cleanupDefault");
  });

  test("accepts explicit null for the two clearable string fields", () => {
    const r = validateConfig({
      cleanupSystemPrompt: null,
      cleanupContextTemplate: null,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects null for non-clearable fields", () => {
    const r = validateConfig({ transcribeProvider: null });
    expect(r.ok).toBe(false);
  });

  test("collects multiple errors in one pass", () => {
    const r = validateConfig({
      transcribeProvider: "nope",
      cleanupProvider: "nope",
      port: -1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(3);
  });
});

describe("toFileShape", () => {
  test("translates flat camelCase wire shape to nested file shape", () => {
    expect(
      toFileShape({
        transcribeProvider: "whisper",
        cleanupProvider: "ollama",
        cleanupDefault: false,
        cleanupSystemPrompt: "PROMPT",
        cleanupContextTemplate: "CTX",
      }),
    ).toEqual({
      transcribe: { provider: "whisper" },
      cleanup: {
        provider: "ollama",
        default: false,
        system_prompt: "PROMPT",
        context_template: "CTX",
      },
    });
  });

  test("omits the transcribe block when transcribeProvider absent", () => {
    expect(toFileShape({ cleanupProvider: "none" })).toEqual({
      cleanup: { provider: "none" },
    });
  });

  test("omits cleanup block entirely when no cleanup-* fields are present", () => {
    expect(toFileShape({ transcribeProvider: "whisper" })).toEqual({
      transcribe: { provider: "whisper" },
    });
  });

  test("does NOT write port to disk (port is resolved from services.json / env)", () => {
    const file = toFileShape({ transcribeProvider: "whisper", port: 1944 });
    expect(file).toEqual({ transcribe: { provider: "whisper" } });
    expect((file as Record<string, unknown>).port).toBeUndefined();
  });

  test("explicit null on a clearable field skips writing it (don't pin an empty string)", () => {
    const file = toFileShape({
      cleanupProvider: "ollama",
      cleanupSystemPrompt: null,
      cleanupContextTemplate: null,
    });
    expect(file).toEqual({ cleanup: { provider: "ollama" } });
  });
});

describe("detectRestartRequired", () => {
  test("empty diff when incoming matches resolved", () => {
    const list = detectRestartRequired(BASE_RESOLVED, {
      transcribeProvider: "parakeet-mlx",
      cleanupProvider: "none",
      cleanupDefault: true,
      port: 1943,
    });
    expect(list).toEqual([]);
  });

  test("transcribeProvider change is restart-required", () => {
    const list = detectRestartRequired(BASE_RESOLVED, { transcribeProvider: "whisper" });
    expect(list).toEqual(["transcribeProvider"]);
  });

  test("cleanupProvider change is restart-required", () => {
    const list = detectRestartRequired(BASE_RESOLVED, { cleanupProvider: "ollama" });
    expect(list).toEqual(["cleanupProvider"]);
  });

  test("port change is restart-required", () => {
    const list = detectRestartRequired(BASE_RESOLVED, { port: 1944 });
    expect(list).toEqual(["port"]);
  });

  test("system_prompt change alone is NOT restart-required (read dynamically)", () => {
    const list = detectRestartRequired(BASE_RESOLVED, {
      cleanupSystemPrompt: "NEW PROMPT",
    });
    expect(list).toEqual([]);
  });

  test("cleanupDefault toggle alone is NOT restart-required (read dynamically)", () => {
    const list = detectRestartRequired(BASE_RESOLVED, { cleanupDefault: false });
    expect(list).toEqual([]);
  });

  test("context_template change alone is NOT restart-required", () => {
    const list = detectRestartRequired(BASE_RESOLVED, {
      cleanupContextTemplate: "X {{proper_nouns}}",
    });
    expect(list).toEqual([]);
  });

  test("absent field never counts even if resolved differs (no-change-requested)", () => {
    // resolved.transcribeProvider is "parakeet-mlx"; absent in incoming.
    // No change requested → not listed.
    const list = detectRestartRequired(BASE_RESOLVED, { cleanupSystemPrompt: "x" });
    expect(list).toEqual([]);
  });

  test("combined provider + prompt change lists only the provider", () => {
    const list = detectRestartRequired(BASE_RESOLVED, {
      transcribeProvider: "whisper",
      cleanupSystemPrompt: "NEW",
    });
    expect(list).toEqual(["transcribeProvider"]);
  });
});

describe("writeConfigFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-write-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes the config to disk and trailing-newlines", () => {
    const path = join(dir, "scribe", "config.json");
    writeConfigFileAtomic(path, {
      transcribe: { provider: "whisper" },
      cleanup: { provider: "ollama", default: false },
    });
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      transcribe: { provider: "whisper" },
      cleanup: { provider: "ollama", default: false },
    });
  });

  test("is idempotent — repeated writes produce the same content", () => {
    const path = join(dir, "scribe", "config.json");
    writeConfigFileAtomic(path, { transcribe: { provider: "whisper" } });
    writeConfigFileAtomic(path, { transcribe: { provider: "whisper" } });
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify({ transcribe: { provider: "whisper" } }, null, 2)}\n`,
    );
  });

  test("creates intermediate directories if missing", () => {
    const path = join(dir, "nested", "deeper", "scribe", "config.json");
    writeConfigFileAtomic(path, { cleanup: { provider: "none" } });
    expect(existsSync(path)).toBe(true);
  });

  test("does not leave a partial tmp file behind on success", () => {
    const target = join(dir, "scribe", "config.json");
    writeConfigFileAtomic(target, { cleanup: { provider: "none" } });
    const leftovers = readdirSync(join(dir, "scribe")).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
