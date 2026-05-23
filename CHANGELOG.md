# Changelog

## [0.4.4-rc.7] - 2026-05-23

### Removed

- Dropped `kind` field from the `/.parachute/info` runtime endpoint response. Companion to scribe#52's module.json drop. Closes part of hub#340.

## [0.4.4-rc.6] - 2026-05-23

### chore(scribe): drop `kind` from `.parachute/module.json` (hub#301 Phase B)

- Dropped `kind` field from `.parachute/module.json`. Per hub#301 Phase B. No behavior change.

## [0.4.4-rc.5] - 2026-05-21

### feat(scribe): POST /admin/clear-credential endpoint (Phase 2 polish from #47)

Adds `POST /admin/clear-credential/<kind>/<name>` — the only way to erase a stored writeOnly credential without hand-editing `~/.parachute/scribe/config.json`. Pairs with the PUT omit-to-keep semantics shipped in [scribe#47](https://github.com/ParachuteComputer/parachute-scribe/pull/47): PUT preserves `apiKey` when omitted (so the SPA's password input can leave the field blank to mean "keep what's there"), and this endpoint is the operator's escape hatch for "actually drop it." Flagged as Phase 2 polish on the scribe#47 + scribe#48 reviews; closes the TODO that referenced it from `config-write.ts` and `server.ts`.

**Endpoint shape.**
- `POST /admin/clear-credential/{kind}/{name}` where `kind ∈ ["transcribe", "cleanup"]` and `name` is the registry-valid provider name (e.g. `cleanup/anthropic`, `transcribe/groq`).
- Auth: `scribe:admin` scope, inherited from the existing `/admin/*` route gate.
- Empty body (no payload — the path segments are the whole request).
- 200 `{ok: true, cleared: {kind, name, field: "apiKey"}, hadStoredValue: bool}` on success. `hadStoredValue` distinguishes a real clear from a no-op (clearing a provider with nothing stored still returns 200; the operator's intent — "ensure this credential is gone" — is satisfied either way).
- 400 `{error: "invalid_kind"|"unknown_provider"|"invalid_path", message}` for bad inputs.
- 401/403 inherited from the standard auth + scope gates.

**Idempotency posture: 200 always, distinguish via `hadStoredValue`.** Chose 200-on-no-op over 404 so the SPA's "Clear" button doesn't need separate error UI for "was already cleared" vs "didn't exist." The `hadStoredValue` flag carries the distinction for callers that want to know.

**Field-explicit response shape.** Today the only clearable field is `apiKey`; the response carries `field` explicitly so the wire contract can extend (e.g. claude-code `setupToken` once that flow is implemented) without reshaping callers.

**Tidy on-disk shape.** When the cleared provider entry held *only* `apiKey` (no `model`/`url`), the entry is removed entirely rather than left as an empty `{}` shell. When that was the last entry in the `cleanupProviders` / `transcribeProviders` map, the whole map is dropped from the file. Mirrors the housekeeping in `mergeIntoFileShape`.

**In-process sync.** After the atomic write, the in-process `scribeConfig.transcribeProviders` / `cleanupProviders` are replaced with the post-clear shape so the next transcribe/cleanup request doesn't keep using the just-cleared apiKey from memory. Same pattern PUT already uses.

**Phase 2 != SPA work.** This PR ships the server-side endpoint only. Hub#300's admin SPA still has password-input fields for writeOnly credentials but no "Clear" button — that affordance is a future hub PR. Operators can hit this endpoint via `curl` today:

```bash
curl -X POST http://localhost:1943/admin/clear-credential/cleanup/anthropic \
  -H "Authorization: Bearer $SCRIBE_AUTH_TOKEN"
```

**Test gate.** `bun test src/` — 375 pass (was 360 on rc.4), 794 expect() calls. 14 new tests covering happy path (200 + on-disk strip + in-process sync), idempotent no-op (200 + `hadStoredValue: false`), apiKey-only entry removal, transcribe-kind happy path, GET reflects post-clear state (`apiKeyConfigured` flag flips), 400 invalid_kind / unknown_provider / cross-kind name / missing segment / extra segment, 401 missing+wrong bearer in closed mode, 200 with matching shared-secret, GET-method-rejection, sibling-provider preservation. `bun run typecheck` clean. `bunx biome check .` clean.

**Files touched.** `src/config-write.ts` (added `validateClearCredentialTarget` + `clearProviderCredential` + `CREDENTIAL_KINDS` / `CLEARABLE_FIELDS` exports + updated docstring), `src/server.ts` (route dispatch + `handleClearCredential` handler), `src/site-52-routes.test.ts` (14-test describe block), `package.json` version, `CHANGELOG.md`.

## [0.4.4-rc.4] - 2026-05-21

### feat(scribe): self-register manifest + installDir at startup (#38)

Closes [#38](https://github.com/ParachuteComputer/parachute-scribe/issues/38). On `parachute-scribe serve` boot, scribe now reads its own `.parachute/module.json` and atomically upserts its row in `~/.parachute/services.json` — stamping `installDir`, paths/health/displayName/tagline/stripPrefix from the manifest, version from `package.json`. Mirrors the pattern already shipped in [vault#266](https://github.com/ParachuteComputer/parachute-vault/pull/266) and [runner#3](https://github.com/ParachuteComputer/parachute-runner/pull/3).

**Why this exists.** Hub-as-supervisor (v0.6) reads `~/.parachute/services.json` to know which modules exist on the host. Before this PR, scribe relied on the `bun link` install path (or hub's vendored `SCRIBE_FALLBACK` manifest) to stamp `installDir`. A `bun link`-mode dev tree that never went through `parachute install scribe` was missing the field, leaving `parachute restart scribe` unable to resolve back to the checkout. Self-registration closes that gap — scribe's manifest is now the single source of truth.

**Operator-override discipline preserved.** Per [scribe#40](https://github.com/ParachuteComputer/parachute-scribe/issues/40) / [paraclaw#145](https://github.com/ParachuteComputer/parachute-agent/issues/145): if services.json already has a row for `parachute-scribe`, the existing `port` survives the write — operator (or hub) overrides are not silently restamped. First-boot writes the bound port; subsequent boots preserve.

**Hub-stamped fields ride through.** `upsertService` merges rather than replaces, so any field hub stamps onto the row (`installDir` from [parachute-hub#84](https://github.com/ParachuteComputer/parachute-hub/issues/84), future `uiUrl` / `managementUrl`) survives every self-registration pass. We do re-stamp our own `installDir` so it follows the live checkout after a `git pull` moves the package root.

**Graceful failure.** All four read/write boundaries (missing module.json, malformed module.json, malformed services.json, unwritable target) return `{ok: false}` with a `[scribe]` warn log rather than throwing. The daemon serves locally even when the discoverability bookkeeping fails — the symptom is "scribe doesn't appear in `parachute status` until the underlying issue clears."

**`SCRIBE_FALLBACK` retirement deferred.** Hub's `FIRST_PARTY_FALLBACKS[scribe]` stays in place this release; it retires in a future hub PR after all four committed-core modules (vault/notes/scribe/runner) are confirmed self-registering reliably across the install matrix. Additive change — no hub coordination required for this PR to ship.

**New files.** `src/self-register.ts` (helper + `resolveProjectRoot`), `src/self-register.test.ts` (14 new tests covering first-boot, subsequent-boot port preservation, hub-stamped field merge, idempotency, sibling preservation, and the four graceful-failure modes). `src/services-manifest.ts` refactored to mirror runner's env-injection shape on `resolveManifestPath(env?)`. `.parachute/module.json` gained explicit `stripPrefix: true` (was implicit via hub's `SCRIBE_FALLBACK`).

**Test gate.** `bun test src/` — 360 pass (was 344 on rc.3), 749 expect() calls. `bun run typecheck` clean.

## [0.4.4-rc.3] - 2026-05-21

### feat(scribe): accept --mount flag for prefix-stripping uniform with notes-serve (#39)

Closes [#39](https://github.com/ParachuteComputer/parachute-scribe/issues/39). Adds a `--mount <prefix>` flag to `parachute-scribe serve`, mirroring the shape `notes-serve.ts` (and `parachute-agent`) already use. Scribe now strips the configured mount from inbound pathnames before the route table fires, so external `/scribe/v1/audio/transcriptions` reaches the same internal handler as bare `/v1/audio/transcriptions`.

**Flag semantics.** Default is empty (`--mount ""` or omitting the flag) — bare routes at the origin root, identical to pre-#39 behavior. `--mount /` is equivalent. `--mount /scribe` means every external URL must be prefixed with `/scribe`; bare requests return 404. `--mount scribe` (no leading slash) and `--mount /scribe/` (trailing slash) are auto-normalized to `/scribe`.

**Hub coordination.** No breaking change today. Hub continues to set `stripPrefix: true` on the SCRIBE_FALLBACK entry, so the existing reverse-proxy path still strips the prefix before forwarding. The follow-up — flip hub's `stripPrefix` to `false` and pass `--mount /scribe` in the start command — is tracked on hub's side and lands when there's bandwidth.

**Admin SPA back-compat.** The `/scribe/admin` URL keeps working at the default mount as a legacy alias; the canonical post-mount route is `/admin`. Same back-compat applies to `/scribe/mcp` → `/mcp`. When scribe is launched with `--mount /scribe`, the admin page bakes the mount prefix into its in-page fetch URLs so the `fetch('/.parachute/config')` calls become `fetch('/scribe/.parachute/config')`.

**New files.** `src/mount.ts` (`normalizeMount` + `stripMount` helpers), `src/mount.test.ts` (30 new tests covering the matrix of mount values and route shapes).

## [0.4.4-rc.2] - 2026-05-21

### feat(scribe): POST /transcribe-url + MCP server (#34, #35)

Adds URL-based audio ingestion and an MCP transport so scribe is reachable from non-REST callers (paraclaw agent containers, MCP clients).

#### `POST /v1/audio/transcriptions-url`

Closes [#34](https://github.com/ParachuteComputer/parachute-scribe/issues/34). JSON body: `{ url, cleanup?, context? }`. Downloads audio from `url`, runs the existing transcribe → optional-cleanup pipeline, returns `{ text, source: { url, bytes, contentType } }`.

**Scope limited to direct audio URLs.** YouTube + general-purpose video extraction is punted (see "YouTube punt" below). Accepted Content-Types: `audio/*`, plus `video/{webm,mp4,ogg,quicktime}` containers that often carry audio-only payloads. `application/octet-stream` passes when the URL path ends in an audio-shaped extension (mp3, m4a, wav, flac, ogg, opus, oga, webm, mp4, m4b, aac, aiff, aif).

**SSRF defenses (`src/url-fetch.ts`):**

- **Scheme allowlist** — `http:` / `https:` only. `file://`, `data:`, `gopher://`, etc. → 400 `unsupported_scheme`.
- **Hostname guard** — `localhost`, `*.localhost`, IP literals in loopback / private (10/8, 172.16/12, 192.168/16) / link-local (169.254/16, fe80::/10) / CG-NAT (100.64/10) / multicast / reserved → 400 `blocked_host`. IPv4-mapped-IPv6 (`::ffff:127.0.0.1` and the hex-normalized form Bun emits) deferred to the v4 check.
- **DNS resolution + re-check** — hostnames resolve via `dns.lookup` and the resolved address re-runs the IP blocklist (catches `169-254-169-254.example.com` style rebinding).
- **Redirect revalidation** — every `3xx Location` hop re-runs the full SSRF gauntlet. Max 5 redirects.
- **Size cap** — `SCRIBE_URL_MAX_BYTES` (default 100 MiB). Enforced both via `Content-Length` (when declared) AND mid-stream — a chunked-transfer source that omits Content-Length can't bypass.
- **Timeout** — `SCRIBE_URL_TIMEOUT_MS` (default 5 min). Wraps the whole fetch.
- **Content-Type sniff** — non-audio responses 415 *before* hitting the transcription pipeline.

Error responses use stable shapes the caller can branch on: `{error, message}` where `error` is one of `invalid_url | unsupported_scheme | blocked_host | dns_failed | fetch_failed | timeout | too_large | not_audio | invalid_json`.

**YouTube punt.** Issue #34 mentioned YouTube + podcasts. Podcasts (direct mp3 RSS items) work today. YouTube does NOT — supporting `yt-dlp` would mean a heavy runtime dep (~50MB Python + ffmpeg) and a much bigger SSRF surface (libcurl plus all the protocol handlers yt-dlp speaks). Callers extract audio with `yt-dlp` outside scribe and POST the resulting URL or file. This is documented in the README and on the MCP tool's description.

**Scope:** `scribe:transcribe` (same as the file endpoint).

#### MCP server at `/scribe/mcp`

Closes [#35](https://github.com/ParachuteComputer/parachute-scribe/issues/35). Streamable HTTP transport in stateless mode (no session ID generator — server restarts never break clients), mounted at `/scribe/mcp`. Same pattern vault uses at `/vault/{name}/mcp`.

Two tools:

- **`transcribe`** — `{audio_base64, filename?, cleanup?, context?}`. Decodes base64 (and base64url — Claude Code passes the latter) and runs the standard pipeline.
- **`transcribe-url`** — `{url, cleanup?, context?}`. Same as the REST URL endpoint. Returns `structuredContent.source` alongside the text content so MCP clients with JSON understanding can pick up the final URL / bytes / content-type without re-parsing the text payload.

Both tools require `scribe:transcribe`; the tool registry's `requiredScopeForTool` defaults unknown tools to `scribe:admin` so a future un-registered tool can't be reached accidentally. The transport-level scope gate filters `tools/list` to what the caller can actually invoke.

Future tools listed in #35 (`list-jobs`, `get-job`) are deferred — scribe has no job-tracking layer today; it's request/response only.

#### CLI

`parachute-scribe <url>` now accepts an `http://` or `https://` URL alongside the file path. URL inputs go through the same SSRF-guarded fetcher as the REST endpoint.

#### Tests

34 unit tests in `url-fetch.test.ts` cover scheme rejection, IP-literal blocklist (v4 + v6 + IPv4-mapped-v6), DNS resolution + blocklist, redirect revalidation, size cap (mid-stream), non-audio 415, content-type fallback for `application/octet-stream` + audio extension.

12 integration tests in `transcribe-url-route.test.ts` exercise the full REST endpoint: happy path, missing URL, invalid JSON, SSRF rejection, unsupported scheme, non-audio, 404 fallthrough, missing-provider 400 / `missing_provider`, cleanup pass-through, context-payload threading, auth gating.

7 MCP tests in `mcp/mcp.test.ts` cover `tools/list`, both tools' happy paths, structured-content source field, SSRF rejection (as `isError: true` tool result, not transport 4xx), invalid arguments, missing-provider, and auth gating.

#### One-PR-vs-two rationale

Issues #34 and #35 were filed together: #34 is the URL endpoint, #35 is the MCP server exposing #34 as a tool. The MCP server is ~120 LOC of scaffolding that wraps the same pipeline the REST endpoint uses — splitting them would mean either landing #35 with a stub `transcribe-url` tool returning `not_implemented`, or landing #34 first and #35 immediately after with a near-empty diff. One PR keeps the scope cohesive.

#### Test count

314 pass / 0 fail (was 261 / 0 on rc.1) — 53 new tests across the URL fetcher (34), REST endpoint (12), and MCP transport (7).

## [0.4.4-rc.1] - 2026-05-21

### feat(scribe): admin SPA configurable transcription + cleanup providers (schema + per-request key reads + migration shim)

Part 1 of [site#52](https://github.com/ParachuteComputer/parachute.computer/issues/52) — extends scribe's `.parachute/config` surface so the hub admin SPA (hub#260 / hub#300) can configure per-provider API keys, model selection, and the `claude setup-token` status flow end-to-end. Companion to [hub#300](https://github.com/ParachuteComputer/parachute-hub/issues/300)'s SPA.

#### Schema

- New top-level `transcribeProviders` and `cleanupProviders` objects on the JSON Schema served at `/.parachute/config/schema`. Each per-provider block carries the keys that provider supports — `apiKey` (`writeOnly: true`), `model`, `url` (for self-hosted endpoints). The SPA renders each per-provider section under the matching dropdown.
- `apiKey` fields are `writeOnly: true` across the board. **`GET /.parachute/config` OMITS them from the response** (omit-to-keep contract per hub#300; no `"***"` sentinel the SPA has to special-case). Instead the GET response carries `apiKeyConfigured: true` per block so the SPA can render "[stored — leave blank to keep]" without seeing the secret.
- `cleanupProviders["claude-code"].setupTokenStatus` is a `readOnly` enum (`configured | not-configured | expired | unknown`) populated per-request from `~/.claude.json`. The new `POST /admin/refresh-claude-token-status` endpoint re-reads the file and returns `{setupTokenStatus: ...}` — the SPA's Refresh button hits this.
- Cleanup provider rename: **`claude` → `anthropic`** (the Anthropic API path is now named after the credential, not the model family) plus the existing `claude-code` (Claude Code CLI / subscription). The schema's `cleanupProvider` enum drops `claude` entirely.
- Schema top-level `additionalProperties: false` enforced — typo'd field names on PUT now 400 rather than silently no-op.

#### Migration shim

- On config load (`loadConfig()` in `config.ts`), any `cleanup.provider === "claude"` is auto-rewritten to `"anthropic"`, the rewrite is persisted to disk (one-shot — idempotent across loads), and a one-line migration notice is logged. Existing operators don't have to touch their `config.json` for the next start.

#### Per-request API-key reads

- New `src/provider-config.ts` consolidates the resolved-config logic. Every provider (`transcribe/groq.ts`, `cleanup/anthropic.ts`, `cleanup/ollama.ts`, etc.) now reads its apiKey/model/url **per-call** via `getTranscribeProviderConfig(name)` / `getCleanupProviderConfig(name)`. Precedence: `config.json` > env > built-in default. Matches hub#298's `getHubOrigin` precedence shape.
- The "paste apiKey in SPA, click Save, next request uses the new value" UX claim is now load-bearing pinned by `provider-config.test.ts` — rewriting `config.json` between two `getTranscribeProviderConfig` calls returns the new value on the second call. No restart.

#### Graceful missing-provider

- `POST /v1/audio/transcriptions` on a fresh deploy with no transcribe provider configured returns `{error: "no transcription provider configured", error_code: "missing_provider"}` with status 400. Vault's auto-transcribe (vault#343) can branch on `error_code` to surface a `transcript_status: failed` note with a clean message.

#### Provider files

- `src/cleanup/claude.ts` → `src/cleanup/anthropic.ts` (git mv; module-scope export name follows). `providers.ts` registers the new name; the registry no longer carries `claude` at all.
- New `src/claude-token-status.ts` reads `~/.claude.json` (honors `CLAUDE_CONFIG_DIR`) and produces the four-value status enum. Permissive shape detection — looks for `oauthAccount.accessToken` / top-level `accessToken` / `tokens.<provider>.accessToken`; expired when an `expiresAt` is in the past.

#### Auth + scope

- `/.parachute/config*` and `/admin/refresh-claude-token-status` both gate on `scribe:admin`. Hub's `/api/modules/scribe/config*` mints a fresh `scribe:admin` JWT per-request (per hub#300) so this works through the SPA without exposing the master scope to scribe.

#### Tests

- 261/261 passing (was 204 baseline) — 57 new tests across:
  - `src/provider-config.test.ts` — precedence + per-request reads (live config-file rewrite test)
  - `src/claude-token-status.test.ts` — every status enum value path
  - `src/config-schema.test.ts` — new top-level structure, writeOnly/readOnly fields, $ref consolidation, `claude` enum removal
  - `src/config.test.ts` — migration shim (pure function + load round-trip + idempotence + log assertion)
  - `src/site-52-routes.test.ts` — wire-level GET omission, PUT omit-to-keep, refresh endpoint, missing-provider 400
- Typecheck clean. Biome clean.

#### Notes

- File on disk shape stays back-compat: pre-0.4.4 configs (no `transcribeProviders`/`cleanupProviders` blocks) keep working — providers fall through env+default for any unset value, same as before.
- `cleanupDefault` retains its name on the wire (the design doc's "additive — every existing field keeps its name" principle); `cleanupEnabled` is **not** introduced.
- The `apiKeyConfigured` boolean is new wire — surfaces "key stored, leave blank to keep" UX to the SPA without exposing the secret.

## [0.4.3] - 2026-05-20

Stable release. Cumulative changes since `0.4.2`:

- **Config UI at `/scribe/admin`** (#45): static admin form for the JSON config fields (transcribe.provider, cleanup.provider, cleanup.default, cleanup.system_prompt, cleanup.context_template). New `PUT /.parachute/config` endpoint (scope-gated on `scribe:admin`) with atomic write, schema validation, restart-required signaling. `0o600` file mode for forward-compatibility with the future secrets PR. Null-as-deletion-marker semantics for clearable string fields.

Secrets management (provider API keys, etc.) lands in a future scribe PR (PR-B per the design exploration).

## [0.4.3-rc.1] - 2026-05-20

### Added
- **Config UI: `PUT /.parachute/config` and a static admin form at `/scribe/admin`** — PR-A of the scribe config UI work. Operators can now read and write `~/.parachute/scribe/config.json` from a browser (through hub's reverse proxy) rather than hand-editing JSON.
  - `PUT /.parachute/config` accepts the same camelCase wire shape `GET /.parachute/config` returns, validates against the JSON Schema, and atomically writes the nested file shape to `~/.parachute/scribe/config.json` (tmp + rename — same pattern as `services-manifest.ts`). Scoped on `scribe:admin`.
  - Response carries `{ ok: true, restart_required: [...] }` — the array lists which fields changed in a way that needs a process restart to take effect (provider changes + port). Cleanup-prompt and cleanup-default changes take effect immediately because they're read dynamically per-request; the handler updates the in-process `scribeConfig.cleanup` block to match the new file.
  - `/scribe/admin` is a single self-contained HTML page (inline CSS + vanilla JS, no framework, no build step) that fetches schema + config on load, renders one form field per knob, and displays the restart-required list inline after save. Mirrors the "render a self-contained string from a TS function" pattern in `parachute-hub/src/oauth-ui.ts`.
- **`src/config-write.ts`** — schema validator (tiny purpose-built draft-07; no external dep), wire→file translator, **read-modify-write merger** that honors null-as-clear sentinels for the two optional string fields, restart-required differ, atomic writer.
- **`src/admin-ui.ts`** — `renderAdminPage()` returns the static HTML.

### Fixed (review folds on PR #45 before merge)
- **Null-clear no longer silently no-ops.** Clearing the system-prompt or context-template textarea in the form and saving used to write a file that still carried the old value — `toFileShape` dropped `null` before write, and "absent in patch" was indistinguishable from "leave alone." PUT handler now reads the existing file, merges the incoming patch (treating `null` as an explicit deletion), and writes the merged result. The in-process `scribeConfig.cleanup` is replaced (not spread) on success so the next transcription request actually sees the cleared field.
- **`config.json` is written with mode `0o600`.** Owner-only — preempts PR-B (secrets) accidentally landing world-readable provider keys on shared hosts. Rewrites preserve the mode even if someone chmod'd the file out-of-band.

### Nits folded
- Restart-required success banner now includes a footnote when `port` appears in the list: "Note: `port` is set via `services.json` or the `SCRIBE_PORT` environment variable, not `config.json`." Avoids the operator re-saving the form expecting the port change to stick.
- Inline JS in `admin-ui.ts` renames the `setBanner(kind, html)` parameter to `trustedHtml` so the "caller must have sanitized" contract is explicit at every call site.
- Removed a misleading "TS-friendly import shim" comment from `admin-routes.test.ts` — the import was just a plain alias.

### Notes
- 204/204 tests passing (`bun test src/`); typecheck clean.
- PR-A only: no secrets management (PR-B) and no hub-side "Configure" link in the admin SPA (PR-C).
- `port` is in the schema for visibility but not written to disk — scribe's port resolution (`port-resolve.ts`) reads from services.json and env, not config.json. A port change in the form still appears in `restart_required` so the operator knows to update the env/services.json side too.

## [0.4.2] - 2026-05-10

### Added
- **`@openparachute/scope-guard` 0.2.0 adoption — hub revocation list now enforced (hub#212 Phase 4).** Hub-issued JWTs are consulted against the hub's `/.well-known/parachute-revocation.json` after sig/iss/aud/expiry pass; revoked jtis surface as `HubJwtError(code: "revoked")` and are rejected at `validateToken` with a 401. Without this bump, operator revocation via the hub mint API was a no-op against scribe.
- **`resetRevocationCache`** re-export from `src/hub-jwt.ts` (mirrors `resetJwksCache`) so tests can start cases from a clean fail-closed state.
- **`src/auth-hub-jwt.test.ts`** — integration suite for the hub-JWT path. Pins: happy-path acceptance with active revocations on unrelated jtis, sanitized 401 + jti-bearing audit log on revoked rejection, sanitized 401 + implementation-detail-bearing audit log on cold-start revocation-endpoint outage. scope-guard's own unit suite covers cache mechanics; this file pins scribe-side wire-up.

### Changed
- **Sanitized client-facing 401 messages on revocation outcomes.** `code: "revoked"` returns `"token has been revoked"` (no jti); `code: "revocation_unavailable"` returns `"token cannot be validated: revocation list unavailable"` (no "no last-good cache" implementation detail). Full diagnostics — including the jti and the cache-state phrasing — route to `console.warn` for the operator audit trail. Inheritable pattern from vault PR #281; agent inherits next.

### Notes
- 133/133 tests passing (`bun test src/`); typecheck clean.
- Behavior summary from scope-guard 0.2.0: 60s TTL on the revocation cache (matches hub's published `Cache-Control: max-age=60`); fail-open with last-good cache during a hub outage; fail-closed only on first-fetch-failure (cold start, no last-good).
- Shared-secret + open-mode paths untouched. Existing JWT-shape rejection tests in `auth.test.ts` continue to pass — non-revocation `HubJwtError` codes (signature, audience, expired, etc.) still forward their messages verbatim.

## [0.4.1] - 2026-05-09

### Fixed
- **Boot now respects `services.json` port + uses canonical 1943 default** — closes #40. v0.4.0's boot read `SCRIBE_PORT ?? PORT ?? DEFAULT_PORT` and ignored any existing entry in `~/.parachute/services.json`, so a stale `PORT=1944` in scribe's `.env` (written by hub's port-assigner when 1943 looked occupied) caused scribe to bind 1944 and rewrite services.json to match — silently colliding with the agent slot. New precedence: `services.json` entry → `SCRIBE_PORT` env → `PORT` env → canonical `1943`. Operator-set ports persist across restarts; the canonical default is only used when no entry exists. Bind failure now logs a named, actionable error before the throw.

### Added
- `readServiceEntry(name, path?)` in `services-manifest.ts` — pure lookup so callers can read the existing entry without instantiating the upsert path.
- `port-resolve.ts` with `resolvePort(opts)` — pure, dependency-injected port resolver. Unit-tested across the precedence ladder + an integration suite that exercises the full read path against a real `services.json` under a tmp `PARACHUTE_HOME`.

### Notes
- 129/129 tests passing.
- Companion bugs tracked separately: parachute-hub#195 (hub-side validation + recovery tool — defense in depth), parachute-agent#145 (agent has the same shape — port-rewrite on boot).

## 0.4.0 (2026-05-05)

First @latest release since 0.3.0. Hardens auth, adopts the shared scope-guard kernel, and ships module-protocol conformance.

### Added
- **`@openparachute/scope-guard` adoption** — JWT validation now goes through the shared kernel (mirrors vault PR #212). `validateHubJwt`, `resetJwksCache`, `looksLikeJwt`, `HubJwtError`, `HubJwtClaims` re-exported so callers don't change. Lib's richer claim shape (`aud`, `jti`, `clientId`) is additive — available for future logging/introspection. (#33)
- **`.parachute/module.json`** — canonical short-name (`name: scribe`, `manifestName: parachute-scribe`) per module-protocol design. (#29)
- **DoS caps** on request handling. (#29)
- **`installDir` preservation** across config migrations. (#29)

### Changed
- **Scope enforcement bundle** — formal scope checks at the auth boundary. Closes #25, #26, #27, #28. (#29)
- **Timing-safe shared-secret compare** — replaced naive equality with constant-time `constantTimeStringEqual`. Closes #30, #31. (#32)
- **Direct `jose` dep dropped** — now transitive via scope-guard. (#33)

### Notes
- 107/107 tests passing on main.
- Targeting npm `@latest` after merge.

## 0.3.1 (2026-04-23)

- docs: update `parachute-cli` references to `parachute-hub`. (#23)

## 0.3.0 (2026-04-23)

- feat!: remove `vault.ts` backchannel — push-only context. (#22)
- feat: user-configurable cleanup prompt. (#21)
- feat: context-in-payload + `vault.mode` config. (#20)
- feat: add `claude-code` cleanup provider. (#19)
