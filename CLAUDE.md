# Parachute Scribe

Audio-to-text + optional LLM cleanup. Whisper-compatible HTTP API, standalone CLI, and library. Runs on Bun, no Node.

## Architecture

```
Audio (wav/mp3/m4a)  →  transcriber  →  raw text  →  [cleanup LLM]  →  clean text
                         (pluggable)                  (pluggable, optional)

CLI (parachute-scribe <file>)  ─┐
HTTP (POST /v1/audio/...)      ─┼─→  createFetchHandler(deps)  →  Bun.serve on :1943
Library (import transcribe)    ─┘
```

- **`src/server.ts`** — `createFetchHandler(deps)` (pure factory, testable without port-binding; extracted in PR #16) + `startServer()` (builds deps, binds `Bun.serve`, writes `services.json`).
- **`src/providers.ts`** — `transcribers` + `cleaners` registries (record maps). Everything else looks up by name; adding a provider means editing one file.
- **`src/auth.ts`** (PR #16) — single `validateToken(token) → {valid, scopes}` seam. Today: shared-secret string compare against `SCRIBE_AUTH_TOKEN`. Tomorrow: hub-issued JWT, body swap, callers unchanged.
- **`src/config.ts` / `src/config-schema.ts`** — file shape + loader; draft-07 JSON Schema served at `/.parachute/config/schema` (provider enums sourced from the live registry so the schema can't drift).
- **`src/parachute-info.ts`** — `/.parachute/info` + `/.parachute/icon.svg` (hub discovery contract).
- **`src/services-manifest.ts`** — atomic upsert into `~/.parachute/services.json` on `serve` boot so the CLI coordinator can find scribe.

## Key design decisions

- **Stateless by design** — scribe never initiates outbound HTTP. Callers provide whatever context they want cleaned-up around (names, project glossary) in the request payload. The built-in vault client is being removed; see the "stateless-scribe" initiative (PRs #16, and the two follow-ups tracking context-in-payload + `vault.ts` deletion).
- **Auth gate is opt-in** — `SCRIBE_AUTH_TOKEN` unset = open (loopback-trusted). Set = require `Authorization: Bearer <token>` on every route except `/health` and `/.parachute/info` (liveness probes and module discovery stay open so hub/CLI can reach scribe without knowing a secret). 401 responses carry full CORS headers so browser clients can read the error.
- **Scopes declared, not yet enforced** — `scribe:transcribe` + `scribe:admin` are listed under `x-scopes` in the config schema. When the hub starts issuing JWTs, scribe enforces without an API-shape change.
- **Provider resolution precedence**: `--flag` > `config.json` > env > default. Same three-tier pattern for every knob.
- **Fail loud, not silent** — malformed `services.json` throws rather than get overwritten (protects sibling services' entries). Malformed config.json throws with the file path in the error.
- **Bun-native**: `Bun.serve` for HTTP, `Bun.file` for I/O, `Bun.$` for provider subprocesses (parakeet-mlx, whisper), `bun test`. No Express, no Node-only deps.

## Running

```bash
parachute-scribe <file>              # transcribe a file (uses default provider)
parachute-scribe <file> --cleanup claude
parachute-scribe <file> --transcribe groq --cleanup ollama
parachute-scribe serve               # HTTP server on :1943
parachute-scribe providers           # list available transcribers + cleaners
parachute-scribe --help              # full flag/env reference
```

The live config shape is always the authoritative source — query it instead of memorizing schema:

```bash
curl http://localhost:1943/.parachute/config         # resolved runtime values
curl http://localhost:1943/.parachute/config/schema  # draft-07 JSON Schema
```

## Config

- **File:** `~/.parachute/scribe/config.json` (since PR #10 — legacy `~/.parachute/scribe.config.json` is auto-migrated on first boot).
- **Override base dir:** `PARACHUTE_HOME=/some/path` → `$PARACHUTE_HOME/scribe/config.json`. Used in Docker and tailnet deployments.
- **Override file directly:** `--config <path>` flag or `SCRIBE_CONFIG=<path>` env. When either is set, migration is skipped (explicit path, trust it).

Env knobs (full list in `src/cli.ts` `usage()` and `.env.example`):

```
SCRIBE_PORT=1943              # server port. PORT also honored for PaaS back-compat.
SCRIBE_AUTH_TOKEN=            # optional; when set, bearer required on non-exempt routes.
PARACHUTE_HOME=~/.parachute   # ecosystem root. Overrides default.
TRANSCRIBE_PROVIDER=parakeet-mlx
CLEANUP_PROVIDER=none
```

## Naming / canonical values

- **Bin:** `parachute-scribe` (renamed from `scribe` in PR #9).
- **npm:** `@openparachute/scribe`.
- **Port:** `1943` (in the Parachute 1939–1949 band; vault is 1940).
- **Mount path (for hub aggregation):** `/scribe`.
- **Icon color:** `#6A9B77` sage (differentiated from vault's `#879B7E`).

## Post-merge hygiene

When a PR is merged, the next thing you do is `git checkout main && git pull`. The `bun link`-linked install follows your checkout — leaving the repo on a feature branch means Aaron is running stale code. Caught 2026-04-21.
