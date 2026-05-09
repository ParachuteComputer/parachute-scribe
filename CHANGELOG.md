# Changelog

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
