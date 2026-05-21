/**
 * Per-request provider config resolution.
 *
 * Provider modules (transcribe/groq.ts, cleanup/anthropic.ts, …) used to read
 * `process.env.X_API_KEY` directly at call time. After site#52 Part 1 lands,
 * the SPA writes per-provider apiKey + model values into
 * `~/.parachute/scribe/config.json` and the operator expects those to take
 * effect on the next request without a restart.
 *
 * The shape this module enforces:
 *
 *   - **Per-request reads.** Each provider call invokes
 *     `getTranscribeProviderConfig(name)` / `getCleanupProviderConfig(name)`
 *     which re-resolves from `loadConfig()` + env + defaults. No module-scope
 *     caching — the operator clicks Save in the SPA, and the next transcribe
 *     request uses the new key/model.
 *
 *   - **Precedence (config-file > env > default).** Matches hub#298's
 *     `getHubOrigin` pattern and the existing scribe ladder documented in
 *     `parachute-scribe/CLAUDE.md` (`--flag` > `config.json` > env > default —
 *     this module covers the bottom three; the CLI handles flag overrides
 *     separately).
 *
 *   - **No PARACHUTE_HOME stickiness across reads.** `loadConfig()` already
 *     consults `process.env.PARACHUTE_HOME` per call, so this works in test
 *     sandboxes that swap the env between cases.
 *
 * The resolved shape per provider is `{ apiKey?, model?, url? }`. Providers
 * that don't need a key (local transcribers, claude-code) just ignore the
 * unset field — the provider function is responsible for "I need an apiKey
 * to function" error surfacing, not this module.
 */

import { loadConfig, type ScribeConfig } from "./config.ts";

/** Per-provider resolved config the provider modules consume. */
export type ProviderConfig = {
  /** API key, when the provider needs one. Undefined when not configured. */
  apiKey?: string;
  /** Model name, when the provider has a knob for it. */
  model?: string;
  /** Endpoint URL, when the provider has a self-hostable target (ollama, custom). */
  url?: string;
};

/**
 * Built-in defaults per provider — used when neither config.json nor env sets
 * a value. Mirrors the design doc's "Per-provider field shapes" table.
 */
const TRANSCRIBE_DEFAULTS: Record<string, ProviderConfig> = {
  groq: { model: "whisper-large-v3" },
  openai: { model: "whisper-1" },
};

const CLEANUP_DEFAULTS: Record<string, ProviderConfig> = {
  anthropic: { model: "claude-3-5-haiku-20241022" },
  ollama: { url: "http://localhost:11434", model: "gemma4:e4b" },
  openai: { model: "gpt-4o-mini" },
  gemini: { model: "gemini-2.0-flash" },
  groq: { model: "llama-3.1-8b-instant" },
  custom: { url: "http://localhost:8080/v1", model: "default" },
};

/**
 * Per-provider env-var fallback names — read when config.json has no value
 * for that field. Matches the legacy env-var names from `.env.example`
 * verbatim so existing operators don't have to migrate to keep working.
 */
const TRANSCRIBE_ENV: Record<string, { apiKey?: string; model?: string }> = {
  groq: { apiKey: "GROQ_API_KEY", model: "GROQ_MODEL" },
  openai: { apiKey: "OPENAI_API_KEY", model: "OPENAI_MODEL" },
  whisper: { model: "WHISPER_MODEL" },
  "onnx-asr": { model: "ONNX_ASR_MODEL" },
};

const CLEANUP_ENV: Record<string, { apiKey?: string; model?: string; url?: string }> = {
  anthropic: { apiKey: "ANTHROPIC_API_KEY", model: "CLAUDE_MODEL" },
  ollama: { url: "OLLAMA_URL", model: "OLLAMA_MODEL" },
  openai: { apiKey: "OPENAI_API_KEY", model: "CLEANUP_MODEL" },
  gemini: { apiKey: "GEMINI_API_KEY", model: "CLEANUP_MODEL" },
  groq: { apiKey: "GROQ_API_KEY", model: "CLEANUP_MODEL" },
  custom: { apiKey: "CLEANUP_API_KEY", model: "CLEANUP_MODEL", url: "CLEANUP_URL" },
};

/**
 * Merge config.json sub-block + env + defaults into a resolved ProviderConfig.
 * Precedence on each field: config > env > default. Empty-string values from
 * config are treated as absent (so a writeOnly apiKey that the SPA never set
 * still falls through to env / default).
 */
function resolveFromBlocks(
  configBlock: Record<string, unknown> | undefined,
  envMap: { apiKey?: string; model?: string; url?: string } | undefined,
  defaults: ProviderConfig | undefined,
  env: Record<string, string | undefined>,
): ProviderConfig {
  const out: ProviderConfig = {};
  const pickConfig = (k: string): string | undefined => {
    const v = configBlock?.[k];
    if (typeof v === "string" && v.length > 0) return v;
    return undefined;
  };
  const pickEnv = (name: string | undefined): string | undefined => {
    if (!name) return undefined;
    const v = env[name];
    if (typeof v === "string" && v.length > 0) return v;
    return undefined;
  };

  const apiKey = pickConfig("apiKey") ?? pickEnv(envMap?.apiKey) ?? defaults?.apiKey;
  if (apiKey !== undefined) out.apiKey = apiKey;
  const model = pickConfig("model") ?? pickEnv(envMap?.model) ?? defaults?.model;
  if (model !== undefined) out.model = model;
  const url = pickConfig("url") ?? pickEnv(envMap?.url) ?? defaults?.url;
  if (url !== undefined) out.url = url;
  return out;
}

/**
 * Resolve a transcribe provider's runtime config (apiKey/model/url).
 * Reads `loadConfig()` per call — no module-scope caching, so a PUT-driven
 * config write takes effect immediately on the next request.
 */
export async function getTranscribeProviderConfig(
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderConfig> {
  const cfg = await loadConfig();
  return resolveFromBlocks(
    cfg.transcribeProviders?.[name],
    TRANSCRIBE_ENV[name],
    TRANSCRIBE_DEFAULTS[name],
    env,
  );
}

/**
 * Resolve a cleanup provider's runtime config (apiKey/model/url).
 * See `getTranscribeProviderConfig` for the precedence rationale.
 */
export async function getCleanupProviderConfig(
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderConfig> {
  const cfg = await loadConfig();
  return resolveFromBlocks(
    cfg.cleanupProviders?.[name],
    CLEANUP_ENV[name],
    CLEANUP_DEFAULTS[name],
    env,
  );
}

/**
 * Synchronous, in-memory variant — same shape but takes a pre-loaded
 * `ScribeConfig` rather than calling `loadConfig()`. Used in the HTTP GET
 * handler where the config is read once per request as part of the
 * `.parachute/config` response.
 */
export function resolveTranscribeProviderConfig(
  name: string,
  cfg: ScribeConfig,
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  return resolveFromBlocks(
    cfg.transcribeProviders?.[name],
    TRANSCRIBE_ENV[name],
    TRANSCRIBE_DEFAULTS[name],
    env,
  );
}

export function resolveCleanupProviderConfig(
  name: string,
  cfg: ScribeConfig,
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  return resolveFromBlocks(
    cfg.cleanupProviders?.[name],
    CLEANUP_ENV[name],
    CLEANUP_DEFAULTS[name],
    env,
  );
}

/** Exposed for tests + the schema builder so test fixtures and schema defaults agree. */
export const TRANSCRIBE_PROVIDER_DEFAULTS = TRANSCRIBE_DEFAULTS;
export const CLEANUP_PROVIDER_DEFAULTS = CLEANUP_DEFAULTS;
