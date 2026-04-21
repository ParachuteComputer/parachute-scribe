#!/usr/bin/env bun

import { transcribers, cleaners, getProvider } from "./providers.ts";
import { startServer } from "./server.ts";
import { loadConfig } from "./config.ts";

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
  console.log(`parachute-scribe — audio transcription + LLM cleanup

Usage:
  parachute-scribe <file>             Transcribe an audio file
  parachute-scribe serve              Start the HTTP server
  parachute-scribe providers          List available providers

Options:
  --transcribe <provider>             Transcription provider (default: parakeet-mlx)
  --cleanup <provider>                Cleanup provider (default: none)
  --no-cleanup                        Skip LLM cleanup even if configured
  --config <path>                     Path to scribe.config.json
  --json                              Output JSON instead of plain text

Environment:
  TRANSCRIBE_PROVIDER                 Default transcription provider
  CLEANUP_PROVIDER                    Default cleanup provider
  SCRIBE_CONFIG                       Path to config.json (default: ~/.parachute/scribe/config.json)
  PARACHUTE_HOME                      Override ~/.parachute base (e.g. Docker: /app/.parachute)
  SCRIBE_PORT                         Server port (default: 1943; PORT also honored)
  SCRIBE_AUTH_TOKEN                   Require Bearer <token> on all routes except
                                      /health and /.parachute/info (optional)

Examples:
  parachute-scribe recording.wav
  parachute-scribe meeting.m4a --cleanup claude
  parachute-scribe memo.mp3 --transcribe groq --cleanup ollama
  parachute-scribe note.wav --cleanup claude-code    # uses your Claude Code auth
  parachute-scribe serve
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
    text = await cleanup(text, "", {
      systemPrompt: config.cleanup?.system_prompt,
      contextTemplate: config.cleanup?.context_template,
    });
  }

  if (outputJson) {
    console.log(JSON.stringify({ text }));
  } else {
    console.log(text);
  }
}
