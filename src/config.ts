import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Per-provider config block written into the file. `transcribeProviders.<name>`
 * and `cleanupProviders.<name>` carry the per-provider apiKey/model/url the
 * SPA writes via PUT (`writeOnly` apiKeys land here too — file mode 0o600 is
 * the owner-only protection per `writeConfigFileAtomic`).
 */
export type ProviderBlock = {
  apiKey?: string;
  model?: string;
  url?: string;
};

export type ScribeConfig = {
  transcribe?: {
    provider?: string;
  };
  cleanup?: {
    provider?: string;
    model?: string;
    default?: boolean;
    enabled?: boolean;
    /**
     * Optional full override of the built-in cleanup system prompt. When set,
     * the caller owns the entire instruction to the cleanup LLM. The
     * proper-nouns block (from the request `context` part) is still appended
     * per context_template.
     */
    system_prompt?: string;
    /**
     * Optional template for how the proper-nouns block is appended after
     * the system prompt. Supports one variable: {{proper_nouns}}. When unset,
     * scribe uses its default rule (append `\n\n{proper_nouns}` only if the
     * block is non-empty). When set, the template is always rendered — the
     * caller's template owns its own separators.
     */
    context_template?: string;
  };
  /**
   * Per-provider transcription config (site#52 Part 1). New in 0.4.4.
   * Keys are provider short-names (e.g. `groq`, `openai`); each block holds
   * the `apiKey` + `model` knobs the SPA writes through `PUT /.parachute/config`.
   */
  transcribeProviders?: Record<string, ProviderBlock>;
  /**
   * Per-provider cleanup config (site#52 Part 1). New in 0.4.4. Keys match
   * the cleanup provider registry — `anthropic`, `claude-code`, `ollama`,
   * `openai`, `gemini`, `groq`, `custom`. Local-only providers
   * (`claude-code`) have no apiKey block; their fields are read-only.
   */
  cleanupProviders?: Record<string, ProviderBlock>;
};

function parachuteHome(): string {
  return process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
}

export function resolveDefaultConfigPath(): string {
  return join(parachuteHome(), "scribe", "config.json");
}

function legacyConfigPath(): string {
  return join(parachuteHome(), "scribe.config.json");
}

function migrateLegacyConfig(canonical: string): void {
  const legacy = legacyConfigPath();
  if (!existsSync(legacy) || existsSync(canonical)) return;
  mkdirSync(dirname(canonical), { recursive: true });
  renameSync(legacy, canonical);
  console.log(`scribe: migrated config ${legacy} → ${canonical}`);
}

/**
 * One-shot rewrite of legacy `cleanupProvider: "claude"` → `"anthropic"`.
 *
 * Site#52 Part 1 renamed the Anthropic-API cleanup provider from `claude`
 * (the model family) to `anthropic` (the credential type), to disambiguate
 * from `claude-code` (subscription-funded Claude via the Claude Code CLI).
 *
 * Returns the (possibly rewritten) config and a `migrated` flag so the caller
 * can persist the new shape — `loadConfig` writes it back to disk once,
 * after which the migration is a no-op.
 */
export function migrateClaudeToAnthropic(
  cfg: ScribeConfig,
): { config: ScribeConfig; migrated: boolean } {
  if (cfg.cleanup?.provider !== "claude") return { config: cfg, migrated: false };
  const next: ScribeConfig = {
    ...cfg,
    cleanup: { ...cfg.cleanup, provider: "anthropic" },
  };
  return { config: next, migrated: true };
}

async function readJsonConfig(path: string): Promise<ScribeConfig | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config ${path}: ${message}`);
  }
  warnIfStaleVaultBlock(parsed, path);
  return parsed as ScribeConfig;
}

function warnIfStaleVaultBlock(parsed: unknown, path: string): void {
  if (!parsed || typeof parsed !== "object") return;
  if (!("vault" in parsed)) return;
  console.warn(
    `[scribe] "vault" block in ${path} ignored — scribe no longer calls back to vault; callers push context in the request payload now`,
  );
}

/**
 * Load + return the on-disk scribe config. Applies the
 * `cleanupProvider: claude` → `anthropic` rewrite (site#52 Part 1) before
 * returning. The rewrite is also persisted to disk on the first load that
 * triggers it, so subsequent loads are clean and the operator's file matches
 * the canonical shape.
 */
export async function loadConfig(path?: string): Promise<ScribeConfig> {
  const explicit = path ?? process.env.SCRIBE_CONFIG;
  if (explicit) {
    const raw = (await readJsonConfig(explicit)) ?? {};
    const { config, migrated } = migrateClaudeToAnthropic(raw);
    if (migrated) await persistMigration(explicit, config);
    return config;
  }

  const canonical = resolveDefaultConfigPath();
  migrateLegacyConfig(canonical);

  for (const candidate of [canonical, "./scribe.config.json"]) {
    const result = await readJsonConfig(candidate);
    if (result !== undefined) {
      const { config, migrated } = migrateClaudeToAnthropic(result);
      if (migrated) await persistMigration(candidate, config);
      return config;
    }
  }

  return {};
}

/**
 * Write back the post-migration shape so the rewrite is a one-time event.
 * Imported lazily so this module stays cycle-free with `config-write.ts`
 * (which imports `ScribeConfig` from here).
 */
async function persistMigration(path: string, config: ScribeConfig): Promise<void> {
  console.log(
    `[scribe] migrating config ${path}: cleanupProvider "claude" → "anthropic" ` +
      `(site#52 cleanup provider rename — Anthropic API path is now "anthropic"; "claude-code" remains the CLI/subscription path)`,
  );
  try {
    const { writeConfigFileAtomic } = await import("./config-write.ts");
    writeConfigFileAtomic(path, config);
  } catch (err) {
    // Migration is best-effort — if disk is read-only, the in-memory rewrite
    // still flows through this boot. Surface the error so the operator can
    // fix it, but don't crash the load.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[scribe] failed to persist cleanup-provider migration to ${path}: ${msg}`);
  }
}
