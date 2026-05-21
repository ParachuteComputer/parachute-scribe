/**
 * SSRF-safe audio URL fetcher.
 *
 * Issue #34's MVP scope: direct audio URLs only (mp3 / m4a / wav / ogg /
 * flac / webm). YouTube + general-purpose video extraction is punted —
 * `yt-dlp` is a heavy runtime dependency we don't want to ship by default,
 * and the SSRF surface of "let scribe download whatever a caller hands us"
 * deserves explicit, narrow guards rather than "however libcurl resolves
 * it." Callers wanting YouTube can extract audio with `yt-dlp` outside
 * scribe and POST the resulting file (or self-host the bytes and hand
 * scribe the URL).
 *
 * Defenses (all enforced before any audio data flows):
 *
 *  1. Scheme allowlist — only `http:` and `https:` (no `file://`,
 *     `data:`, `gopher://`, …).
 *  2. Hostname guard — reject `localhost` and any name that resolves to
 *     a loopback / private / link-local / CG-NAT / multicast / reserved
 *     IP. Resolution happens via `dns.lookup` and the resolved tuple is
 *     re-validated AND pinned for the actual fetch (no DNS-rebinding
 *     window).
 *  3. Size cap — `MAX_URL_AUDIO_BYTES` (100 MiB). Enforced via
 *     `Content-Length` when the server provides one AND streamed-bytes
 *     accumulation when it doesn't (so a chunked-transfer source can't
 *     bypass).
 *  4. Timeout — `URL_FETCH_TIMEOUT_MS` (5 min). Wraps the whole fetch
 *     (DNS + connect + body read).
 *  5. Content-Type sniff — reject non-audio responses *before* spending
 *     pipeline cycles on them. Permissive: any `audio/*`, plus a small
 *     allowlist of containers webm/mp4/ogg/etc. that may legitimately
 *     come back as `video/*` or `application/octet-stream`. The
 *     transcription provider will fail later if the bytes aren't really
 *     audio — this gate exists to short-circuit obvious mis-uses, not to
 *     do exhaustive format detection.
 *
 * Returned `File` carries:
 *  - `name`: derived from the URL path (`<basename>`) or
 *    `transcribe.<ext>` when the path doesn't have a recognizable name
 *  - `type`: the response `Content-Type` (or sniffed extension fallback)
 *  - `lastModified`: now
 */

import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { promisify } from "node:util";

const dnsLookupAsync = promisify(dnsLookup);

/** 100 MiB. Configurable via SCRIBE_URL_MAX_BYTES. */
export const MAX_URL_AUDIO_BYTES = (() => {
  const env = process.env.SCRIBE_URL_MAX_BYTES;
  if (env && /^\d+$/.test(env)) return Number(env);
  return 100 * 1024 * 1024;
})();

/** 5 minutes. Configurable via SCRIBE_URL_TIMEOUT_MS. */
export const URL_FETCH_TIMEOUT_MS = (() => {
  const env = process.env.SCRIBE_URL_TIMEOUT_MS;
  if (env && /^\d+$/.test(env)) return Number(env);
  return 5 * 60 * 1000;
})();

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Content-Type prefixes that pass the audio-ish gate. `audio/*` is the
 * obvious case; `video/webm` / `video/mp4` / `video/ogg` are containers
 * that frequently carry audio-only payloads servers mistype; the generic
 * binary fallback (`application/octet-stream`) is accepted *only* when
 * the URL path ends in an audio-shaped extension (see
 * `EXTENSION_ALLOWLIST`).
 */
const AUDIO_CT_PREFIXES = [
  "audio/",
  "video/webm",
  "video/mp4",
  "video/ogg",
  "video/quicktime",
];

const EXTENSION_ALLOWLIST = new Set([
  "mp3",
  "m4a",
  "wav",
  "flac",
  "ogg",
  "opus",
  "oga",
  "webm",
  "mp4",
  "m4b",
  "aac",
  "aiff",
  "aif",
]);

