/**
 * PUT /.parachute/config support — schema validation, read-modify-write
 * merge into `~/.parachute/scribe/config.json`, and a small restart-required
 * diff.
 *
 * Wire shape (camelCase, flat-at-top-level + per-provider nesting under
 * `transcribeProviders` / `cleanupProviders`):
 *
 *     {
 *       transcribeProvider?: string,
 *       transcribeProviders?: { groq?: {apiKey?, model?}, openai?: {...}, ... },
 *       cleanupProvider?: string,
 *       cleanupDefault?: boolean,
 *       cleanupProviders?: { anthropic?: {apiKey?, model?}, ollama?: {url?, model?}, ... },
 *       cleanupSystemPrompt?: string | null,
 *       cleanupContextTemplate?: string | null,
 *       port?: integer
 *     }
 *
 * File shape on disk mirrors the wire shape one-to-one (with `transcribe.*`
 * / `cleanup.*` legacy blocks preserved for back-compat with pre-0.4.4
 * configs). `toFileShape` translates wire→file before write.
 *
 * Site#52 Part 1 (2026-05-21) added:
 *
 *   - `transcribeProviders` / `cleanupProviders` per-provider blocks.
 *   - `cleanupDefault` (replaces the per-cleanup-block `cleanupDefault` flag
 *     while keeping the file-shape `cleanup.default` for back-compat).
 *   - `writeOnly` apiKey omission in GET responses (handled in
 *     `buildPublicResolvedConfig`).
 *   - **Omit-to-keep PUT semantics for writeOnly credential fields.** Sending
 *     an empty string or omitting an `apiKey` field on PUT preserves the
 *     stored value. Sending a non-empty string replaces it. Explicit
 *     clearing uses `POST /admin/clear-credential/<kind>/<name>` (see
 *     `clearProviderCredential` below) — the only way to remove a stored
 *     writeOnly value short of hand-editing `config.json`.
 *
 * Pre-0.4.4 wire fields stay supported. `cleanupDefault` (old name) is
 * still accepted on PUT and translated to `cleanupDefault` so existing
 * automation doesn't break mid-flight.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildConfigSchema } from "./config-schema.ts";
import type { ResolvedConfig, ProviderConfigPublic } from "./config-schema.ts";
import type { ProviderBlock, ScribeConfig } from "./config.ts";
import {
  CLEANUP_PROVIDER_DEFAULTS,
  TRANSCRIBE_PROVIDER_DEFAULTS,
  resolveCleanupProviderConfig,
  resolveTranscribeProviderConfig,
} from "./provider-config.ts";
import { readSetupTokenStatus } from "./claude-token-status.ts";
import { cleaners, transcribers } from "./providers.ts";

/**
 * Fields whose change forces a restart. Resolved once at boot in
 * `startServer()`; the running handler closes over the resolved values, so a
 * mid-life write to `config.json` doesn't repoint the provider in-process.
 */
export const RESTART_REQUIRED_FIELDS = [
  "transcribeProvider",
  "cleanupProvider",
  "port",
] as const;

export type RestartRequiredField = (typeof RESTART_REQUIRED_FIELDS)[number];

export type ValidationError = {
  path: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; value: ConfigWire }
  | { ok: false; errors: ValidationError[] };

/**
 * Wire-shape config — partial PUT. Per-provider blocks are themselves partial:
 * a PUT can land just `transcribeProviders.groq.apiKey` without touching
 * model or other providers.
 */
export type ConfigWire = {
  transcribeProvider?: string;
  transcribeProviders?: Record<string, ProviderBlockWire>;
  cleanupProvider?: string;
  cleanupDefault?: boolean;
  cleanupProviders?: Record<string, ProviderBlockWire>;
  cleanupSystemPrompt?: string | null;
  cleanupContextTemplate?: string | null;
  port?: number;
};

export type ProviderBlockWire = {
  apiKey?: string;
  model?: string;
  url?: string;
};

const VALID_TRANSCRIBE_PROVIDER_NAMES = new Set(Object.keys(transcribers));
const VALID_CLEANUP_PROVIDER_NAMES = new Set(Object.keys(cleaners));

/**
 * Validate the incoming wire body against the schema. Top-level
 * `additionalProperties: false` is enforced; per-provider blocks check the
 * shape of their three known fields (apiKey/model/url) + reject unknown
 * provider names in the per-provider map.
 */
