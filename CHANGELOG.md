# Changelog

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
