/**
 * Draft-07 JSON Schema for scribe configuration.
 *
 * Site#52 Part 1 grew this schema to cover per-provider apiKey/model knobs
 * (the operator-editable surface for transcription + cleanup credentials)
 * plus the `claude-code` `setupTokenStatus` read-only signal.
 *
 * Shape decisions captured in `parachute.computer/design/2026-05-21-scribe-config-and-vault-scribe-connect.md`:
 *
 *   - **Per-provider blocks**, not `oneOf`/`if`-`then`-`else` discriminators.
 *     Multiple providers' creds are pre-populatable simultaneously; the SPA
 *     visibility logic chooses what to show based on the selected provider.
 *
 *   - **`writeOnly: true` on every apiKey field.** `GET /.parachute/config`
 *     OMITS these from the response (clean wire — no `"***"` sentinel the
 *     SPA has to special-case). The SPA renders writeOnly fields as
 *     password inputs with a "leave blank to keep" placeholder.
 *
 *   - **`readOnly: true` on `setupTokenStatus`.** Operator can't PUT a
 *     status; it's a read-from-`~/.claude.json` reflection. The
 *     `POST /admin/refresh-claude-token-status` action re-reads it.
 *
 *   - **`additionalProperties: false`** on the top level (matches existing
 *     `validateConfig` behavior — typos on the wire 400 rather than silently
 *     no-op).
 *
 *   - **Inline per-provider blocks (no `$ref`).** Hub's admin SPA
 *     (`ModuleConfig.tsx`) walks `schema.properties` directly without
 *     dereferencing `$ref`, so a `{ $ref }` block would hide `writeOnly` on
 *     `apiKey` and break the password-input rendering. The
 *     `apiKeyAndModel` definition is retained for downstream validator
 *     consumers but not used inside this schema.
 *
 * Provider lists come from `providers.ts` registries — single source of truth
 * for "what's available." The schema enumerates each provider twice (once in
 * the enum for `transcribeProvider` / `cleanupProvider` selection, once as a
 * property of the per-provider blocks); both lists are sourced from the same
 * registries so they can't drift.
 */

import { cleaners, transcribers } from "./providers.ts";

export const SCOPES = {
  "scribe:transcribe": "Submit audio for transcription (request-time, per-call).",
  "scribe:admin": "Read and write scribe configuration including per-provider credentials.",
} as const;

/**
 * The resolved-config response shape (`GET /.parachute/config`). Wire shape
 * is the same flat camelCase the schema declares.
 *
 * `setupTokenStatus` is the only non-PUT-writable field; it's surfaced under
 * `cleanupProviders["claude-code"].setupTokenStatus` in the GET response
 * (omitted from PUT because it's `readOnly`).
 */
export type SetupTokenStatus = "configured" | "not-configured" | "expired" | "unknown";

export type ResolvedConfig = {
  transcribeProvider: string;
  transcribeProviders: Record<string, ProviderConfigPublic>;
  cleanupProvider: string;
  /**
   * Whether cleanup runs by default when a transcription request omits an
   * explicit cleanup flag. Wire name `cleanupDefault` preserved across
   * 0.4.4-rc.1 (design doc explicitly keeps existing field names additive);
   * `cleanupEnabled` is accepted as an alias on PUT.
   */
  cleanupDefault: boolean;
  cleanupProviders: Record<string, ProviderConfigPublic>;
  cleanupSystemPrompt: string | null;
  cleanupContextTemplate: string | null;
  port: number;
};

/**
 * Per-provider block as it appears in `GET /.parachute/config` — writeOnly
 * apiKey is omitted. `setupTokenStatus` only appears on the `claude-code`
 * cleanup block.
 */
export type ProviderConfigPublic = {
  model?: string;
  url?: string;
  setupTokenStatus?: SetupTokenStatus;
  /** Indicates the SPA can render "key stored — leave blank to keep" placeholder. */
  apiKeyConfigured?: boolean;
};

/**
 * Per-provider transcription block specs. Local-only providers (parakeet-mlx,
 * onnx-asr, whisper) have empty objects — "no configuration needed" is
 * friendly default the SPA can render directly. Cloud providers carry apiKey
 * + model.
 */
function transcribeProviderBlocks(): Record<string, unknown> {
  return {
    "parakeet-mlx": { type: "object", additionalProperties: false, properties: {} },
    "onnx-asr": {
      type: "object",
      additionalProperties: false,
      properties: {
        model: { type: "string", title: "Model", default: "nemo-parakeet-tdt-0.6b-v3" },
      },
    },
    whisper: {
      type: "object",
      additionalProperties: false,
      properties: {
        model: { type: "string", title: "Model", default: "small" },
      },
    },
    groq: {
      type: "object",
      additionalProperties: false,
      title: "Groq",
      properties: {
        apiKey: { type: "string", writeOnly: true, title: "Groq API key" },
        model: { type: "string", title: "Model", default: "whisper-large-v3" },
      },
    },
    openai: {
      type: "object",
      additionalProperties: false,
      title: "OpenAI",
      properties: {
        apiKey: { type: "string", writeOnly: true, title: "OpenAI API key" },
        model: { type: "string", title: "Model", default: "whisper-1" },
      },
    },
  };
}