export function validateConfig(input: unknown): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: "", message: "body must be a JSON object" }],
    };
  }
  const schema = buildConfigSchema();
  const props = schema.properties as Record<string, { type?: string; enum?: string[]; minimum?: number; maximum?: number }>;
  const errors: ValidationError[] = [];
  const out: ConfigWire = {};
  const obj = input as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!(key in props)) {
      errors.push({ path: key, message: `unknown field "${key}"` });
    }
  }

  // Flat fields (string / integer / boolean) — same shape as pre-0.4.4 plus
  // `cleanupDefault`.
  for (const key of [
    "transcribeProvider",
    "cleanupProvider",
    "cleanupDefault",
    "cleanupSystemPrompt",
    "cleanupContextTemplate",
    "port",
  ]) {
    if (!(key in obj)) continue;
    const value = obj[key];
    const spec = props[key];
    if (!spec) continue;
    const fieldErrors = validateFlatField(key, value, spec);
    if (fieldErrors.length > 0) {
      errors.push(...fieldErrors);
      continue;
    }
    (out as Record<string, unknown>)[key] = value;
  }

  // Per-provider blocks — validate each provider name + the keys inside.
  if ("transcribeProviders" in obj) {
    const parsed = validateProviderMap(
      "transcribeProviders",
      obj.transcribeProviders,
      VALID_TRANSCRIBE_PROVIDER_NAMES,
      errors,
    );
    if (parsed) out.transcribeProviders = parsed;
  }
  if ("cleanupProviders" in obj) {
    const parsed = validateProviderMap(
      "cleanupProviders",
      obj.cleanupProviders,
      VALID_CLEANUP_PROVIDER_NAMES,
      errors,
    );
    if (parsed) out.cleanupProviders = parsed;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

function validateFlatField(
  path: string,
  value: unknown,
  spec: { type?: string; enum?: string[]; minimum?: number; maximum?: number },
): ValidationError[] {
  if (value === null && (path === "cleanupSystemPrompt" || path === "cleanupContextTemplate")) {
    return [];
  }
  if (spec.type === "string") {
    if (typeof value !== "string") return [{ path, message: `${path} must be a string` }];
    if (spec.enum && !spec.enum.includes(value)) {
      return [{ path, message: `${path} must be one of: ${spec.enum.join(", ")}` }];
    }
    return [];
  }
  if (spec.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return [{ path, message: `${path} must be an integer` }];
    }
    if (spec.minimum !== undefined && value < spec.minimum) {
      return [{ path, message: `${path} must be ≥ ${spec.minimum}` }];
    }
    if (spec.maximum !== undefined && value > spec.maximum) {
      return [{ path, message: `${path} must be ≤ ${spec.maximum}` }];
    }
    return [];
  }
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") return [{ path, message: `${path} must be a boolean` }];
    return [];
  }
  return [];
}

function validateProviderMap(
  fieldName: string,
  value: unknown,
  validNames: Set<string>,
  errors: ValidationError[],
): Record<string, ProviderBlockWire> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({ path: fieldName, message: `${fieldName} must be a JSON object` });
    return undefined;
  }
  const result: Record<string, ProviderBlockWire> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!validNames.has(name)) {
      errors.push({ path: `${fieldName}.${name}`, message: `unknown provider "${name}"` });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({
        path: `${fieldName}.${name}`,
        message: `${fieldName}.${name} must be a JSON object`,
      });
      continue;
    }
    const block: ProviderBlockWire = {};
    const rawBlock = raw as Record<string, unknown>;
    for (const [k, v] of Object.entries(rawBlock)) {
      // setupTokenStatus is readOnly — silently ignore on PUT (the SPA may
      // echo the GET shape on save; we don't error on benign extra fields
      // here since the alternative is fragile round-trips).
      if (k === "setupTokenStatus" || k === "apiKeyConfigured") continue;
      if (k !== "apiKey" && k !== "model" && k !== "url") {
        errors.push({
          path: `${fieldName}.${name}.${k}`,
          message: `unknown field "${k}" in ${fieldName}.${name}`,
        });
        continue;
      }
      if (typeof v !== "string") {
        errors.push({
          path: `${fieldName}.${name}.${k}`,
          message: `${fieldName}.${name}.${k} must be a string`,
        });
        continue;
      }
      block[k] = v;
    }
    result[name] = block;
  }
  return result;
}

