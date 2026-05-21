import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "./config-schema.ts";
import {
  detectRestartRequired,
  mergeIntoFileShape,
  readExistingConfig,
  toFileShape,
  validateConfig,
  writeConfigFileAtomic,
} from "./config-write.ts";

const BASE_RESOLVED: ResolvedConfig = {
  transcribeProvider: "parakeet-mlx",
  transcribeProviders: {},
  cleanupProvider: "none",
  cleanupDefault: true,
  cleanupProviders: {},
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

  test("explicit null on a clearable field is preserved as a deletion sentinel", () => {
    // `null` now flows through `toFileShape` so `mergeIntoFileShape` can act
    // on it. The merger drops null-valued keys from the merged-on-disk
    // shape; `toFileShape` alone no longer makes that decision (scribe#45
    // must-fix 1 — the prior behavior silently no-op'd a textarea clear).
    const file = toFileShape({
      cleanupProvider: "ollama",
      cleanupSystemPrompt: null,
      cleanupContextTemplate: null,
    });
    expect(file).toEqual({
      cleanup: {
        provider: "ollama",
        system_prompt: null,
        context_template: null,
      },
    });
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

  test("written file has 0o600 mode (owner-only — scribe#45 must-fix 2)", () => {
    const path = join(dir, "scribe", "config.json");
    writeConfigFileAtomic(path, { cleanup: { provider: "none" } });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("rewrite preserves 0o600 — even if someone chmod'd to 644 between writes", () => {
    const path = join(dir, "scribe", "config.json");
    writeConfigFileAtomic(path, { cleanup: { provider: "none" } });
    // Simulate an out-of-band chmod that loosened the perms.
    require("node:fs").chmodSync(path, 0o644);
    writeConfigFileAtomic(path, { cleanup: { provider: "ollama" } });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("readExistingConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-read-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns {} when the file does not exist", () => {
    expect(readExistingConfig(join(dir, "nope.json"))).toEqual({});
  });

  test("returns {} when the file exists but is empty", () => {
    const path = join(dir, "empty.json");
    writeFileSync(path, "");
    expect(readExistingConfig(path)).toEqual({});
  });

  test("parses a valid file and returns its contents", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ cleanup: { provider: "ollama", system_prompt: "X" } }),
    );
    expect(readExistingConfig(path)).toEqual({
      cleanup: { provider: "ollama", system_prompt: "X" },
    });
  });

  test("throws on malformed JSON (fail-loud, matches loadConfig posture)", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    expect(() => readExistingConfig(path)).toThrow(/Failed to parse config/);
  });
});