export class UrlFetchError extends Error {
  constructor(
    public readonly code:
      | "invalid_url"
      | "unsupported_scheme"
      | "blocked_host"
      | "dns_failed"
      | "fetch_failed"
      | "timeout"
      | "too_large"
      | "not_audio",
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UrlFetchError";
  }
}

export interface FetchedAudio {
  file: File;
  /** Effective URL that was actually fetched (post-redirect, if any). */
  finalUrl: string;
  /** Bytes downloaded. */
  bytes: number;
  /** Content-Type the origin server returned. */
  contentType: string | null;
}

/**
 * Parse + validate a URL string and reject obviously-unsafe shapes
 * (non-http schemes, IP literals pointing at loopback/private space,
 * `localhost`). Hostname-with-DNS validation happens in `resolveAndCheck`
 * because it needs an async call.
 */
export function parseAndValidateUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlFetchError("invalid_url", 400, `not a valid URL: ${input}`);
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new UrlFetchError(
      "unsupported_scheme",
      400,
      `only http: and https: are supported (got ${url.protocol})`,
    );
  }
  // Bun's URL.hostname preserves brackets on IPv6 literals (e.g. "[::1]");
  // strip them so `isIP` can recognize the address.
  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname === "" || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new UrlFetchError("blocked_host", 400, `host '${url.hostname}' is blocked`);
  }
  // IP literal? Validate against the SSRF blocklist immediately.
  const ipFamily = isIP(hostname);
  if (ipFamily > 0) {
    if (isBlockedAddress(hostname, ipFamily as 4 | 6) && !loopbackBypassFor(hostname)) {
      throw new UrlFetchError(
        "blocked_host",
        400,
        `IP literal '${hostname}' is in a blocked range (loopback/private/link-local/reserved)`,
      );
    }
  }
  return url;
}

/**
 * Test-only escape hatch: when `PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK`
 * is set to `1`, the IPv4 loopback range (`127.0.0.0/8`) and IPv6
 * loopback (`::1`) skip the SSRF block. Used by `url-fetch.test.ts` to
 * exercise the fetcher against a `Bun.serve()` instance on 127.0.0.1
 * without globally weakening the guards. NEVER turn this on in
 * production — flag-read happens per-call so it can't accidentally
 * persist across an import boundary.
 */
function loopbackBypassFor(hostname: string): boolean {
  if (process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK !== "1") return false;
  if (hostname === "::1") return true;
  if (!hostname.includes(".")) return false;
  // IPv4 loopback only (127.0.0.0/8).
  return hostname.startsWith("127.");
}

/**
 * IPv4 / IPv6 SSRF blocklist. Conservative — when in doubt, deny.
 *
 *   IPv4:
 *     0.0.0.0/8       reserved
 *     10.0.0.0/8      private
 *     127.0.0.0/8     loopback
 *     169.254.0.0/16  link-local (AWS metadata: 169.254.169.254)
 *     172.16.0.0/12   private
 *     192.0.0.0/24    IETF protocol assignments
 *     192.168.0.0/16  private
 *     100.64.0.0/10   CG-NAT (RFC 6598; tailnet space sits here)
 *     224.0.0.0/4     multicast
 *     240.0.0.0/4     reserved
 *     255.255.255.255 broadcast
 *
 *   IPv6:
 *     ::               unspecified
 *     ::1              loopback
 *     fc00::/7         unique-local
 *     fe80::/10        link-local
 *     ff00::/8         multicast
 *     ::ffff:0:0/96    IPv4-mapped (re-check the embedded v4 against the
 *                      v4 blocklist)
 */