/**
 * Patch shape produced by `toFileShape` — same nested structure as
 * `ScribeConfig`. Pre-0.4.4 `cleanup` block fields stay where they were on
 * disk (for back-compat reading); new per-provider blocks land under
 * `transcribeProviders` / `cleanupProviders`.
 */
export type CleanupPatch = {
  provider?: string;
  default?: boolean;
  system_prompt?: string | null;
  context_template?: string | null;
};

export type FileShapePatch = {
  transcribe?: { provider?: string };
  cleanup?: CleanupPatch;
  transcribeProviders?: Record<string, ProviderBlockWire>;
  cleanupProviders?: Record<string, ProviderBlockWire>;
};

/**
 * Translate wire-shape → file-shape patch.
 *
 * Pre-0.4.4 fields go to the existing `transcribe.*` / `cleanup.*` blocks
 * (so on-disk shape stays roughly the same — readers tolerant). New
 * per-provider fields go to `transcribeProviders.*` / `cleanupProviders.*`.
 * `cleanupDefault` is aliased to `cleanup.default` on disk (back-compat).
 *
 * `port` is intentionally NOT written to disk: port resolution reads
 * services.json + SCRIBE_PORT env, not config.json.
 */
export function toFileShape(wire: ConfigWire): FileShapePatch {
  const file: FileShapePatch = {};

  if (wire.transcribeProvider !== undefined) {
    file.transcribe = { provider: wire.transcribeProvider };
  }

  const cleanup: CleanupPatch = {};
  let cleanupTouched = false;
  if (wire.cleanupProvider !== undefined) {
    cleanup.provider = wire.cleanupProvider;
    cleanupTouched = true;
  }
  if (wire.cleanupDefault !== undefined) {
    cleanup.default = wire.cleanupDefault;
    cleanupTouched = true;
  }
  if (wire.cleanupSystemPrompt !== undefined) {
    cleanup.system_prompt = wire.cleanupSystemPrompt;
    cleanupTouched = true;
  }
  if (wire.cleanupContextTemplate !== undefined) {
    cleanup.context_template = wire.cleanupContextTemplate;
    cleanupTouched = true;
  }
  if (cleanupTouched) file.cleanup = cleanup;

  if (wire.transcribeProviders !== undefined) {
    file.transcribeProviders = wire.transcribeProviders;
  }
  if (wire.cleanupProviders !== undefined) {
    file.cleanupProviders = wire.cleanupProviders;
  }

  return file;
}

/**
 * Read the existing config file (if any) and merge the patch produced by
 * `toFileShape`. Honors:
 *
 *   - `null` for the two clearable string fields → drop the key
 *   - Empty string OR absent on a writeOnly `apiKey` field → carry forward
 *     the existing stored value (omit-to-keep semantics)
 *   - Non-empty `apiKey` → overwrite
 *   - Absent provider block → leave existing blocks alone
 *   - Present provider block with partial keys → field-level merge inside
 */
