/**
 * Resolve the hostname scribe's HTTP server binds to.
 *
 * Default is `127.0.0.1` — loopback-only at the socket level. This is a
 * defense-in-depth default: the canonical topology reaches scribe over
 * loopback already (the hub proxies `/<mount>/*` from :1939 → scribe on the
 * same host; vault's transcription worker calls `http://127.0.0.1:1943`), so
 * loopback-by-default breaks neither documented path. The previous
 * `0.0.0.0` bind exposed scribe on every interface — combined with the
 * formerly-open auth gate (config token not bridged to the check), a
 * LAN/exposed box let anyone reach `/v1/audio/transcriptions`, the admin
 * routes, and `/mcp` with no credential. See scribe#66.
 *
 * Escape hatch: `SCRIBE_BIND`. Set to `0.0.0.0` for Docker bridge networking
 * or an intentional LAN setup; set to a specific interface IP for a
 * multi-homed host. Empty / whitespace values are treated as unset.
 *
 * Mirrors `parachute-vault`'s `VAULT_BIND` loopback-default (its
 * `src/bind.ts:resolveBindHostname`) so the two committed-core daemons share
 * the same bind story.
 */
export function resolveBindHostname(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SCRIBE_BIND?.trim();
  if (override) return override;
  return "127.0.0.1";
}
