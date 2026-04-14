#!/usr/bin/env bun

import { transcribers, cleaners, getProvider } from "./providers.ts";
import { startServer } from "./server.ts";
import { loadConfig } from "./config.ts";
import { fetchProperNouns } from "./vault.ts";

const args = process.argv.slice(2);
const command = args[0];

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function usage() {
  console.log(`scribe — audio transcription + LLM cleanup

Usage:
  scribe <file>                       Transcribe an audio file
  scribe serve                        Start the HTTP server
  scribe providers                    List available providers

Options:
  --transcribe <provider>             Transcription provider (default: parakeet-mlx)
  --cleanup <provider>                Cleanup provider (default: none)
  --no-cleanup                        Skip LLM cleanup even if configured
  --config <path>                     Path to scribe.config.json
  --json                              Output JSON instead of plain text

Environment:
  TRANSCRIBE_PROVIDER                 Default transcription provider
  CLEANUP_PROVIDER                    Default cleanup provider
  SCRIBE_CONFIG                       Path to scribe.config.json (default: ./scribe.config.json)
  PORT                                Server port (default: 3200)

Examples:
  scribe recording.wav
  scribe meeting.m4a --cleanup claude
  scribe memo.mp3 --transcribe groq --cleanup ollama
  scribe serve
`);
}

switch (command) {
  case "serve":
    await startServer();
    break;

  case "providers":
    console.log(`Transcription: ${Object.keys(transcribers).join(", ")}`);
    console.log(`Cleanup:       ${Object.keys(cleaners).join(", ")}`);
    break;

  case "help":
  case "--help":
  case "-h":
  case undefined:
    usage();
    break;

  default:
    await cmdTranscribe(command);
}

async function cmdTranscribe(filePath: string) {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const config = await loadConfig(getFlag("--config"));

  const transcribeProvider = getFlag("--transcribe")
    ?? config.transcribe?.provider
    ?? process.env.TRANSCRIBE_PROVIDER
    ?? "parakeet-mlx";
  const cleanupProvider = hasFlag("--no-cleanup")
    ? "none"
    : getFlag("--cleanup")
      ?? config.cleanup?.provider
      ?? process.env.CLEANUP_PROVIDER
      ?? "none";
  const outputJson = hasFlag("--json");

  const transcribe = getProvider(transcribers, transcribeProvider, "transcription");
  const cleanup = getProvider(cleaners, cleanupProvider, "cleanup");

  const blob = await file.arrayBuffer();
  const name = filePath.split("/").pop() ?? "audio.wav";
  const audioFile = new File([blob], name);

  let text = await transcribe(audioFile);

  if (cleanupProvider !== "none") {
    const properNouns = await fetchProperNouns(config);
    text = await cleanup(text, properNouns);
  }

  if (outputJson) {
    console.log(JSON.stringify({ text }));
  } else {
    console.log(text);
  }
}