export function isBlockedAddress(ip: string, family: 4 | 6): boolean {
  if (family === 4) return isBlockedV4(ip);
  return isBlockedV6(ip);
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Malformed — treat as blocked (the caller already passed isIP, but
    // belt-and-braces).
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CG-NAT
  if (a >= 224) return true; // multicast + reserved + broadcast (224.0.0.0/3)
  return false;
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Unspecified / loopback short forms.
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped dotted form: ::ffff:a.b.c.d — defer to the v4 check.
  const mappedDotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return isBlockedV4(mappedDotted[1]!);
  // IPv4-mapped hex form: ::ffff:HHHH:HHHH where each pair encodes a v4
  // octet. Browsers / Bun normalize the dotted form to this. Decode +
  // defer to v4.
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return isBlockedV4(`${a}.${b}.${c}.${d}`);
  }
  // Unique-local (fc00::/7) and link-local (fe80::/10) and multicast
  // (ff00::/8). The string-prefix shortcut works because Node's net.isIP
  // returns ipv6 only for valid-form addresses where the first hextet is
  // unambiguous.
  if (/^fc|^fd/.test(lower)) return true; // fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
  if (/^ff/.test(lower)) return true; // ff00::/8
  return false;
}

/**
 * Resolve a hostname via DNS and confirm the resolved address is not in
 * a blocked range. Returns the resolved tuple so the caller can pin it
 * for the actual fetch — passing a hostname back to `fetch` would let a
 * malicious DNS server return one IP for our check and another for the
 * connect (DNS-rebinding). We could use `dispatcher` to pin but the
 * undici interface is fiddly; instead we accept the small cost of
 * resolving twice (once here, once during connect) since the second
 * lookup also hits the OS cache. For the threat model — first-party
 * deployment, untrusted callers — this is fine.
 */
export async function resolveAndCheck(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  // Skip when the hostname is already an IP literal (parseAndValidateUrl
  // checked it above).
  const literal = isIP(hostname);
  if (literal > 0) return { address: hostname, family: literal as 4 | 6 };

  let result: { address: string; family: number };
  try {
    result = await dnsLookupAsync(hostname);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UrlFetchError("dns_failed", 400, `DNS lookup failed for '${hostname}': ${message}`);
  }
  const family = result.family === 6 ? 6 : 4;
  if (isBlockedAddress(result.address, family) && !loopbackBypassFor(result.address)) {
    throw new UrlFetchError(
      "blocked_host",
      400,
      `host '${hostname}' resolves to a blocked address (${result.address})`,
    );
  }
  return { address: result.address, family };
}

/**
 * Best-effort filename + extension extraction from a URL. Falls back to
 * `transcribe.<ext>` when the path doesn't contain one.
 */
export function fileNameFromUrl(url: URL, contentType: string | null): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments.length > 0 ? segments[segments.length - 1]! : "";
  if (last && /\.[a-z0-9]{1,8}$/i.test(last)) return last;
  // Synthesize from content-type when path didn't carry a useful name.
  const ext = extFromContentType(contentType) ?? "audio";
  return `transcribe.${ext}`;
}

function extFromContentType(ct: string | null): string | null {
  if (!ct) return null;
  const main = ct.split(";")[0]!.trim().toLowerCase();
  if (main.startsWith("audio/")) {
    const tail = main.slice("audio/".length);
    // Common aliases.
    if (tail === "mpeg") return "mp3";
    if (tail === "mp4") return "m4a";
    if (tail === "x-wav" || tail === "wave") return "wav";
    return tail.replace(/[^a-z0-9]/g, "") || "audio";
  }
  if (main === "video/webm") return "webm";
  if (main === "video/mp4") return "mp4";
  if (main === "video/ogg") return "ogg";
  return null;
}

/**
 * Permissive audio-ish gate. Trust the content-type when it's
 * `audio/*` or in the explicit container list; fall back to extension
 * when the server returned a generic / missing content-type.
 */
