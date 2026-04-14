import { transcribe as parakeetMlx } from "./transcribe/parakeet-mlx.ts";
import { transcribe as onnxAsr } from "./transcribe/onnx-asr.ts";
import { transcribe as whisper } from "./transcribe/whisper.ts";
import { transcribe as groq } from "./transcribe/groq.ts";
import { transcribe as openai } from "./transcribe/openai.ts";
import { cleanup as claude } from "./cleanup/claude.ts";
import { cleanup as ollama } from "./cleanup/ollama.ts";
import { openai as openaiCleanup, gemini, groqCleanup, custom } from "./cleanup/openai-compat.ts";

export const transcribers: Record<string, (audio: File) => Promise<string>> = {
  "parakeet-mlx": parakeetMlx,
  "onnx-asr": onnxAsr,
  whisper,
  groq,
  openai,
};

export type Cleaner = (text: string, properNouns?: string) => Promise<string>;

export const cleaners: Record<string, Cleaner> = {
  claude,
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
