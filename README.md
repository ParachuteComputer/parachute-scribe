# @openparachute/scribe

Audio transcription + LLM cleanup for [Parachute](https://parachute.computer). Whisper-compatible API, CLI, and library.

Takes audio in, returns clean text out. The opposite direction of [`@openparachute/narrate`](https://github.com/ParachuteComputer/parachute-narrate).

## Quick start

Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

```bash
git clone https://github.com/ParachuteComputer/parachute-scribe
cd parachute-scribe
bun install
```

Transcribe a file:

```bash
bun src/cli.ts recording.wav
```

Start the HTTP server:

```bash
bun src/cli.ts serve
```

## How it works

```
Audio (wav/mp3/m4a) --> Transcription engine --> Raw text --> LLM cleanup (optional) --> Clean text
```

## CLI

```bash
parachute-scribe <file>                   # Transcribe a file
parachute-scribe <file> --cleanup claude  # Transcribe + LLM cleanup
parachute-scribe <file> --transcribe groq # Use a specific transcription provider
parachute-scribe <file> --no-cleanup      # Skip cleanup even if configured
parachute-scribe <file> --json            # Output JSON: {"text": "..."}
parachute-scribe serve                    # Start HTTP server (port 1943)
parachute-scribe providers                # List available providers
```

## Library

```ts
import { transcribe } from "@openparachute/scribe";

const text = await transcribe(audioFile);
const cleaned = await transcribe(audioFile, { cleanup: "claude" });
```

Check available providers:

```ts
import { availableProviders } from "@openparachute/scribe";

const { transcription, cleanup } = availableProviders();
```

## HTTP API

Whisper-compatible. Any client that speaks the OpenAI Whisper API works without modification.

```
POST /v1/audio/transcriptions
Content-Type: multipart/form-data

file: <audio file>
model: <string>        # e.g. "parakeet-mlx", "groq"
cleanup: <bool>        # optional extension — run LLM cleanup
```

Response: `{ "text": "..." }`

Other endpoints:

```
GET  /v1/models    # List available transcription providers
GET  /health       # Health check
```

## Transcription providers

| Provider | Type | Notes |
|----------|------|-------|
| `parakeet-mlx` | Local | Mac only. NVIDIA Parakeet via MLX. Fastest local option. Default. |
| `onnx-asr` | Local | Cross-platform. Sherpa-ONNX ASR. |
| `whisper` | Local | Any platform. Requires `whisper-ctranslate2` (`pip install whisper-ctranslate2`). |
| `groq` | Cloud | Fast, cheap (~$0.06/hr). Requires `GROQ_API_KEY`. |
| `openai` | Cloud | Reference Whisper API. Requires `OPENAI_API_KEY`. |

## Cleanup providers

Optional LLM pass that fixes transcription artifacts — filler words, punctuation, formatting.

| Provider | Type | Notes |
|----------|------|-------|
| `claude` | Cloud | High quality. Requires `ANTHROPIC_API_KEY`. |
| `ollama` | Local | Free, no API key. Requires Ollama running. |
| `openai` | Cloud | GPT-based. Requires `OPENAI_API_KEY`. |
| `gemini` | Cloud | Requires `GEMINI_API_KEY`. |
| `groq` | Cloud | Fast. Requires `GROQ_API_KEY`. |
| `custom` | Cloud | Any OpenAI-compatible endpoint. See env vars below. |
| `none` | - | Skip cleanup. Default. |

## Environment variables

```bash
# Transcription
TRANSCRIBE_PROVIDER=parakeet-mlx    # Default transcription engine

# Cleanup
CLEANUP_PROVIDER=none               # Default cleanup engine

# API keys (as needed by your chosen providers)
GROQ_API_KEY=gsk_...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...

# Ollama
OLLAMA_URL=http://localhost:11434    # Default Ollama endpoint
OLLAMA_MODEL=gemma4:e4b              # Default cleanup model

# Custom OpenAI-compatible provider
CUSTOM_CLEANUP_URL=...
CUSTOM_CLEANUP_API_KEY=...
CUSTOM_CLEANUP_MODEL=...

# Server
SCRIBE_PORT=1943                     # HTTP server port (PORT also honored for back-compat)
```

## Vault-aware cleanup (optional)

Point scribe at a [Parachute Vault](https://github.com/ParachuteComputer/parachute-vault) and the cleanup pass will learn the proper nouns you care about — correcting mishearings ("learn by build" → "Learn Vibe Build") and wrapping matches in `[[wikilinks]]` so transcribed memos land pre-linked in your graph.

Copy `scribe.config.example.json` to `~/.parachute/scribe/config.json` (or `$PARACHUTE_HOME/scribe/config.json`) and edit:

```json
{
  "cleanup": { "provider": "ollama", "default": true },
  "vault": {
    "url": "http://localhost:1940",
    "token": "pvt_read_only_token",
    "contexts": [
      { "tag": "person",  "exclude_tag": "archived", "include_metadata": ["summary", "aliases"] },
      { "tag": "project", "exclude_tag": "archived", "include_metadata": ["summary", "aliases"] }
    ]
  }
}
```

Scribe fetches the proper-noun list once per `cache_ttl_seconds` (default 300) and injects it into the cleanup prompt. If the vault is unreachable, cleanup still runs — just without the context.

Default config path is `${PARACHUTE_HOME:-~/.parachute}/scribe/config.json`. Set `SCRIBE_CONFIG=/path/to/config.json` (or pass `--config <path>` on the CLI) to point somewhere else. An older `~/.parachute/scribe.config.json` is auto-migrated to the new path on first run.

## How vault uses scribe

[Parachute Vault](https://github.com/ParachuteComputer/parachute-vault) optionally imports scribe via `await import("@openparachute/scribe")`. When installed, vault gains:

- `POST /v1/audio/transcriptions` — Whisper-compatible endpoint
- `POST /api/ingest` — Upload audio + auto-transcribe into a note
- Auto-transcription hook — notes tagged `#capture` with audio attachments get transcribed automatically

To enable: install scribe alongside vault via `bun link` or npm, then configure `TRANSCRIBE_PROVIDER` in `~/.parachute/.env`.

## Requirements

- [Bun](https://bun.sh)
- A transcription provider (local or cloud)
- `ffmpeg` on PATH (some providers need it for audio conversion)

## License

[AGPL-3.0](./LICENSE)
