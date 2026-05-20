/**
 * PUT /.parachute/config support — JSON-Schema validation, atomic write of
 * `~/.parachute/scribe/config.json`, and a small restart-required diff.
 *
 * Wire shape:
 *   - PUT body is the camelCase shape that GET /.parachute/config returns
 *     (`transcribeProvider`, `cleanupProvider`, `cleanupDefault`,
 *     `cleanupSystemPrompt`, `cleanupContextTemplate`, optional `port`).
 *     It mirrors the JSON Schema served at `/.parachute/config/schema`.
 *   - File shape on disk is the nested `ScribeConfig` (`transcribe.provider`,
 *     `cleanup.provider`, …) — `toFileShape` translates wire→file before write.
 *
 * Validation: a tiny purpose-built draft-07 validator that handles the schema
 * shapes we actually emit (`type: object` + `properties` of `string/integer/
 * boolean` with optional `enum` + `minimum`/`maximum`). No external dep — the
 * schema is internal and stable, and pulling ajv in would 10x the deps for one
 * endpoint.
 *
 * Restart-required diff: provider changes (`transcribeProvider`,
 * `cleanupProvider`) and `port` require a restart because they're resolved
 * once at boot in `startServer()`. `cleanupDefault`, `cleanupSystemPrompt`,
 * and `cleanupContextTemplate` are read dynamically per-request in
 * `handleTranscription`, so they take effect on the next call.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildConfigSchema } from "./config-schema.ts";
import type { ResolvedConfig } from "./config-schema.ts";
import type { ScribeConfig } from "./config.ts";

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
 * Wire-shape config. Matches the JSON Schema + GET /.parachute/config output.
 * Fields are optional on PUT — caller can post a partial object and unspecified
 * fields keep the resolved-default for that knob. (Explicit `null` for the
 * two string-or-null fields clears them; absent = keep current.)
 */
export type ConfigWire = {
  transcribeProvider?: string;
  cleanupProvider?: string;
  cleanupDefault?: boolean;
  cleanupSystemPrompt?: string | null;
  cleanupContextTemplate?: string | null;
  port?: number;
};

/**
 * Tiny draft-07 validator covering only the shapes the scribe schema emits.
 * Returns a flat list of errors so the wire response can surface them inline.
 */
export function validateConfig(input: unknown): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: "", message: "body must be a JSON object" }],
    };
  }
  const schema = buildConfigSchema();
  const props = schema.properties as Record<string, SchemaProperty>;
  const errors: ValidationError[] = [];
  const out: ConfigWire = {};

  const obj = input as Record<string, unknown>;
  // Reject unknown top-level keys so a typo on the wire fails loud rather
  // than silently no-ops. (additionalProperties:false equivalent.)
  for (const key of Object.keys(obj)) {
    if (!(key in props)) {
      errors.push({ path: key, message: `unknown field "${key}"` });
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in obj)) continue;
    const value = obj[key];
    const fieldErrors = validateField(key, value, spec);
    if (fieldErrors.length > 0) {
      errors.push(...fieldErrors);
      continue;
    }
    (out as Record<string, unknown>)[key] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

type SchemaProperty = {
  type: "string" | "integer" | "boolean";
  enum?: string[];
  minimum?: number;
  maximum?: number;
};

function validateField(
  path: string,
  value: unknown,
  spec: SchemaProperty,
): ValidationError[] {
  // `cleanupSystemPrompt` and `cleanupContextTemplate` accept explicit `null`
  // as "clear this field" — that's the natural shape for an optional string
  // toggled off in the form. The schema itself only declares `type: string`,
  // but null-as-clear is the inherited contract from the resolved-config
  // type (which is `string | null`), so we honor it here.
  if (value === null && (path === "cleanupSystemPrompt" || path === "cleanupContextTemplate")) {
    return [];
  }
  if (spec.type === "string") {
    if (typeof value !== "string") {
      return [{ path, message: `${path} must be a string` }];
    }
    if (spec.enum && !spec.enum.includes(value)) {
      return [
        {
          path,
          message: `${path} must be one of: ${spec.enum.join(", ")}`,
        },
      ];
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
    if (typeof value !== "boolean") {
      return [{ path, message: `${path} must be a boolean` }];
    }
    return [];
  }
  return [];
}

/**
 * Translate wire-shape (camelCase, flat) → file-shape (nested `transcribe.*`,
 * `cleanup.*`). The file shape stays the source of truth on disk; the wire
 * shape mirrors the resolved-config / schema surface.
 *
 * `port` is intentionally NOT written into the file: scribe's port resolution
 * (port-resolve.ts) reads from `services.json` and env, not config.json. The
 * schema lists it for visibility / documentation in the SPA but writing it
 * here would just create a dead-letter knob.
 */
export function toFileShape(wire: ConfigWire): ScribeConfig {
  const file: ScribeConfig = {};
  if (wire.transcribeProvider !== undefined) {
    file.transcribe = { provider: wire.transcribeProvider };
  }
  const cleanup: NonNullable<ScribeConfig["cleanup"]> = {};
  let cleanupTouched = false;
  if (wire.cleanupProvider !== undefined) {
    cleanup.provider = wire.cleanupProvider;
    cleanupTouched = true;
  }
  if (wire.cleanupDefault !== undefined) {
    cleanup.default = wire.cleanupDefault;
    cleanupTouched = true;
  }
  if (wire.cleanupSystemPrompt !== undefined && wire.cleanupSystemPrompt !== null) {
    cleanup.system_prompt = wire.cleanupSystemPrompt;
    cleanupTouched = true;
  }
  if (wire.cleanupContextTemplate !== undefined && wire.cleanupContextTemplate !== null) {
    cleanup.context_template = wire.cleanupContextTemplate;
    cleanupTouched = true;
  }
  if (cleanupTouched) file.cleanup = cleanup;
  return file;
}

/**
 * Diff resolved-current against incoming wire-shape; return the fields whose
 * change requires a restart to take effect.
 *
 * Only fields actually present in the incoming wire are considered — a
 * partial PUT that omits `transcribeProvider` can't be a transcribe-provider
 * change, even if the resolved value differs (the absent field is "no change
 * requested").
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
 * same directory, then renames — POSIX rename is atomic on the same fs, so a
 * crash mid-write leaves either the old file intact or the new file complete,
 * never a half-written file. Same pattern as `services-manifest.ts`.
 */
export function writeConfigFileAtomic(path: string, config: ScribeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
}
