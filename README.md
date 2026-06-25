# @openparachute/scribe

Audio transcription + LLM cleanup for [Parachute](https://parachute.computer). Whisper-compatible API, CLI, and library.

Takes audio in, returns clean text out. The opposite direction of [`@openparachute/narrate`](https://github.com/ParachuteComputer/parachute-narrate).

Conventions (naming, ports, scopes, governance) follow [`parachute-patterns`](https://github.com/ParachuteComputer/parachute-patterns) — the ecosystem-wide source of truth.

## Quick start

Two ways in: install via the **hub** (the canonical Parachute path), or **clone** the repo to run from source.

### Install via the hub (recommended)

If you've got the Parachute [hub](https://github.com/ParachuteComputer/parachute-hub) running (the portal on `:1939`), one command installs scribe, assigns its canonical port (`1943`), registers it under the hub supervisor, and starts it:

```bash
parachute install scribe
```

In a terminal this prompts for a transcription provider + API key. To set them non-interactively:

```bash
parachute install scribe --scribe-provider groq --scribe-key gsk_…
```

Once installed, scribe is reachable **through the hub** at `<hub-origin>/scribe/...` — e.g. its admin/config UI is `<hub-origin>/scribe/admin` and the Whisper endpoint is `<hub-origin>/scribe/v1/audio/transcriptions`. The hub proxies `/scribe/*` from `:1939` to scribe on loopback `:1943`. For a local hub, `<hub-origin>` is `http://127.0.0.1:1939`.

### Clone and run from source

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

Start the HTTP server (port `1943`):

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
parachute-scribe <file> --cleanup anthropic  # Transcribe + LLM cleanup (Anthropic API)
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
const cleaned = await transcribe(audioFile, { cleanup: "anthropic" });
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

### URL ingestion

For audio that already lives on the public web (podcast feed items,
direct mp3/m4a/wav/ogg/flac/webm URLs):

```
POST /v1/audio/transcriptions-url
Content-Type: application/json

{
  "url": "https://example.com/episode-42.mp3",
  "cleanup": true,                         // optional
  "context": { "entries": [...] }          // optional proper-nouns block
}
```

Response: `{ "text": "...", "source": { "url": "...", "bytes": 1234567, "contentType": "audio/mpeg" } }`

SSRF defenses: only `http:` / `https:` schemes; rejects `localhost`,
loopback / private / link-local / CG-NAT / multicast IPs (re-checked on
every redirect); 100 MiB body cap (override via `SCRIBE_URL_MAX_BYTES`);
5-minute timeout (`SCRIBE_URL_TIMEOUT_MS`). YouTube and other site
extractors are NOT supported — use `yt-dlp` to extract audio first, then
POST the resulting URL or file.

### MCP transport

Scribe also speaks [MCP](https://modelcontextprotocol.io/) at `/scribe/mcp`
(streamable HTTP, stateless mode — restart-safe). Exposes two tools:

- `transcribe` — accepts `audio_base64` + optional `filename`, `cleanup`, `context`
- `transcribe-url` — accepts `url` + optional `cleanup`, `context`

Same scope gate as the REST endpoints — `scribe:transcribe` required.
Useful for agents inside containers (e.g. `parachute-agent`) that already
have MCP wiring but no REST plumbing.

Streamable-HTTP MCP requires `Accept: application/json, text/event-stream`
on every request — the SDK will refuse the negotiation without both types.

Other endpoints:

```
GET  /v1/models                    # List available transcription providers
GET  /health                       # Health check
GET  /.parachute/info              # Module identity (name, version, icon, kind)
GET  /.parachute/icon.svg          # Inline SVG icon
GET  /.parachute/config/schema     # Draft-07 JSON Schema for scribe's config
GET  /.parachute/config            # Current resolved runtime config values
*    /scribe/mcp                   # MCP (streamable HTTP)
```

Scribe reserves two scopes for future hub-issued-token enforcement:
`scribe:transcribe` (request-time, per-call) and `scribe:admin` (config writes).
Neither is enforced yet — scribe is loopback-trusted through launch — but the
schema declares them under `x-scopes` for forward compat.

## Transcription providers

| Provider | Type | Notes |
|----------|------|-------|
| `parakeet-mlx` | Local | macOS / Apple Silicon only (MLX). Fastest local option. Default on Mac. |
| `onnx-asr` | Local | Cross-platform (the local backend for **Linux**, e.g. a DigitalOcean droplet). Parakeet via ONNX Runtime. See [Local transcription backends](#local-transcription-backends--install--sizing) for install + RAM. |
| `whisper` | Local | Any platform. Requires `whisper-ctranslate2` (`pip install whisper-ctranslate2`). |
| `groq` | Cloud | Fast, cheap (~$0.06/hr). Requires `GROQ_API_KEY`. |
| `openai` | Cloud | Reference Whisper API. Requires `OPENAI_API_KEY`. |

## Cleanup providers

Optional LLM pass that fixes transcription artifacts — filler words, punctuation, formatting.

| Provider | Type | Notes |
|----------|------|-------|
| `anthropic` | Cloud | Anthropic API. Requires `ANTHROPIC_API_KEY` (or set via the admin SPA). Renamed from `claude` in 0.4.4 — legacy configs auto-migrate. |
| `claude-code` | Local CLI | Subscription-funded Claude via the [Claude Code CLI](https://claude.com/claude-code). No API key — run `claude setup-token` on the host. |
| `ollama` | Local | Free, no API key. Requires Ollama running. |
| `openai` | Cloud | GPT-based. Requires `OPENAI_API_KEY`. |
| `gemini` | Cloud | Requires `GEMINI_API_KEY`. |
| `groq` | Cloud | Fast. Requires `GROQ_API_KEY`. |
| `custom` | Cloud | Any OpenAI-compatible endpoint. See env vars below. |
| `none` | - | Skip cleanup. Default. |

## Local transcription backends — install & sizing

The local backends (`parakeet-mlx`, `onnx-asr`, `whisper`) run an ASR model on
your own CPU/GPU — no API key, no per-minute cost, audio never leaves the box.
The tradeoff is that they need to be installed, and they need real RAM and CPU.

Pick the backend that matches your platform:

- **macOS / Apple Silicon →** `parakeet-mlx` (the default; uses Apple's MLX).
- **Linux (incl. a DigitalOcean / Hetzner droplet) →** `onnx-asr` (Parakeet via
  ONNX Runtime). `parakeet-mlx` is macOS-only and won't run here.
- **Either platform →** `whisper` (`whisper-ctranslate2`), if you prefer Whisper.

### macOS (Apple Silicon)

```bash
brew install ffmpeg              # decode non-WAV audio (mp3/m4a/…)
uv tool install parakeet-mlx    # or: pip install parakeet-mlx
# Make sure the tool is on PATH, then point scribe at it:
#   TRANSCRIBE_PROVIDER=parakeet-mlx   (the default)
```

For `onnx-asr` on Mac, follow the Linux `pip install onnx-asr[cpu,hub]` step
below — it's cross-platform.

### Linux (Debian / Ubuntu — the DigitalOcean case)

```bash
# 1. System prerequisites: Python + pip + ffmpeg.
sudo apt update
sudo apt install -y python3 python3-pip python3-venv ffmpeg

# 2. Install the onnx-asr CLI. A venv keeps it off the system Python:
python3 -m venv ~/.venvs/scribe-asr
source ~/.venvs/scribe-asr/bin/activate
pip install "onnx-asr[cpu,hub]"
# (uv works too: `uv tool install "onnx-asr[cpu,hub]"`)

# 3. Make `onnx-asr` reachable on scribe's PATH, then select the backend:
#   TRANSCRIBE_PROVIDER=onnx-asr
```

`onnx-asr[cpu,hub]` pulls in CPU ONNX Runtime plus the model-download helpers.
The model (default `nemo-parakeet-tdt-0.6b-v3`) is fetched from Hugging Face on
first use. `ffmpeg` is required to decode anything that isn't already WAV.

> The admin SPA's backend check (and `GET /scribe/admin/backend-availability`)
> tells you exactly which binary or system dep is missing — if a backend shows as
> unavailable, that report names the precise `pip install` / `apt install` fix.

### Sizing caveat — local ASR needs real RAM

The ONNX Parakeet model is **not** tiny once loaded into memory. Be honest with
yourself about the box:

- **A 1 GB droplet (DigitalOcean's smallest) will struggle.** Loading the model
  plus ONNX Runtime can exceed available RAM — expect the process to be killed
  by the OOM killer, or to swap so hard that a few minutes of audio takes a very
  long time. Don't plan on running local ASR there.
- **~2 GB RAM is a realistic floor**, and **4 GB+** is comfortable for routine
  use. More CPU cores = faster transcription; there's no GPU requirement, but a
  bigger box helps a lot.

If you're on a small droplet and don't want to size up, **use a cloud
transcription provider instead** — `groq` (fast, ~$0.06/hr) or `openai`. These
do the heavy lifting on the provider's hardware, so scribe stays light:

```bash
# Switch scribe to a hosted transcription backend (no local model needed):
TRANSCRIBE_PROVIDER=groq
GROQ_API_KEY=gsk_…
# or: TRANSCRIBE_PROVIDER=openai  +  OPENAI_API_KEY=sk-…
```

See [Provider setup](#provider-setup--where-does-my-api-key-go) for where that
key goes (admin SPA, env var, or config file). The other option is to keep local
ASR but run scribe on a larger box / a dedicated transcription host that vault
and the hub reach over the network.

## Provider setup — where does my API key go?

Local providers (`parakeet-mlx`, `onnx-asr`, `whisper`, `ollama`, `claude-code`) need no key. Cloud providers need one. Scribe reads a provider's key from three places, in precedence order — **config file > env var > built-in default**:

1. **The admin SPA (hub installs).** Open `<hub-origin>/scribe/admin`, pick your provider, paste the key. Scribe writes it into `~/.parachute/scribe/config.json` under `transcribeProviders.<name>` / `cleanupProviders.<name>`. Updating a **key** for the provider you're already on takes effect on the next request. **Selecting or switching a provider needs a restart** (`parachute restart scribe`) — the admin SPA flags this too. This is the path for hub-managed installs.
2. **An env var** — the right path for source / CLI runs. Put keys in `~/.parachute/scribe/.env` (or your shell environment):

   | Provider | Key env var | Used for |
   |---|---|---|
   | `groq` | `GROQ_API_KEY` | transcription + cleanup |
   | `openai` | `OPENAI_API_KEY` | transcription + cleanup |
   | `anthropic` | `ANTHROPIC_API_KEY` | cleanup |
   | `gemini` | `GEMINI_API_KEY` | cleanup |
   | `custom` | `CLEANUP_API_KEY` | cleanup |

   `claude-code` is the no-key Anthropic path: it shells out to the [Claude Code CLI](https://claude.com/claude-code) and uses your existing subscription auth — run `claude setup-token` on the host instead of setting a key.

The full env-var surface (model overrides, endpoints) is in [Environment variables](#environment-variables) below; `.env.example` is the copy-paste starting point.

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

# Auth (optional)
SCRIBE_AUTH_TOKEN=                   # If set, require Authorization: Bearer <token> on all routes
                                     # except /health and /.parachute/info. Unset = open (loopback-only).
```

## Auth

By default scribe is open — any caller on a network it's bound to can transcribe. For exposed deployments (tailnet, funnel, shared hosts), set `SCRIBE_AUTH_TOKEN` and pass it as `Authorization: Bearer <token>` on every request. `/health` and `/.parachute/info` stay open so liveness probes and module discovery work without a secret.

```bash
SCRIBE_AUTH_TOKEN=$(openssl rand -hex 32) bun src/cli.ts serve
```

```bash
curl -H "Authorization: Bearer $SCRIBE_AUTH_TOKEN" \
  -F "file=@recording.wav" \
  http://localhost:1943/v1/audio/transcriptions
```

401 response shape: `{"error":"unauthorized","message":"SCRIBE_AUTH_TOKEN required"}`. CORS headers are included so browser clients can read the error.

## Proper-noun context

Cleanup improves when scribe knows the proper nouns you care about — so mishearings like "learn by build" become "Learn Vibe Build". Callers push context alongside the audio as a `context` multipart part:

```bash
curl -F "file=@memo.wav" \
  -F 'context={"entries":[{"name":"Learn Vibe Build","summary":"6-week cohort","aliases":["LVB","Learn by Build"]}]};type=application/json' \
  http://localhost:1943/v1/audio/transcriptions
```

Scribe uses whatever you push and never initiates outbound HTTP on its own. This is what [Parachute Vault](https://github.com/ParachuteComputer/parachute-vault) does — it queries its own notes and pushes the result with each transcription.

> Older scribe versions (0.2.x and earlier) pulled context from a configured vault via a `vault:` block in `scribe/config.json`. That path was removed in **0.3.0**. A stale `vault:` block in your config is ignored with a one-time warning on load; delete it once you see the warning. Callers that used to rely on it (vault, custom integrations) must now push context in the request.

Default config path is `${PARACHUTE_HOME:-~/.parachute}/scribe/config.json`. Set `SCRIBE_CONFIG=/path/to/config.json` (or pass `--config <path>` on the CLI) to point somewhere else. An older `~/.parachute/scribe.config.json` is auto-migrated to the new path on first run.

### Customizing the cleanup prompt

Override scribe's built-in cleanup system prompt or change how proper nouns are appended, in `~/.parachute/scribe/config.json`:

```json
{
  "cleanup": {
    "provider": "claude-code",
    "default": true,
    "system_prompt": "You clean up voice memos. Be conservative.",
    "context_template": "\n\nKnown names:\n{{proper_nouns}}"
  }
}
```

`system_prompt` replaces the built-in prompt verbatim. `context_template` controls how the proper-nouns block (sent in the request's `context` part) is appended — the single variable `{{proper_nouns}}` is substituted with the block, or left empty when no context was provided.

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