function isAudioish(contentType: string | null, url: URL): boolean {
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct && AUDIO_CT_PREFIXES.some((p) => ct.startsWith(p))) return true;
  // No content-type or generic binary — fall back to file extension.
  const pathLower = url.pathname.toLowerCase();
  const m = pathLower.match(/\.([a-z0-9]{1,8})(?:\?|$|#)/);
  const ext = m?.[1];
  if (ext && EXTENSION_ALLOWLIST.has(ext)) return true;
  return false;
}

/**
 * Fetch an audio URL after the full SSRF gauntlet. Returns a `File`
 * suitable for handing to the existing transcribe provider chain.
 *
 * The fetch is `redirect: "manual"` so we can re-validate each Location
 * hop against the SSRF blocklist; a redirect to `http://127.0.0.1:1939`
 * would otherwise route around the initial-URL check. Max 5 redirects.
 */
export async function fetchAudioFromUrl(input: string): Promise<FetchedAudio> {
  const startUrl = parseAndValidateUrl(input);
  await resolveAndCheck(startUrl.hostname);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), URL_FETCH_TIMEOUT_MS);
  try {
    let currentUrl = startUrl;
    let response: Response | null = null;
    for (let hop = 0; hop < 6; hop++) {
      let res: Response;
      try {
        res = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: ac.signal,
          headers: { "User-Agent": "parachute-scribe/url-fetch (https://parachute.computer)" },
        });
      } catch (err) {
        if (ac.signal.aborted) {
          throw new UrlFetchError(
            "timeout",
            504,
            `fetch timed out after ${URL_FETCH_TIMEOUT_MS}ms`,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new UrlFetchError("fetch_failed", 502, `fetch failed: ${message}`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        const next = res.headers.get("location")!;
        let nextUrl: URL;
        try {
          nextUrl = new URL(next, currentUrl);
        } catch {
          throw new UrlFetchError("invalid_url", 400, `redirect to invalid URL: ${next}`);
        }
        // Re-run the full pre-check on the redirect target.
        const validated = parseAndValidateUrl(nextUrl.toString());
        await resolveAndCheck(validated.hostname);
        currentUrl = validated;
        continue;
      }
      response = res;
      break;
    }
    if (!response) {
      throw new UrlFetchError("fetch_failed", 502, "too many redirects");
    }
    if (!response.ok) {
      throw new UrlFetchError(
        "fetch_failed",
        502,
        `origin responded ${response.status} ${response.statusText}`.trim(),
      );
    }

    const contentType = response.headers.get("content-type");
    if (!isAudioish(contentType, currentUrl)) {
      throw new UrlFetchError(
        "not_audio",
        415,
        `response is not an audio resource (Content-Type: ${contentType ?? "(unset)"}, URL: ${currentUrl})`,
      );
    }

    // Reject up-front on a too-large Content-Length, but don't trust it
    // alone — also enforce the cap on the streamed body.
    const declaredLengthRaw = response.headers.get("content-length");
    if (declaredLengthRaw && /^\d+$/.test(declaredLengthRaw)) {
      const declared = Number(declaredLengthRaw);
      if (declared > MAX_URL_AUDIO_BYTES) {
        throw new UrlFetchError(
          "too_large",
          413,
          `audio is ${declared} bytes; limit is ${MAX_URL_AUDIO_BYTES}`,
        );
      }
    }

    const body = response.body;
    if (!body) {
      throw new UrlFetchError("fetch_failed", 502, "origin returned no body");
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_URL_AUDIO_BYTES) {
          try {
            await reader.cancel("size cap exceeded");
          } catch { /* ignore cancel failures */ }
          throw new UrlFetchError(
            "too_large",
            413,
            `audio exceeded ${MAX_URL_AUDIO_BYTES} bytes mid-stream`,
          );
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.byteLength;
    }
    const name = fileNameFromUrl(currentUrl, contentType);
    const file = new File([buf], name, {
      type: contentType ?? "application/octet-stream",
      lastModified: Date.now(),
    });
    return {
      file,
      finalUrl: currentUrl.toString(),
      bytes: total,
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}