export function mergeIntoFileShape(
  existing: ScribeConfig,
  patch: FileShapePatch,
): ScribeConfig {
  const merged: ScribeConfig = {};

  if (patch.transcribe !== undefined) {
    if (patch.transcribe.provider !== undefined) {
      merged.transcribe = { provider: patch.transcribe.provider };
    }
  } else if (existing.transcribe !== undefined) {
    merged.transcribe = { ...existing.transcribe };
  }

  const existingCleanup = existing.cleanup ?? {};
  const patchCleanup = patch.cleanup ?? {};
  const cleanup: NonNullable<ScribeConfig["cleanup"]> = {};
  if (patchCleanup.provider !== undefined) cleanup.provider = patchCleanup.provider;
  else if (existingCleanup.provider !== undefined) cleanup.provider = existingCleanup.provider;

  if (patchCleanup.default !== undefined) cleanup.default = patchCleanup.default;
  else if (existingCleanup.default !== undefined) cleanup.default = existingCleanup.default;
  else if (existingCleanup.enabled !== undefined) cleanup.default = existingCleanup.enabled;

  if (patchCleanup.system_prompt === null) {
    // Drop.
  } else if (patchCleanup.system_prompt !== undefined) {
    cleanup.system_prompt = patchCleanup.system_prompt;
  } else if (existingCleanup.system_prompt !== undefined) {
    cleanup.system_prompt = existingCleanup.system_prompt;
  }

  if (patchCleanup.context_template === null) {
    // Drop.
  } else if (patchCleanup.context_template !== undefined) {
    cleanup.context_template = patchCleanup.context_template;
  } else if (existingCleanup.context_template !== undefined) {
    cleanup.context_template = existingCleanup.context_template;
  }

  if (existingCleanup.model !== undefined) cleanup.model = existingCleanup.model;
  if (Object.keys(cleanup).length > 0) merged.cleanup = cleanup;

  // Per-provider blocks — merge field-by-field with omit-to-keep on apiKey.
  merged.transcribeProviders = mergeProviderMap(
    existing.transcribeProviders,
    patch.transcribeProviders,
  );
  merged.cleanupProviders = mergeProviderMap(
    existing.cleanupProviders,
    patch.cleanupProviders,
  );
  // Don't leave empty maps in the merged result — keeps the on-disk file
  // tidy when nothing's been set yet.
  if (
    merged.transcribeProviders &&
    Object.keys(merged.transcribeProviders).length === 0
  ) {
    delete merged.transcribeProviders;
  }
  if (
    merged.cleanupProviders &&
    Object.keys(merged.cleanupProviders).length === 0
  ) {
    delete merged.cleanupProviders;
  }
  return merged;
}

/**
 * Merge two per-provider maps with field-level granularity. omit-to-keep
 * for the `apiKey` writeOnly field — an empty-string or absent `apiKey` in
 * the patch preserves the stored value; only a non-empty string overwrites
 * it. `model` and `url` follow the same omit-to-keep posture for
 * consistency (sending an empty string for either is treated as "no change
 * requested" rather than "clear it").
 */
function mergeProviderMap(
  existing: Record<string, ProviderBlock> | undefined,
  patch: Record<string, ProviderBlockWire> | undefined,
): Record<string, ProviderBlock> {
  const result: Record<string, ProviderBlock> = {};
  // Start with everything in existing.
  if (existing) {
    for (const [name, block] of Object.entries(existing)) {
      result[name] = { ...block };
    }
  }
  if (!patch) return result;
  // Apply patches.
  for (const [name, block] of Object.entries(patch)) {
    const target = { ...(result[name] ?? {}) };
    for (const k of ["apiKey", "model", "url"] as const) {
      const v = block[k];
      // omit-to-keep: empty string OR missing key preserves the existing value.
      if (typeof v === "string" && v.length > 0) {
        target[k] = v;
      }
    }
    result[name] = target;
  }
  return result;
}

/**
 * Provider kinds for `POST /admin/clear-credential/<kind>/<name>`. The kind
 * routes the lookup to the right per-provider map; the name is the registry
 * key inside it (e.g. `cleanup/anthropic` → `cleanupProviders.anthropic`).
 */
export const CREDENTIAL_KINDS = ["transcribe", "cleanup"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * Currently the only clearable writeOnly field is `apiKey`. Surfacing this
 * as a tuple so future fields (e.g. claude-code `setupToken` once that flow
 * lands) can be added without reshaping callers — the response always
 * echoes `field` so the SPA knows exactly what was removed.
 */
export const CLEARABLE_FIELDS = ["apiKey"] as const;
export type ClearableField = (typeof CLEARABLE_FIELDS)[number];

export type ClearCredentialResult = {
  /** True when an existing value was actually removed; false on no-op. */
  cleared: boolean;
  /** The post-clear config, ready to atomically persist. */
  config: ScribeConfig;
};

/**
 * Validate kind/name against the allowed enums + the live provider registry.
 * Returns `null` on success or an error tuple for the route to translate
 * into a 400 response.
 */
export function validateClearCredentialTarget(
  kind: string,
  name: string,
): { ok: true; kind: CredentialKind; name: string } | { ok: false; error: string; message: string } {
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      error: "invalid_kind",
      message: `kind must be one of: ${CREDENTIAL_KINDS.join(", ")} (got "${kind}")`,
    };
  }
  const validNames = kind === "transcribe" ? VALID_TRANSCRIBE_PROVIDER_NAMES : VALID_CLEANUP_PROVIDER_NAMES;
  if (!validNames.has(name)) {
    return {
      ok: false,
      error: "unknown_provider",
      message: `unknown ${kind} provider "${name}" — known: ${Array.from(validNames).sort().join(", ")}`,
    };
  }
  return { ok: true, kind: kind as CredentialKind, name };
}

