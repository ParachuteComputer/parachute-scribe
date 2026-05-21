/**
 * Tool definitions for the scribe MCP server.
 *
 * Two tools today, both wrapping the existing REST surface:
 *
 *   - `transcribe`      — base64-encoded audio bytes in, transcript out.
 *                         Mirrors `POST /v1/audio/transcriptions`. Used
 *                         when an MCP client already has the bytes in
 *                         hand.
 *   - `transcribe-url`  — URL in, transcript out. Mirrors
 *                         `POST /v1/audio/transcriptions-url`. Used when
 *                         the bytes live on a public-reachable URL
 *                         (podcast feed item, direct mp3, etc.).
 *
 * Both tools share the same transcription pipeline (transcribe →
 * optional LLM cleanup) and respect the same provider configuration
 * captured at boot — exactly equivalent to the REST surface, just with
 * a different transport.
 *
 * Scope: both tools require `scribe:transcribe`. The transport-level
 * gate in server.ts already ensures the caller has at least
 * `scribe:transcribe` before any tool is reachable.
 *
 * Future tools (deferred — listed in scribe#35 but not blocking):
 *   - `list-jobs` / `get-job` — operational. Need a job-tracking layer
 *     that doesn't exist today; scribe is request/response only.
 */

import type { ServerDeps } from "../server.ts";
import {
  UrlFetchError,
  fetchAudioFromUrl,
} from "../url-fetch.ts";
import {
  buildProperNounsBlockFromEntries,
  parseContextPayload,
  type ContextPayload,
} from "../context.ts";

export interface ToolResult {
  /** Plain-text transcript suitable for streaming back to the caller. */
  text: string;
  /** Optional source metadata — present on `transcribe-url`. */
  source?: { url: string; bytes: number; contentType: string | null };
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params: Record<string, unknown>, deps: ServerDeps) => Promise<ToolResult>;
}

export class McpToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

/**
 * Decode a base64 (or base64url) string to a Uint8Array. We accept both
 * because MCP clients vary — Claude Code passes base64url for binary
 * tool arguments, classic SDKs use plain base64.
 */
function decodeBase64(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, "");
  // Convert base64url to base64.
  const standard = cleaned.replace(/-/g, "+").replace(/_/g, "/");
  // Pad.
  const pad = standard.length % 4;
  const padded = pad === 0 ? standard : standard + "=".repeat(4 - pad);
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

/**
 * Decide whether cleanup runs given the user's flag and the resolved
 * default. Mirrors the REST `cleanup` form-field semantics so the MCP
 * surface behaves identically.
 */
function resolveCleanup(
  cleanupParam: unknown,
  resolved: { cleanupProvider: string; cleanupDefault: boolean },
): boolean {
  if (resolved.cleanupProvider === "none") return false;
  if (typeof cleanupParam === "boolean") return cleanupParam;
  if (typeof cleanupParam === "string") {
    if (cleanupParam === "true" || cleanupParam === "1") return true;
    if (cleanupParam === "false" || cleanupParam === "0") return false;
  }
  return resolved.cleanupDefault;
}

async function runPipeline(
  file: File,
  deps: ServerDeps,
  cleanupParam: unknown,
  contextPayload: ContextPayload | null,
): Promise<string> {
  if (deps.transcribe === null) {
    throw new McpToolError(
      "missing_provider",
      "No transcription provider is configured. Configure one in the admin SPA (/scribe/admin) before calling transcribe tools.",
    );
  }
  let text: string;
  try {
    text = await deps.transcribe(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : "transcription failed";
    throw new McpToolError("transcribe_failed", message);
  }
  if (resolveCleanup(cleanupParam, deps.resolvedConfig)) {
    try {
      const properNouns = contextPayload
        ? buildProperNounsBlockFromEntries(contextPayload)
        : "";
      text = await deps.cleanup(text, properNouns, {
        systemPrompt: deps.scribeConfig.cleanup?.system_prompt,
        contextTemplate: deps.scribeConfig.cleanup?.context_template,
      });
    } catch (err) {
      // Match the REST behavior: cleanup failure is a soft warn, not a
      // hard error. Return the raw transcript.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[scribe-mcp] cleanup failed (provider=${deps.resolvedConfig.cleanupProvider}): ${message} — returning raw transcript`,
      );
    }
  }
  return text;
}

