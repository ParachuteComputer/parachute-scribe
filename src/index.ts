export { transcribers, cleaners, getProvider } from "./providers.ts";
export { CLEANUP_PROMPT, buildCleanupPrompt } from "./cleanup/prompt.ts";
export { loadConfig, type ScribeConfig, type VaultContext } from "./config.ts";
export { fetchProperNouns, clearVaultCache } from "./vault.ts";

import { transcribers, cleaners } from "./providers.ts";
import { loadConfig, type ScribeConfig } from "./config.ts";
import { fetchProperNouns } from "./vault.ts";

export type TranscribeOptions = {
  provider?: string;
  cleanup?: string;
  config?: ScribeConfig;
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

  let text = await transcriber(audio);

  if (cleanupProvider !== "none") {
    const properNouns = await fetchProperNouns(config);
    text = await cleaner(text, properNouns);
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