/**
 * Remove the `apiKey` field from `<kind>Providers.<name>`. Returns `cleared:
 * false` when there was no stored value to begin with — the operator's intent
 * ("ensure this credential is cleared") is satisfied either way, so the
 * endpoint returns 200 idempotently and only differs in the `cleared` flag.
 *
 * Pairs with `mergeIntoFileShape` (PUT preserves writeOnly fields when
 * omitted; this is the only way to remove them).
 */
export function clearProviderCredential(
  existing: ScribeConfig,
  kind: CredentialKind,
  name: string,
): ClearCredentialResult {
  const mapKey = kind === "transcribe" ? "transcribeProviders" : "cleanupProviders";
  const next: ScribeConfig = {
    ...existing,
    // Shallow-clone the per-provider map so we don't mutate the caller's
    // object — the in-process scribeConfig is the same reference the
    // running handler reads per-request.
    transcribeProviders: existing.transcribeProviders ? { ...existing.transcribeProviders } : undefined,
    cleanupProviders: existing.cleanupProviders ? { ...existing.cleanupProviders } : undefined,
  };
  const providerMap = next[mapKey];
  const block = providerMap?.[name];
  if (!block || block.apiKey === undefined || block.apiKey === "") {
    // No stored credential — drop the empty/undef apiKey shell if it's there
    // so the on-disk shape stays tidy, but report `cleared: false` for the
    // wire response. Don't synthesize a provider entry that wasn't already
    // there.
    if (block && "apiKey" in block) {
      const { apiKey: _drop, ...rest } = block;
      if (Object.keys(rest).length === 0 && providerMap) {
        delete providerMap[name];
      } else if (providerMap) {
        providerMap[name] = rest;
      }
    }
    return { cleared: false, config: trimEmptyProviderMaps(next) };
  }
  // Real clear — strip apiKey, keep model/url. Drop the provider entry
  // entirely if it was apiKey-only so the on-disk file doesn't accumulate
  // empty `{}` blocks per provider that was once configured.
  const { apiKey: _stripped, ...rest } = block;
  if (Object.keys(rest).length === 0 && providerMap) {
    delete providerMap[name];
  } else if (providerMap) {
    providerMap[name] = rest;
  }
  return { cleared: true, config: trimEmptyProviderMaps(next) };
}

/**
 * Drop empty per-provider maps so the on-disk file stays tidy when the last
 * configured provider in a kind gets its apiKey cleared. Mirrors the
 * housekeeping in `mergeIntoFileShape`.
 */
function trimEmptyProviderMaps(cfg: ScribeConfig): ScribeConfig {
  const out = { ...cfg };
  if (out.transcribeProviders && Object.keys(out.transcribeProviders).length === 0) {
    delete out.transcribeProviders;
  }
  if (out.cleanupProviders && Object.keys(out.cleanupProviders).length === 0) {
    delete out.cleanupProviders;
  }
  return out;
}

/**
 * Read the existing on-disk config (if any). Returns `{}` when the file is
 * missing or empty. Throws when the file is present but malformed.
 */
export function readExistingConfig(path: string): ScribeConfig {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config ${path}: ${message}`);
  }
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as ScribeConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config ${path}: ${message}`);
  }
}

/**
 * Diff resolved-current against incoming wire; list fields requiring a restart.
 */
export function detectRestartRequired(
  current: ResolvedConfig,
  incoming: ConfigWire,
): RestartRequiredField[] {
  const out: RestartRequiredField[] = [];
  if (
    incoming.transcribeProvider !== undefined &&
    incoming.transcribeProvider !== current.transcribeProvider
  ) {
    out.push("transcribeProvider");
  }
  if (
    incoming.cleanupProvider !== undefined &&
    incoming.cleanupProvider !== current.cleanupProvider
  ) {
    out.push("cleanupProvider");
  }
  if (incoming.port !== undefined && incoming.port !== current.port) {
    out.push("port");
  }
  return out;
}