function cleanupProviderBlocks(): Record<string, unknown> {
  return {
    anthropic: {
      type: "object",
      additionalProperties: false,
      title: "Anthropic API",
      description: "Anthropic API path — bring your own ANTHROPIC_API_KEY.",
      properties: {
        apiKey: { type: "string", writeOnly: true, title: "Anthropic API key" },
        model: { type: "string", title: "Model", default: "claude-3-5-haiku-20241022" },
      },
    },
    "claude-code": {
      type: "object",
      additionalProperties: false,
      title: "Claude Code (subscription)",
      description:
        "Subscription-funded Claude via the Claude Code CLI. No API key — run `claude setup-token` on the host running scribe, then click Refresh.",
      properties: {
        setupTokenStatus: {
          type: "string",
          enum: ["configured", "not-configured", "expired", "unknown"],
          readOnly: true,
          title: "claude setup-token status",
          description:
            "Read-only. Reflects whether `~/.claude.json` carries a usable token. Run `claude setup-token` on the host and use the Refresh action to update.",
        },
      },
    },
    ollama: {
      type: "object",
      additionalProperties: false,
      title: "Ollama",
      properties: {
        url: { type: "string", format: "uri", title: "Ollama URL", default: "http://localhost:11434" },
        model: { type: "string", title: "Model", default: "gemma4:e4b" },
      },
    },
    openai: {
      type: "object",
      additionalProperties: false,
      title: "OpenAI (cleanup)",
      properties: {
        apiKey: { type: "string", writeOnly: true, title: "OpenAI API key" },
        model: { type: "string", title: "Model" },
      },
    },
    gemini: {
      type: "object",
      additionalProperties: false,
      title: "Google Gemini",
      properties: {
        apiKey: { type: "string", writeOnly: true, title: "Gemini API key" },
        model: { type: "string", title: "Model" },
      },
    },
    groq: {
      type: "object",
      additionalProperties: false,
      title: "Groq (cleanup)",
      properties: {
        apiKey: { type: "string", writeOnly: true, title: "Groq API key" },
        model: { type: "string", title: "Model" },
      },
    },
    custom: {
      type: "object",
      additionalProperties: false,
      title: "Custom (OpenAI-compatible)",
      properties: {
        url: { type: "string", format: "uri", title: "Endpoint URL" },
        apiKey: { type: "string", writeOnly: true, title: "API key" },
        model: { type: "string", title: "Model" },
      },
    },
    none: { type: "object", additionalProperties: false, properties: {} },
  };
}

export function buildConfigSchema() {
  const transcribeOptions = Object.keys(transcribers).sort();
  const cleanupOptions = Object.keys(cleaners).sort();

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://parachute.computer/schemas/scribe/config.json",
    title: "Scribe configuration",
    type: "object",
    additionalProperties: false,
    properties: {
      transcribeProvider: {
        type: "string",
        enum: transcribeOptions,
        title: "Transcription provider",
        description: "Engine used to turn audio into text.",
      },
      transcribeProviders: {
        type: "object",
        additionalProperties: false,
        title: "Per-provider transcription settings",
        properties: transcribeProviderBlocks(),
      },
      cleanupProvider: {
        type: "string",
        enum: cleanupOptions,
        title: "LLM cleanup provider",
        description: 'Optional LLM pass that fixes transcription artifacts. Use "none" to skip cleanup.',
      },
      cleanupDefault: {
        type: "boolean",
        title: "Run cleanup by default",
        description: "When a transcription request omits an explicit cleanup flag, run the cleanup pass anyway.",
        default: true,
      },
      cleanupProviders: {
        type: "object",
        additionalProperties: false,
        title: "Per-provider cleanup settings",
        properties: cleanupProviderBlocks(),
      },
      cleanupSystemPrompt: {
        type: "string",
        title: "Cleanup system prompt override",
        description:
          "Optional full override of scribe's built-in cleanup system prompt. The proper-nouns block (from the request `context` part) is still appended after it per cleanupContextTemplate.",
      },
      cleanupContextTemplate: {
        type: "string",
        title: "Cleanup context-block template",
        description:
          "Optional template for how the proper-nouns block is appended after the system prompt. Supports one variable: {{proper_nouns}}.",
      },
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        title: "Server port",
        description:
          "Port scribe's HTTP server listens on. Default 1943. NOTE: port is resolved from services.json and SCRIBE_PORT env, not config.json; this field is informational.",
      },
    },
    definitions: {
      apiKeyAndModel: {
        type: "object",
        additionalProperties: false,
        properties: {
          apiKey: { type: "string", writeOnly: true, title: "API key" },
          model: { type: "string", title: "Model" },
        },
      },
    },
    "x-scopes": SCOPES,
  };
}

export function handleConfigSchema(): Response {
  return Response.json(buildConfigSchema());
}

export function handleConfig(config: ResolvedConfig): Response {
  return Response.json(config);
}
