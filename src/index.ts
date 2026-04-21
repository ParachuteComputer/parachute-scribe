export { transcribers, cleaners, getProvider } from "./providers.ts";
export { CLEANUP_PROMPT, buildCleanupPrompt } from "./cleanup/prompt.ts";
export { loadConfig, type ScribeConfig } from "./config.ts";
export {
  buildProperNounsBlockFromEntries,
  parseContextPayload,
  type ContextEntry,
  type ContextPayload,
} from "./context.ts";

import { transcribers, cleaners } from "./providers.ts";
import { loadConfig, type ScribeConfig } from "./config.ts";
import { buildProperNounsBlockFromEntries, parseContextPayload, type ContextPayload } from "./context.ts";

export type TranscribeOptions = {
  provider?: string;
  cleanup?: string;
  config?: ScribeConfig;
  /**
   * Optional pre-fetched context block. When supplied, scribe uses it for the
   * cleanup prompt. Accepts the same shape callers send as the `context`
   * multipart part on POST /v1/audio/transcriptions.
   */
  context?: ContextPayload | string;
};

/**
 * Transcribe an audio file with optional LLM cleanup.
 * This is the main entry point for using scribe as a library.
 */
export async function transcribe(
  audio: File,
  opts: TranscribeOptions = {},
): Promise<string> {
  const config = opts.config ?? await loadConfig();

  const transcribeProvider = opts.provider
    ?? config.transcribe?.provider
    ?? process.env.TRANSCRIBE_PROVIDER
    ?? "parakeet-mlx";
  const cleanupProvider = opts.cleanup
    ?? config.cleanup?.provider
    ?? process.env.CLEANUP_PROVIDER
    ?? "none";

  const transcriber = transcribers[transcribeProvider];
  if (!transcriber) {
    throw new Error(`Unknown transcription provider: ${transcribeProvider}. Available: ${Object.keys(transcribers).join(", ")}`);
  }

  const cleaner = cleaners[cleanupProvider];
  if (!cleaner) {
    throw new Error(`Unknown cleanup provider: ${cleanupProvider}. Available: ${Object.keys(cleaners).join(", ")}`);
  }

  const contextPayload = opts.context !== undefined ? parseContextPayload(opts.context) : null;

  let text = await transcriber(audio);

  if (cleanupProvider !== "none") {
    try {
      const properNouns = contextPayload
        ? buildProperNounsBlockFromEntries(contextPayload)
        : "";
      text = await cleaner(text, properNouns, {
        systemPrompt: config.cleanup?.system_prompt,
        contextTemplate: config.cleanup?.context_template,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Cleanup failed (provider=${cleanupProvider}): ${message} — returning raw transcription`);
    }
  }

  return text;
}

/**
 * Check which transcription providers are available on this system.
 */
export function availableProviders() {
  return {
    transcription: Object.keys(transcribers),
    cleanup: Object.keys(cleaners),
  };
}