/**
 * Atomic write of `~/.parachute/scribe/config.json`. Writes a tmp file in the
 * same directory, then renames — POSIX rename is atomic on the same fs. Mode
 * 0o600 (owner-only) — preempts writeOnly credentials landing world-readable
 * on shared hosts.
 */
export function writeConfigFileAtomic(path: string, config: ScribeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Build the public-facing resolved-config response for `GET /.parachute/config`.
 *
 * Per resolved Q1 (omit-to-keep semantics): every `writeOnly: true` field
 * (i.e. every `apiKey`) is OMITTED from the response. The SPA renders the
 * placeholder ("[stored — leave blank to keep]") based on a separate
 * `apiKeyConfigured: true` boolean we surface alongside the redacted block.
 * `setupTokenStatus` for `claude-code` is read from `~/.claude.json` per
 * request and embedded under `cleanupProviders["claude-code"].setupTokenStatus`.
 */
export function buildPublicResolvedConfig(args: {
  transcribeProvider: string;
  cleanupProvider: string;
  cleanupDefault: boolean;
  scribeConfig: ScribeConfig;
  port: number;
  env?: Record<string, string | undefined>;
  /** Injected for tests so they don't read the real `~/.claude.json`. */
  setupTokenStatusFn?: () => ReturnType<typeof readSetupTokenStatus>;
}): ResolvedConfig {
  const env = args.env ?? process.env;

  const transcribeProviders: Record<string, ProviderConfigPublic> = {};
  for (const name of Object.keys(TRANSCRIBE_PROVIDER_DEFAULTS).concat(
    ["parakeet-mlx", "onnx-asr", "whisper"],
  )) {
    const resolved = resolveTranscribeProviderConfig(name, args.scribeConfig, env);
    const block = redactApiKey(resolved);
    transcribeProviders[name] = block;
  }
  // Make sure every transcriber in the registry has a slot (even providers
  // with no config knobs) so the SPA can render the section.
  for (const name of Object.keys(transcribers)) {
    if (!(name in transcribeProviders)) transcribeProviders[name] = {};
  }

  const cleanupProviders: Record<string, ProviderConfigPublic> = {};
  for (const name of Object.keys(CLEANUP_PROVIDER_DEFAULTS).concat(["claude-code", "none"])) {
    const resolved = resolveCleanupProviderConfig(name, args.scribeConfig, env);
    const block = redactApiKey(resolved);
    cleanupProviders[name] = block;
  }
  for (const name of Object.keys(cleaners)) {
    if (!(name in cleanupProviders)) cleanupProviders[name] = {};
  }
  // setupTokenStatus is computed per-request (cheap, single file read).
  const status = (args.setupTokenStatusFn ?? readSetupTokenStatus)(env);
  cleanupProviders["claude-code"] = {
    ...(cleanupProviders["claude-code"] ?? {}),
    setupTokenStatus: typeof status === "string" ? status : "unknown",
  };

  return {
    transcribeProvider: args.transcribeProvider,
    transcribeProviders,
    cleanupProvider: args.cleanupProvider,
    cleanupDefault: args.cleanupDefault,
    cleanupProviders,
    cleanupSystemPrompt: args.scribeConfig.cleanup?.system_prompt ?? null,
    cleanupContextTemplate: args.scribeConfig.cleanup?.context_template ?? null,
    port: args.port,
  };
}

/**
 * Convert a `ProviderConfig` (which may carry an apiKey) into a public block
 * (which never does). When an apiKey IS configured, we surface a tiny
 * `apiKeyConfigured: true` flag so the SPA can show "[stored — leave blank
 * to keep]" instead of an empty input. The flag is the only public signal
 * that an apiKey exists — the value itself is never on the wire.
 */
function redactApiKey(resolved: {
  apiKey?: string;
  model?: string;
  url?: string;
}): ProviderConfigPublic {
  const out: ProviderConfigPublic = {};
  if (resolved.model !== undefined) out.model = resolved.model;
  if (resolved.url !== undefined) out.url = resolved.url;
  if (resolved.apiKey !== undefined && resolved.apiKey.length > 0) {
    out.apiKeyConfigured = true;
  }
  return out;
}
