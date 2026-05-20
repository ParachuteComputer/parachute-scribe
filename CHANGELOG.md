# Changelog

## [0.4.3-rc.1] - 2026-05-20

### Added
- **Config UI: `PUT /.parachute/config` and a static admin form at `/scribe/admin`** — PR-A of the scribe config UI work. Operators can now read and write `~/.parachute/scribe/config.json` from a browser (through hub's reverse proxy) rather than hand-editing JSON.
  - `PUT /.parachute/config` accepts the same camelCase wire shape `GET /.parachute/config` returns, validates against the JSON Schema, and atomically writes the nested file shape to `~/.parachute/scribe/config.json` (tmp + rename — same pattern as `services-manifest.ts`). Scoped on `scribe:admin`.
  - Response carries `{ ok: true, restart_required: [...] }` — the array lists which fields changed in a way that needs a process restart to take effect (provider changes + port). Cleanup-prompt and cleanup-default changes take effect immediately because they're read dynamically per-request; the handler updates the in-process `scribeConfig.cleanup` block to match the new file.
  - `/scribe/admin` is a single self-contained HTML page (inline CSS + vanilla JS, no framework, no build step) that fetches schema + config on load, renders one form field per knob, and displays the restart-required list inline after save. Mirrors the "render a self-contained string from a TS function" pattern in `parachute-hub/src/oauth-ui.ts`.
- **`src/config-write.ts`** — schema validator (tiny purpose-built draft-07; no external dep), wire→file translator, restart-required differ, atomic writer.
- **`src/admin-ui.ts`** — `renderAdminPage()` returns the static HTML.

### Notes
- 180/180 tests passing (`bun test src/`); typecheck clean.
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