function parseOptionalContext(input: unknown): ContextPayload | null {
  if (input == null) return null;
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  const parsed = parseContextPayload(raw);
  if (!parsed) {
    console.warn("[scribe-mcp] malformed 'context' argument — ignoring, cleanup will run without proper nouns");
  }
  return parsed;
}

export const SCRIBE_MCP_TOOLS: McpToolDef[] = [
  {
    name: "transcribe",
    description:
      "Transcribe an audio file. Pass `audio_base64` (the audio bytes as base64) " +
      "and an optional `filename` (helps the transcription provider pick a parser). " +
      "Optional `cleanup` (boolean) overrides the configured cleanup default; " +
      "`context` accepts the same {entries: [...]} proper-nouns block as the REST endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        audio_base64: {
          type: "string",
          description: "Audio bytes, base64-encoded. Required.",
        },
        filename: {
          type: "string",
          description:
            "Original filename. Optional but recommended — the transcription provider may key off the extension (.mp3, .m4a, .wav, …).",
        },
        cleanup: {
          type: ["boolean", "string"],
          description:
            "When true, run the configured cleanup provider over the raw transcript. Omit to use the server default.",
        },
        context: {
          type: ["object", "string"],
          description:
            "Optional proper-nouns block: {entries: [{name, summary?, aliases?}]}.",
        },
      },
      required: ["audio_base64"],
    },
    async execute(params, deps): Promise<ToolResult> {
      const audioBase64 = params.audio_base64;
      if (typeof audioBase64 !== "string" || audioBase64 === "") {
        throw new McpToolError("invalid_args", "'audio_base64' is required and must be a non-empty string");
      }
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(audioBase64);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new McpToolError("invalid_args", `audio_base64 was not valid base64: ${message}`);
      }
      const filename = typeof params.filename === "string" && params.filename.length > 0
        ? params.filename
        : "audio.wav";
      const file = new File([bytes], filename, {
        type: "application/octet-stream",
        lastModified: Date.now(),
      });
      const contextPayload = parseOptionalContext(params.context);
      const text = await runPipeline(file, deps, params.cleanup, contextPayload);
      return { text };
    },
  },
  {
    name: "transcribe-url",
    description:
      "Transcribe audio from a direct URL (mp3, m4a, wav, ogg, flac, webm). " +
      "Pass `url` and optional `cleanup` + `context` arguments. " +
      "Note: YouTube and other site-specific extractors are NOT supported — " +
      "use yt-dlp or similar to extract audio first, then pass the direct audio URL " +
      "(or upload bytes via the `transcribe` tool).",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Direct audio URL. http: or https: only. SSRF-protected (no loopback / private / link-local).",
        },
        cleanup: {
          type: ["boolean", "string"],
          description:
            "When true, run the configured cleanup provider over the raw transcript. Omit to use the server default.",
        },
        context: {
          type: ["object", "string"],
          description:
            "Optional proper-nouns block: {entries: [{name, summary?, aliases?}]}.",
        },
      },
      required: ["url"],
    },
    async execute(params, deps): Promise<ToolResult> {
      const url = params.url;
      if (typeof url !== "string" || url.trim() === "") {
        throw new McpToolError("invalid_args", "'url' is required and must be a non-empty string");
      }
      let fetched;
      try {
        fetched = await fetchAudioFromUrl(url.trim());
      } catch (err) {
        if (err instanceof UrlFetchError) {
          throw new McpToolError(err.code, err.message);
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new McpToolError("fetch_failed", message);
      }
      const contextPayload = parseOptionalContext(params.context);
      const text = await runPipeline(fetched.file, deps, params.cleanup, contextPayload);
      return {
        text,
        source: {
          url: fetched.finalUrl,
          bytes: fetched.bytes,
          contentType: fetched.contentType,
        },
      };
    },
  },
];
