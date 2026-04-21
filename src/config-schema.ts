import { cleaners, transcribers } from "./providers.ts";

export const SCOPES = {
  "scribe:transcribe": "Submit audio for transcription (request-time, per-call).",
  "scribe:admin": "Read and write scribe configuration. Reserved — not enforced yet (scribe is loopback-trusted through launch).",
} as const;

export type ResolvedConfig = {
  transcribeProvider: string;
  cleanupProvider: string;
  cleanupDefault: boolean;
  cleanupSystemPrompt: string | null;
  cleanupContextTemplate: string | null;
  port: number;
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
        description: "Optional full override of scribe's built-in cleanup system prompt. When set, the caller owns the entire instruction to the cleanup LLM. The proper-nouns block (from the request `context` part) is still appended after it per cleanupContextTemplate.",
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
