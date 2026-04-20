import { cleaners, transcribers } from "./providers.ts";

export const SCOPES = {
  "scribe:transcribe": "Submit audio for transcription (request-time, per-call).",
  "scribe:admin": "Read and write scribe configuration. Reserved — not enforced yet (scribe is loopback-trusted through launch).",
} as const;

export type ResolvedConfig = {
  transcribeProvider: string;
  cleanupProvider: string;
  cleanupDefault: boolean;
  port: number;
  vault: {
    configured: boolean;
    url: string | null;
    cacheTtlSeconds: number | null;
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
        description: "Optional — point scribe at a Parachute Vault so cleanup gets proper-noun context (names, projects, aliases).",
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
