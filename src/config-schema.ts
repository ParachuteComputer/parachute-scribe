import { cleaners, transcribers } from "./providers.ts";
import type { VaultMode } from "./config.ts";

export const SCOPES = {
  "scribe:transcribe": "Submit audio for transcription (request-time, per-call).",
  "scribe:admin": "Read and write scribe configuration. Reserved — not enforced yet (scribe is loopback-trusted through launch).",
} as const;

export const VAULT_MODES: VaultMode[] = ["off", "fallback", "required"];

export type ResolvedConfig = {
  transcribeProvider: string;
  cleanupProvider: string;
  cleanupDefault: boolean;
  cleanupSystemPrompt: string | null;
  cleanupContextTemplate: string | null;
  port: number;
  vault: {
    configured: boolean;
    url: string | null;
    cacheTtlSeconds: number | null;
    mode: VaultMode;
  };
};

export function buildConfigSchema() {
  const transcribeOptions = Object.keys(transcribers).sort();
  const cleanupOptions = Object.keys(cleaners).sort();
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://parachute.computer/schemas/scribe/config.json",
    title: "Scribe configuration",
    type: "object",
    properties: {
      transcribeProvider: {
        type: "string",
        enum: transcribeOptions,
        title: "Transcription provider",
        description: "Engine used to turn audio into text.",
      },
      cleanupProvider: {
        type: "string",
        enum: cleanupOptions,
        title: "LLM cleanup provider",
        description: 'Optional LLM pass that fixes transcription artifacts — punctuation, filler words, formatting. Use "none" to skip cleanup.',
      },
      cleanupDefault: {
        type: "boolean",
        title: "Run cleanup by default",
        description: "When a transcription request omits an explicit cleanup flag, run the cleanup pass anyway.",
        default: true,
      },
      cleanupSystemPrompt: {
        type: "string",
        title: "Cleanup system prompt override",
        description: "Optional full override of scribe's built-in cleanup system prompt. When set, the caller owns the entire instruction to the cleanup LLM. The proper-nouns block (from vault or request payload) is still appended after it per cleanupContextTemplate.",
      },
      cleanupContextTemplate: {
        type: "string",
        title: "Cleanup context-block template",
        description: "Optional template for how the proper-nouns block is appended after the system prompt. Supports one variable: {{proper_nouns}}. When unset, scribe uses its default rule (append `\\n\\n{proper_nouns}` only if the block is non-empty). When set, the template is always rendered — the caller's template owns its own separators.",
      },
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        title: "Server port",
        description: "Port scribe's HTTP server listens on. Default 1943 (Parachute 1939–1949 band). Requires restart to take effect.",
      },
      vault: {
        type: "object",
        title: "Vault integration",
        description: "Optional — point scribe at a Parachute Vault so cleanup gets proper-noun context (names, projects, aliases). Callers may also supply context directly in the request payload, in which case scribe skips the vault backchannel entirely.",
        properties: {
          url: {
            type: "string",
            format: "uri",
            title: "Vault URL",
            description: "Base URL of the Parachute Vault to query.",
          },
          cacheTtlSeconds: {
            type: "integer",
            minimum: 0,
            title: "Cache TTL (seconds)",
            description: "How long to cache the fetched proper-noun list before refetching.",
            default: 300,
          },
          mode: {
            type: "string",
            enum: VAULT_MODES,
            default: "fallback",
            title: "Vault fetch mode",
            description: "How scribe handles the vault backchannel when the request payload does NOT carry a `context` part. off = never call vault. fallback (default) = call vault; if unreachable, continue cleanup with no proper nouns. required = call vault; if unreachable, the cleanup step raises — the transcription pipeline's cleanup-failure wrapper catches it and the caller still gets a 200 with the raw transcription (no cleanup applied).",
          },
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
