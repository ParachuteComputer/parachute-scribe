#!/usr/bin/env bun

import { transcribers, cleaners, getProvider } from "./providers.ts";
import { startServer } from "./server.ts";
import { loadConfig } from "./config.ts";
import { UrlFetchError, fetchAudioFromUrl } from "./url-fetch.ts";
import { computeBackendAvailability } from "./backend-availability.ts";
import {
  buildDefaultDeps,
  installBackend,
  platformLocalProvider,
} from "./install-backend.ts";

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
  parachute-scribe <file|url>         Transcribe an audio file or URL
  parachute-scribe serve              Start the HTTP server
  parachute-scribe providers          List available providers
  parachute-scribe doctor             Diagnose every backend's prerequisites
  parachute-scribe doctor --fix       Diagnose, then INSTALL the platform's
                                      local backend (apt/pip/uv + ffmpeg + model)
  parachute-scribe install-backend [provider]
                                      Install a local backend (default: the one
                                      matching this platform — onnx-asr on Linux,
                                      parakeet-mlx on macOS)

Options:
  --transcribe <provider>             Transcription provider (default: parakeet-mlx)
  --cleanup <provider>                Cleanup provider (default: none)
  --no-cleanup                        Skip LLM cleanup even if configured
  --config <path>                     Path to scribe.config.json
  --json                              Output JSON instead of plain text

Serve-only options:
  --mount <prefix>                    Path prefix scribe answers under
                                      (e.g. --mount /scribe → routes at
                                      /scribe/health, /scribe/v1/...).
                                      Default "" = bare routes at root.

doctor / install-backend options:
  --fix                               (doctor) Install the platform's local
                                      backend after diagnosing.
  --provider <name>                   Backend to install (onnx-asr | parakeet-mlx).
                                      Default: matches this platform.
  --skip-model                        Don't warm-pull the model (it downloads
                                      lazily on first transcription).

Environment:
  TRANSCRIBE_PROVIDER                 Default transcription provider
  CLEANUP_PROVIDER                    Default cleanup provider
  SCRIBE_CONFIG                       Path to config.json (default: ~/.parachute/scribe/config.json)
  PARACHUTE_HOME                      Override ~/.parachute base (e.g. Docker: /app/.parachute)
  SCRIBE_PORT                         Server port (default: 1943; PORT also honored)
  SCRIBE_BIND                         Bind address (default: 127.0.0.1 loopback;
                                      set 0.0.0.0 to expose on all interfaces)
  SCRIBE_AUTH_TOKEN                   Require Bearer <token> on all routes except
                                      /health and /.parachute/info (optional;
                                      also bridged from config.json auth.required_token)
  SCRIBE_URL_MAX_BYTES                Max bytes for /transcribe-url downloads (default: 100 MiB)
  SCRIBE_URL_TIMEOUT_MS               Timeout for /transcribe-url downloads (default: 5 min)

Examples:
  parachute-scribe recording.wav
  parachute-scribe meeting.m4a --cleanup anthropic
  parachute-scribe memo.mp3 --transcribe groq --cleanup ollama
  parachute-scribe note.wav --cleanup claude-code    # uses your Claude Code auth
  parachute-scribe https://example.com/podcast.mp3   # transcribe from URL
  parachute-scribe serve
  parachute-scribe serve --mount /scribe             # behind a reverse proxy
`);
}

switch (command) {
  case "serve":
    await startServer({ mount: getFlag("--mount") });
    break;

  case "providers":
    console.log(`Transcription: ${Object.keys(transcribers).join(", ")}`);
    console.log(`Cleanup:       ${Object.keys(cleaners).join(", ")}`);
    break;

  case "doctor":
    await cmdDoctor();
    break;

  case "install-backend":
    await cmdInstallBackend(args[1] && !args[1].startsWith("-") ? args[1] : undefined);
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

async function cmdTranscribe(input: string) {
  const audioFile = /^https?:\/\//i.test(input)
    ? await loadFromUrl(input)
    : await loadFromFile(input);

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

/**
 * `doctor` — diagnose every backend's prerequisites (the same report the admin
 * SPA renders), and with `--fix`, run the install routine for the platform's
 * local backend. Exits non-zero when `--fix` was requested but the install
 * didn't verify, so init/the install script can branch on the exit code.
 */
async function cmdDoctor() {
  const scribeConfig = await loadConfig(getFlag("--config"));
  const report = await computeBackendAvailability({ scribeConfig });

  console.log("Transcription backends:");
  for (const [name, v] of Object.entries(report.transcribe)) {
    console.log(`  ${name.padEnd(14)} ${v.status.padEnd(13)} ${v.detail}`);
    if (v.fix && (v.status === "unavailable" || v.status === "warning")) {
      console.log(`  ${" ".repeat(14)}   fix: ${v.fix}`);
    }
  }
  console.log("Cleanup backends:");
  for (const [name, v] of Object.entries(report.cleanup)) {
    console.log(`  ${name.padEnd(14)} ${v.status.padEnd(13)} ${v.detail}`);
    if (v.fix && (v.status === "unavailable" || v.status === "warning" || v.status === "unauthenticated")) {
      console.log(`  ${" ".repeat(14)}   fix: ${v.fix}`);
    }
  }

  if (!hasFlag("--fix")) {
    console.log("\nRun `parachute-scribe doctor --fix` to install the local backend for this platform.");
    return;
  }

  console.log("");
  await cmdInstallBackend(getFlag("--provider"));
}

/**
 * `install-backend [provider]` — install + verify a local transcription
 * backend. Idempotent + non-fatal; exits non-zero on failure (so a `set -e`
 * install script can detect it without the whole `curl|bash` aborting if it
 * chooses to swallow the code).
 */
async function cmdInstallBackend(providerArg?: string) {
  const deps = await buildDefaultDeps();
  const provider = providerArg ?? getFlag("--provider");
  const outcome = await installBackend(deps, {
    provider,
    skipModel: hasFlag("--skip-model"),
  });
  // The human-readable step log already streamed via deps.log; print the final
  // summary line and set the exit code.
  if (outcome.ok) {
    console.log(`\n✓ ${outcome.summary}`);
  } else {
    console.error(`\n✗ ${outcome.summary}`);
    const local = platformLocalProvider(deps.platform);
    if (local) {
      console.error(`  Re-run \`parachute-scribe install-backend ${local}\` after addressing the above.`);
    }
    process.exit(1);
  }
}

async function loadFromFile(filePath: string): Promise<File> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  const blob = await file.arrayBuffer();
  const name = filePath.split("/").pop() ?? "audio.wav";
  return new File([blob], name);
}

async function loadFromUrl(url: string): Promise<File> {
  try {
    const fetched = await fetchAudioFromUrl(url);
    return fetched.file;
  } catch (err) {
    if (err instanceof UrlFetchError) {
      console.error(`url-fetch failed (${err.code}): ${err.message}`);
    } else {
      console.error("url-fetch failed:", err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
}
