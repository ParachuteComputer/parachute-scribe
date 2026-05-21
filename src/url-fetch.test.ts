/**
 * Unit tests for the SSRF-safe URL fetcher.
 *
 * Network behavior is exercised against a `Bun.serve()` instance bound
 * to 127.0.0.1 with `SKIP_SSRF_FOR_TESTS=1` opting the blocklist out
 * for that one address — otherwise every test would deadlock on the
 * loopback guard.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  UrlFetchError,
  fileNameFromUrl,
  isBlockedAddress,
  parseAndValidateUrl,
} from "./url-fetch.ts";

describe("parseAndValidateUrl", () => {
  test("accepts http/https URLs to public-looking hostnames", () => {
    const u = parseAndValidateUrl("https://example.com/audio.mp3");
    expect(u.hostname).toBe("example.com");
  });

  test("rejects file:// scheme", () => {
    expect(() => parseAndValidateUrl("file:///etc/passwd")).toThrow(UrlFetchError);
  });

  test("rejects data:// scheme", () => {
    expect(() => parseAndValidateUrl("data:audio/wav;base64,xxx")).toThrow(UrlFetchError);
  });

  test("rejects gopher://", () => {
    expect(() => parseAndValidateUrl("gopher://example.com/")).toThrow(UrlFetchError);
  });

  test("rejects 'localhost'", () => {
    expect(() => parseAndValidateUrl("http://localhost:1939/path")).toThrow(UrlFetchError);
  });

  test("rejects '*.localhost'", () => {
    expect(() => parseAndValidateUrl("http://api.localhost/path")).toThrow(UrlFetchError);
  });

  test("rejects IP literal 127.0.0.1", () => {
    expect(() => parseAndValidateUrl("http://127.0.0.1:1939/path")).toThrow(UrlFetchError);
  });

  test("rejects IP literal 0.0.0.0", () => {
    expect(() => parseAndValidateUrl("http://0.0.0.0/")).toThrow(UrlFetchError);
  });

  test("rejects IP literal 10.0.0.5 (private)", () => {
    expect(() => parseAndValidateUrl("http://10.0.0.5/")).toThrow(UrlFetchError);
  });

  test("rejects IP literal 192.168.1.1 (private)", () => {
    expect(() => parseAndValidateUrl("http://192.168.1.1/")).toThrow(UrlFetchError);
  });

  test("rejects IP literal 172.16.0.1 (private)", () => {
    expect(() => parseAndValidateUrl("http://172.16.0.1/")).toThrow(UrlFetchError);
  });

  test("rejects IP literal 169.254.169.254 (AWS metadata)", () => {
    expect(() => parseAndValidateUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
      UrlFetchError,
    );
  });

  test("rejects IP literal in CG-NAT range (100.64.0.1)", () => {
    expect(() => parseAndValidateUrl("http://100.64.0.1/")).toThrow(UrlFetchError);
  });

  test("rejects multicast (224.0.0.1)", () => {
    expect(() => parseAndValidateUrl("http://224.0.0.1/")).toThrow(UrlFetchError);
  });

  test("rejects IPv6 loopback ([::1])", () => {
    expect(() => parseAndValidateUrl("http://[::1]/")).toThrow(UrlFetchError);
  });

  test("rejects IPv6 link-local ([fe80::1])", () => {
    expect(() => parseAndValidateUrl("http://[fe80::1]/")).toThrow(UrlFetchError);
  });

  test("rejects IPv4-mapped-IPv6 loopback ([::ffff:127.0.0.1])", () => {
    expect(() => parseAndValidateUrl("http://[::ffff:127.0.0.1]/")).toThrow(UrlFetchError);
  });

  test("accepts a public IPv4 literal (8.8.8.8)", () => {
    const u = parseAndValidateUrl("http://8.8.8.8/audio.mp3");
    expect(u.hostname).toBe("8.8.8.8");
  });

  test("invalid URL string throws invalid_url", () => {
    try {
      parseAndValidateUrl("not a url");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UrlFetchError);
      expect((err as UrlFetchError).code).toBe("invalid_url");
    }
  });
});

describe("isBlockedAddress", () => {
  test("v4 loopback ranges", () => {
    expect(isBlockedAddress("127.0.0.1", 4)).toBe(true);
    expect(isBlockedAddress("127.255.255.254", 4)).toBe(true);
  });
  test("v4 public ranges pass", () => {
    expect(isBlockedAddress("8.8.8.8", 4)).toBe(false);
    expect(isBlockedAddress("1.1.1.1", 4)).toBe(false);
    expect(isBlockedAddress("104.18.0.1", 4)).toBe(false); // Cloudflare-ish
  });
  test("v6 loopback / unspecified", () => {
    expect(isBlockedAddress("::1", 6)).toBe(true);
    expect(isBlockedAddress("::", 6)).toBe(true);
  });
  test("v6 unique-local", () => {
    expect(isBlockedAddress("fc00::1", 6)).toBe(true);
    expect(isBlockedAddress("fd12:3456::1", 6)).toBe(true);
  });
  test("v6 public passes", () => {
    expect(isBlockedAddress("2606:4700:4700::1111", 6)).toBe(false);
  });
});

describe("fileNameFromUrl", () => {
  test("derives basename from URL path", () => {
    expect(fileNameFromUrl(new URL("https://example.com/x/recording.mp3"), "audio/mpeg")).toBe(
      "recording.mp3",
    );
  });
  test("falls back to content-type extension when path has no name", () => {
    expect(fileNameFromUrl(new URL("https://example.com/"), "audio/wav")).toBe("transcribe.wav");
  });
  test("falls back to generic when content-type also missing", () => {
    expect(fileNameFromUrl(new URL("https://example.com/"), null)).toBe("transcribe.audio");
  });
  test("normalizes audio/mpeg → mp3 in filename", () => {
    expect(fileNameFromUrl(new URL("https://example.com/"), "audio/mpeg")).toBe(
      "transcribe.mp3",
    );
  });
});

// ---------------------------------------------------------------------------
// Network-touching fetch tests.
//
// We spin up two Bun.serve() instances on 127.0.0.1 and re-enter the
// fetcher with PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK=1 (an
// undocumented test-only escape so the SSRF guards stay otherwise
// strict). The fetcher module is loaded fresh per test block so the env
// flag is honored at the right time — but the implementation reads it
// dynamically per-call, so simpler than that, it works inline.
// ---------------------------------------------------------------------------

describe("fetchAudioFromUrl", () => {
  let originServer: ReturnType<typeof Bun.serve> | null = null;
  let originPort = 0;
  let originalLoopbackFlag: string | undefined;

  // We monkey-patch the loopback IP guards by injecting a tiny env-driven
  // bypass via a wrapper that calls into the real validator with a fake
  // hostname rewrite. The cleanest approach: the test server binds to
  // 127.0.0.1 and the fetcher's isBlockedV4 rejects that — so for these
  // network tests we set an env var the fetcher honors to skip the
  // loopback check ONLY when explicitly opted in. Implement that opt-in
  // in url-fetch.ts via PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK=1.
  beforeAll(() => {
    originalLoopbackFlag = process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK;
    process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK = "1";
    originServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/ok.mp3") {
          return new Response(new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0, 0, 0]), {
            headers: { "Content-Type": "audio/mpeg" },
          });
        }
        if (url.pathname === "/big-declared.mp3") {
          // Declared larger than the cap via an explicit Content-Length
          // header that exceeds MAX_URL_AUDIO_BYTES. The fetcher must
          // reject before reading any body.
          return new Response(new Uint8Array(8), {
            headers: {
              "Content-Type": "audio/mpeg",
              "Content-Length": String(200 * 1024 * 1024),
            },
          });
        }
        if (url.pathname === "/big-chunked") {
          // No Content-Length; stream more than 100MB in chunks. We test a
          // smaller cap by setting SCRIBE_URL_MAX_BYTES per-test, but the
          // default cap also catches this.
          const huge = new Uint8Array(1024 * 1024); // 1 MiB each
          let sent = 0;
          const stream = new ReadableStream({
            pull(controller) {
              if (sent >= 105) {
                controller.close();
                return;
              }
              controller.enqueue(huge);
              sent++;
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "audio/mpeg" },
          });
        }
        if (url.pathname === "/notaudio.html") {
          return new Response("<html>hi</html>", {
            headers: { "Content-Type": "text/html" },
          });
        }
        if (url.pathname === "/octet-with-mp3-ext.mp3") {
          // application/octet-stream + a .mp3 extension should pass the
          // permissive audio-ish gate via extension fallback.
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    originPort = originServer.port ?? 0;
  });

  afterAll(() => {
    originServer?.stop();
    if (originalLoopbackFlag === undefined)
      delete process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK;
    else process.env.PARACHUTE_SCRIBE_URL_FETCH_ALLOW_LOOPBACK = originalLoopbackFlag;
  });

  test("happy path — audio/mpeg from loopback returns File", async () => {
    const { fetchAudioFromUrl } = await import("./url-fetch.ts");
    const r = await fetchAudioFromUrl(`http://127.0.0.1:${originPort}/ok.mp3`);
    expect(r.file).toBeInstanceOf(File);
    expect(r.file.name).toBe("ok.mp3");
    expect(r.file.type).toBe("audio/mpeg");
    expect(r.bytes).toBe(8);
  });

  test("non-audio content-type → 415 'not_audio'", async () => {
    const { fetchAudioFromUrl, UrlFetchError } = await import("./url-fetch.ts");
    try {
      await fetchAudioFromUrl(`http://127.0.0.1:${originPort}/notaudio.html`);
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(UrlFetchError);
      expect((err as InstanceType<typeof UrlFetchError>).code).toBe("not_audio");
      expect((err as InstanceType<typeof UrlFetchError>).status).toBe(415);
    }
  });

  test("octet-stream with .mp3 extension passes the audio-ish gate", async () => {
    const { fetchAudioFromUrl } = await import("./url-fetch.ts");
    const r = await fetchAudioFromUrl(`http://127.0.0.1:${originPort}/octet-with-mp3-ext.mp3`);
    expect(r.bytes).toBe(4);
  });

  test("chunked oversize body → mid-stream 'too_large'", async () => {
    const { fetchAudioFromUrl, UrlFetchError } = await import("./url-fetch.ts");
    try {
      await fetchAudioFromUrl(`http://127.0.0.1:${originPort}/big-chunked`);
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(UrlFetchError);
      expect((err as InstanceType<typeof UrlFetchError>).code).toBe("too_large");
      expect((err as InstanceType<typeof UrlFetchError>).status).toBe(413);
    }
  });

  test("404 → fetch_failed (502)", async () => {
    const { fetchAudioFromUrl, UrlFetchError } = await import("./url-fetch.ts");
    try {
      await fetchAudioFromUrl(`http://127.0.0.1:${originPort}/missing.mp3`);
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(UrlFetchError);
      expect((err as InstanceType<typeof UrlFetchError>).code).toBe("fetch_failed");
    }
  });

  test("redirect to blocked host → blocked_host", async () => {
    // Spin a second origin that 302s to 127.0.0.1 — but since BOTH are
    // loopback and we've allow-flagged loopback, the redirect target
    // would pass. Test the inverse: redirect from the loopback origin to
    // a non-allowed loopback (192.168.x.x literal which is private).
    const redirectServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://192.168.99.99/audio.mp3" },
        });
      },
    });
    try {
      const { fetchAudioFromUrl } = await import("./url-fetch.ts");
      await fetchAudioFromUrl(`http://127.0.0.1:${redirectServer.port}/redirect.mp3`);
      throw new Error("should have rejected");
    } catch (err) {
      // The thrown UrlFetchError may not pass instanceof when classes are
      // re-imported across `await import(...)` calls — check the shape
      // via `.code` instead.
      expect((err as { code?: string }).code).toBe("blocked_host");
    } finally {
      redirectServer.stop();
    }
  });
});