describe("mergeIntoFileShape", () => {
  test("empty patch on empty existing → empty merged", () => {
    expect(mergeIntoFileShape({}, {})).toEqual({});
  });

  test("patch with no cleanup keys carries existing cleanup forward verbatim", () => {
    const existing = {
      cleanup: { provider: "ollama", system_prompt: "OLD", default: true },
    };
    expect(mergeIntoFileShape(existing, { transcribe: { provider: "whisper" } })).toEqual({
      transcribe: { provider: "whisper" },
      cleanup: { provider: "ollama", system_prompt: "OLD", default: true },
    });
  });

  test("patch with system_prompt: null DROPS system_prompt from merged result", () => {
    const existing = {
      cleanup: { provider: "ollama", system_prompt: "OLD PROMPT", default: true },
    };
    const merged = mergeIntoFileShape(existing, {
      cleanup: { system_prompt: null },
    });
    expect(merged).toEqual({
      cleanup: { provider: "ollama", default: true },
    });
    expect(merged.cleanup).not.toHaveProperty("system_prompt");
  });

  test("patch with context_template: null DROPS context_template from merged result", () => {
    const existing = {
      cleanup: { provider: "ollama", context_template: "OLD {{proper_nouns}}" },
    };
    const merged = mergeIntoFileShape(existing, {
      cleanup: { context_template: null },
    });
    expect(merged).toEqual({ cleanup: { provider: "ollama" } });
    expect(merged.cleanup).not.toHaveProperty("context_template");
  });

  test("patch overwrites existing string field with new string", () => {
    const existing = { cleanup: { system_prompt: "OLD" } };
    const merged = mergeIntoFileShape(existing, {
      cleanup: { system_prompt: "NEW" },
    });
    expect(merged.cleanup?.system_prompt).toBe("NEW");
  });

  test("patch boolean field replaces existing boolean", () => {
    const existing = { cleanup: { default: true } };
    const merged = mergeIntoFileShape(existing, { cleanup: { default: false } });
    expect(merged.cleanup?.default).toBe(false);
  });

  test("absent patch boolean leaves existing boolean alone (not falsey-coerced)", () => {
    const existing = { cleanup: { default: false } };
    const merged = mergeIntoFileShape(existing, { cleanup: { provider: "ollama" } });
    expect(merged.cleanup?.default).toBe(false);
  });

  test("operator-set `model` survives a patch that does not mention it", () => {
    // Wire shape doesn't expose `model` today, so a SPA-driven patch never
    // sets it. Don't strip the operator's hand-set value.
    const existing = { cleanup: { provider: "ollama", model: "llama3.2:3b" } };
    const merged = mergeIntoFileShape(existing, {
      cleanup: { system_prompt: "X" },
    });
    expect(merged.cleanup?.model).toBe("llama3.2:3b");
  });

  test("clearing one prompt does not touch the other prompt", () => {
    const existing = {
      cleanup: { system_prompt: "KEEP_SYS", context_template: "KEEP_TPL" },
    };
    const merged = mergeIntoFileShape(existing, {
      cleanup: { system_prompt: null },
    });
    expect(merged.cleanup).toEqual({ context_template: "KEEP_TPL" });
  });

  test("cleanup block disappears entirely when every key is cleared or absent", () => {
    const existing = { cleanup: { system_prompt: "OLD" } };
    const merged = mergeIntoFileShape(existing, {
      cleanup: { system_prompt: null },
    });
    expect(merged.cleanup).toBeUndefined();
  });
});

describe("write-through null-clear (regression — scribe#45 must-fix 1)", () => {
  // These tests pin the load-bearing UX behavior: the user clears a textarea
  // in the admin form, hits Save, and expects the field to actually be
  // cleared on disk. Before the read-modify-write fix, `toFileShape` dropped
  // null-valued keys before write, so the disk file still carried the OLD
  // value — and the SPA's 200 banner said "Saved." End-to-end test through
  // toFileShape → mergeIntoFileShape → writeConfigFileAtomic → readback.
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-clear-"));
    path = join(dir, "scribe", "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFull(): void {
    writeConfigFileAtomic(path, {
      transcribe: { provider: "whisper" },
      cleanup: {
        provider: "ollama",
        system_prompt: "OLD PROMPT",
        context_template: "OLD TEMPLATE",
        default: true,
      },
    });
  }

  function applyWirePatch(wire: Parameters<typeof toFileShape>[0]): void {
    const existing = readExistingConfig(path);
    const patch = toFileShape(wire);
    const merged = mergeIntoFileShape(existing, patch);
    writeConfigFileAtomic(path, merged);
  }

  test("PUT with cleanupSystemPrompt: null clears existing prompt on disk", () => {
    writeFull();
    applyWirePatch({ cleanupSystemPrompt: null });
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.cleanup.system_prompt).toBeUndefined();
    // Other cleanup fields survive.
    expect(onDisk.cleanup.context_template).toBe("OLD TEMPLATE");
    expect(onDisk.cleanup.provider).toBe("ollama");
    expect(onDisk.cleanup.default).toBe(true);
  });

  test("PUT with cleanupContextTemplate: null clears existing template on disk", () => {
    writeFull();
    applyWirePatch({ cleanupContextTemplate: null });
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.cleanup.context_template).toBeUndefined();
    expect(onDisk.cleanup.system_prompt).toBe("OLD PROMPT");
  });

  test("PUT with both null clears both — provider survives", () => {
    writeFull();
    applyWirePatch({ cleanupSystemPrompt: null, cleanupContextTemplate: null });
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.cleanup.system_prompt).toBeUndefined();
    expect(onDisk.cleanup.context_template).toBeUndefined();
    expect(onDisk.cleanup.provider).toBe("ollama");
  });

  test("PUT that replaces the prompt overwrites cleanly (not a null-clear path)", () => {
    writeFull();
    applyWirePatch({ cleanupSystemPrompt: "NEW PROMPT" });
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.cleanup.system_prompt).toBe("NEW PROMPT");
  });
});
