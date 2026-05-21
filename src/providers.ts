import { transcribe as parakeetMlx } from "./transcribe/parakeet-mlx.ts";
import { transcribe as onnxAsr } from "./transcribe/onnx-asr.ts";
import { transcribe as whisper } from "./transcribe/whisper.ts";
import { transcribe as groq } from "./transcribe/groq.ts";
import { transcribe as openai } from "./transcribe/openai.ts";
import { cleanup as anthropic } from "./cleanup/anthropic.ts";
import { cleanup as claudeCode } from "./cleanup/claude-code.ts";
import { cleanup as ollama } from "./cleanup/ollama.ts";
import { openai as openaiCleanup, gemini, groqCleanup, custom } from "./cleanup/openai-compat.ts";

export const transcribers: Record<string, (audio: File) => Promise<string>> = {
  "parakeet-mlx": parakeetMlx,
  "onnx-asr": onnxAsr,
  whisper,
  groq,
  openai,
};

export type CleanerOpts = {
  systemPrompt?: string;
  contextTemplate?: string;
};

export type Cleaner = (
  text: string,
  properNouns?: string,
  opts?: CleanerOpts,
) => Promise<string>;

/**
 * Cleanup provider registry. The Anthropic-API path is named `anthropic`
 * (site#52 Part 1 cleanup-provider rename, 2026-05-21) to disambiguate from
 * `claude-code` — the Claude Code CLI / subscription path. Legacy configs
 * carrying `cleanupProvider: "claude"` are auto-rewritten to `"anthropic"`
 * on load (see `migrateClaudeToAnthropic` in `config.ts`).
 */
export const cleaners: Record<string, Cleaner> = {
  anthropic,
  "claude-code": claudeCode,
  ollama,
  openai: openaiCleanup,
  gemini,
  groq: groqCleanup,
  custom,
  none: async (text) => text,
};

export function getProvider<T>(map: Record<string, T>, key: string, label: string): T {
  const provider = map[key];
  if (!provider) {
    console.error(`Unknown ${label} provider: ${key}`);
    console.error(`Available: ${Object.keys(map).join(", ")}`);
    process.exit(1);
  }
  return provider;
}
