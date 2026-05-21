/**
 * Mount-prefix normalization + stripping.
 *
 * Mirrors the convention notes-serve / parachute-agent already use: the
 * service accepts a `--mount <prefix>` flag, normalizes it once at boot,
 * and strips it from every inbound request's pathname before the route
 * table fires. This way the route table is canonically defined at root
 * (e.g. `/health`, `/v1/audio/transcriptions`) regardless of where the
 * reverse proxy mounts the service externally.
 *
 * Default `""` (empty) preserves the legacy "bare routes at the origin
 * root" shape — scribe v0.4.4-rc.2 and earlier never accepted a mount
 * flag, so this is the back-compat path. Passing `--mount /` is
 * equivalent.
 *
 * Issue #39 — accept --mount flag for prefix-stripping (uniform with
 * notes-serve / agent).
 */

/**
 * Canonicalize a `--mount <raw>` argument. Empty string and `"/"` both
 * collapse to `""` (no prefix). Otherwise:
 *
 *   - Trailing slashes are stripped (so `/scribe/` → `/scribe`).
 *   - A missing leading slash is auto-prepended (so `scribe` → `/scribe`).
 *
 * The trailing-slash and missing-leading-slash fixups mirror notes-serve's
 * `normalizeMount` semantics; consistent normalization across the
 * ecosystem means operators don't need to memorize per-module shape rules.
 */
export function normalizeMount(raw: string): string {
  if (raw === "" || raw === "/") return "";
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.replace(/\/+$/, "");
}

/**
 * Strip `mount` from the front of `pathname`.
 *
 *   - When `mount` is `""` (no prefix configured), returns `pathname`
 *     unchanged. This is the default — every existing scribe deployment
 *     hits this branch.
 *   - When `mount` is non-empty and `pathname` matches it exactly OR is
 *     followed by `/`, returns the un-prefixed remainder (always at least
 *     `"/"`).
 *   - When `mount` is non-empty and `pathname` does NOT have the mount as
 *     a prefix, returns `null` — the caller should respond 404. This
 *     prevents `--mount /scribe`-deployed scribe from serving requests
 *     for `/health` that bypass the configured mount.
 */
export function stripMount(pathname: string, mount: string): string | null {
  if (mount === "") return pathname;
  if (pathname === mount) return "/";
  if (pathname.startsWith(`${mount}/`)) {
    return pathname.slice(mount.length) || "/";
  }
  return null;
}
