# Parachute Scribe

Audio transcription + LLM cleanup service. Exposes a Whisper-compatible API so any client (Parachute Daily app, curl, etc.) can send audio and get back clean text.

## What this is

A tiny Bun service that takes audio in and returns transcribed, optionally LLM-cleaned text. The pipeline:

```
Audio (wav/mp3/m4a) → Transcription engine → Raw transcript → LLM cleanup (optional) → Clean text
```

## API shape

Whisper-compatible — same format as OpenAI's `/v1/audio/transcriptions`:

```
POST /v1/audio/transcriptions
Content-Type: multipart/form-data

file: <audio file>
model: <string>        # e.g., "parakeet", "whisper-large-v3"
language: <string>     # optional, e.g., "en"
cleanup: <bool>        # optional, parachute extension — run LLM cleanup on result

Response: { "text": "..." }
```

Any client that speaks Whisper API can use this without modification. The `cleanup` param is our extension.

## Transcription backends (to explore)

- **whisper.cpp** — C++ whisper, runs locally, well-supported
- **Parakeet** — NVIDIA's ASR model, what the Flutter app uses via Sherpa-ONNX
- **Proxy to external API** — forward to OpenAI/Groq/Deepgram Whisper API (user provides key)

## LLM cleanup backends (to explore)

- **Ollama** — local LLM, free, no API key needed
- **Claude API** — high quality, needs API key
- **None** — just return raw transcript

## Bun-native

Use Bun for everything:

- `Bun.serve()` for HTTP (not express, not hono)
- `Bun.file` for file I/O
- `Bun.$` for shell commands
- `bun test` for tests

## Context

- **Parachute Daily** (Flutter app) already has offline transcription via Sherpa-ONNX. This service adds a server-side option with higher quality + LLM cleanup.
- **Parachute Vault** is the knowledge graph where transcribed notes land. Scribe doesn't know about the vault — it just returns text. The client (app or agent) stores it.
- Domain: `parachute.computer`, this would be at `scribe.parachute.computer`
- Sister repos: `/Users/parachute/Code/parachute-vault/`, `/Users/parachute/Code/parachute-daily/`

## Open questions

- Which transcription engine to start with? whisper.cpp is most portable. Parakeet via Sherpa-ONNX is what the app already uses.
- How to handle LLM cleanup — what prompt? What model? Is Ollama the right default for self-hosted?
- Should this be installable like vault (`bun install -g`)? Or just a docker container / simple `bun run`?
- Do we need an MCP server for this, or is the REST API sufficient?
