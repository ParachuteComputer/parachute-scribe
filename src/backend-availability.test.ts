/**
 * Unit tests for per-backend availability detection.
 *
 * All side-effecting probes (`Bun.which`, ollama reachability, the
 * setup-token reader) go through injectable seams so these tests are fully
 * hermetic — they never touch the host PATH, network, or `~/.claude.json`.
 */
import { describe, expect, test } from "bun:test";
import {
  computeBackendAvailability,
  type WhichFn,
  type ReachFn,
  type ClaudeProbeFn,
} from "./backend-availability.ts";
import type { ScribeConfig } from "./config.ts";
import type { SetupTokenStatus } from "./config-schema.ts";

/** A which that reports the given set of bins as present, everything else absent. */
function whichWith(present: string[]): WhichFn {
  const set = new Set(present);
  return (bin) => (set.has(bin) ? `/usr/local/bin/${bin}` : null);
}

const reachableTrue: ReachFn = async () => true;
const reachableFalse: ReachFn = async () => false;

function tokenStatus(s: SetupTokenStatus): () => SetupTokenStatus {
  return () => s;
}

const EMPTY_CONFIG: ScribeConfig = {};
const NO_ENV: Record<string, string | undefined> = {};

describe("computeBackendAvailability — transcription binaries", () => {
  test("onnx-asr missing → unavailable with pip install + ffmpeg fix", async () => {
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.transcribe["onnx-asr"]!;
    expect(v.status).toBe("unavailable");
    expect(v.detail).toContain("onnx-asr");
    expect(v.fix).toContain("pip install onnx-asr");
    // ffmpeg note appended since ffmpeg also absent.
    expect(v.fix).toContain("ffmpeg");
  });

  test("onnx-asr present but ffmpeg missing → warning naming ffmpeg", async () => {
    const report = await computeBackendAvailability({
      which: whichWith(["onnx-asr"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.transcribe["onnx-asr"]!;
    expect(v.status).toBe("warning");
    expect(v.detail).toContain("ffmpeg");
    expect(v.fix).toContain("ffmpeg");
  });

  test("onnx-asr + ffmpeg both present → available", async () => {
    const report = await computeBackendAvailability({
      which: whichWith(["onnx-asr", "ffmpeg"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    expect(report.transcribe["onnx-asr"]!.status).toBe("available");
  });

  test("whisper backend checks the whisper-ctranslate2 binary (not bare `whisper`)", async () => {
    // Bare `whisper` present must NOT satisfy the whisper backend — the impl
    // shells to `whisper-ctranslate2`.
    const report = await computeBackendAvailability({
      which: whichWith(["whisper"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.transcribe["whisper"]!;
    expect(v.status).toBe("unavailable");
    expect(v.fix).toContain("whisper-ctranslate2");
  });

  test("parakeet-mlx missing → unavailable with install hint", async () => {
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.transcribe["parakeet-mlx"]!;
    expect(v.status).toBe("unavailable");
    expect(v.fix).toContain("parakeet-mlx");
  });

  test("parakeet-mlx present but ffmpeg missing → warning naming ffmpeg (needsFfmpeg flag, was unchecked before)", async () => {
    const report = await computeBackendAvailability({
      which: whichWith(["parakeet-mlx"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.transcribe["parakeet-mlx"]!;
    expect(v.status).toBe("warning");
    expect(v.detail).toContain("ffmpeg");
    expect(v.fix).toContain("ffmpeg");
  });

  test("parakeet-mlx + ffmpeg both present → available", async () => {
    const report = await computeBackendAvailability({
      which: whichWith(["parakeet-mlx", "ffmpeg"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    expect(report.transcribe["parakeet-mlx"]!.status).toBe("available");
  });

  test("whisper (whisper-ctranslate2) present but ffmpeg missing → warning naming ffmpeg", async () => {
    const report = await computeBackendAvailability({
      which: whichWith(["whisper-ctranslate2"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.transcribe["whisper"]!;
    expect(v.status).toBe("warning");
    expect(v.detail).toContain("ffmpeg");
    expect(v.fix).toContain("ffmpeg");
  });

  test("whisper binary missing → unavailable names BOTH whisper-ctranslate2 and ffmpeg", async () => {
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.transcribe["whisper"]!;
    expect(v.status).toBe("unavailable");
    expect(v.fix).toContain("whisper-ctranslate2");
    expect(v.fix).toContain("ffmpeg");
  });

  test("which throwing degrades to unknown, never crashes", async () => {
    const throwingWhich: WhichFn = () => {
      throw new Error("boom");
    };
    const report = await computeBackendAvailability({
      which: throwingWhich,
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    expect(report.transcribe["onnx-asr"]!.status).toBe("unknown");
  });
});

describe("computeBackendAvailability — API key backends", () => {
  test("groq transcribe with no key → unavailable naming GROQ_API_KEY", async () => {
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.transcribe["groq"]!;
    expect(v.status).toBe("unavailable");
    expect(v.detail).toContain("GROQ_API_KEY");
    expect(v.fix).toContain("GROQ_API_KEY");
  });

  test("anthropic cleanup with env key set → available", async () => {
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: { ANTHROPIC_API_KEY: "sk-ant-xxx" },
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.cleanup["anthropic"]!;
    expect(v.status).toBe("available");
    expect(v.detail).toContain("ANTHROPIC_API_KEY");
  });

  test("openai cleanup with config-stored key → available", async () => {
    const cfg: ScribeConfig = {
      cleanupProviders: { openai: { apiKey: "sk-stored" } },
    };
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: cfg,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    expect(report.cleanup["openai"]!.status).toBe("available");
  });
});

describe("computeBackendAvailability — claude-code", () => {
  test("claude missing → unavailable with install + setup-token fix", async () => {
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.cleanup["claude-code"]!;
    expect(v.status).toBe("unavailable");
    expect(v.fix).toContain("claude.com/claude-code");
    expect(v.fix).toContain("setup-token");
    expect(v.setupTokenStatus).toBe("not-configured");
  });

  test("claude present + token configured → available", async () => {
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("configured"),
    });
    const v = report.cleanup["claude-code"]!;
    expect(v.status).toBe("available");
    expect(v.setupTokenStatus).toBe("configured");
  });

  test("claude present + token expired → warning", async () => {
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("expired"),
    });
    const v = report.cleanup["claude-code"]!;
    expect(v.status).toBe("warning");
    expect(v.fix).toContain("setup-token");
  });

  test("claude present + token not-configured → unavailable", async () => {
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    expect(report.cleanup["claude-code"]!.status).toBe("unavailable");
  });
});

describe("computeBackendAvailability — ollama + custom + none", () => {
  test("ollama unreachable → unavailable naming the url", async () => {
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableFalse,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.cleanup["ollama"]!;
    expect(v.status).toBe("unavailable");
    expect(v.detail).toContain("http://localhost:11434");
    expect(v.fix).toContain("ollama");
  });

  test("ollama reachable → available", async () => {
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    expect(report.cleanup["ollama"]!.status).toBe("available");
  });

  test("ollama reach throwing → unknown", async () => {
    const throwingReach: ReachFn = async () => {
      throw new Error("net boom");
    };
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: throwingReach,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    expect(report.cleanup["ollama"]!.status).toBe("unknown");
  });

  test("custom has a localhost default url → available (default counts)", async () => {
    // The custom provider carries a built-in localhost default, so with an
    // empty config it resolves to that default and reports available.
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.cleanup["custom"]!;
    expect(v.status).toBe("available");
    expect(v.detail).toContain("http://localhost:8080/v1");
  });

  test("custom URL with embedded credentials → password not surfaced in detail", async () => {
    // A custom endpoint of the form https://user:pass@host/v1 must not leak the
    // embedded password into the admin-UI detail string. We echo only the
    // credential-stripped origin + pathname.
    const cfg: ScribeConfig = {
      cleanupProviders: { custom: { url: "https://user:s3cr3t-pass@example.com/v1" } },
    };
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: cfg,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.cleanup["custom"]!;
    expect(v.status).toBe("available");
    // The password (and the userinfo separator) are gone…
    expect(v.detail).not.toContain("s3cr3t-pass");
    expect(v.detail).not.toContain("user:");
    expect(v.detail).not.toContain("@");
    // …but the operator still sees which host the endpoint points at.
    expect(v.detail).toContain("https://example.com/v1");
  });

  test("custom URL that can't be parsed → generic echo-free detail", async () => {
    // An unparseable URL falls back to a generic confirmation with no echo,
    // rather than risk surfacing whatever the raw string contains.
    const cfg: ScribeConfig = {
      cleanupProviders: { custom: { url: "not a valid url with :pass@ in it" } },
    };
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: cfg,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    const v = report.cleanup["custom"]!;
    expect(v.status).toBe("available");
    expect(v.detail).toBe("Endpoint URL set.");
  });

  test("none → ok-no-check", async () => {
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
    });
    expect(report.cleanup["none"]!.status).toBe("ok-no-check");
  });
});

describe("computeBackendAvailability — claude-code live auth probe", () => {
  test("probe NOT invoked unless probeClaude is set (default per-call path stays subprocess-free)", async () => {
    let probeCalls = 0;
    const probe: ClaudeProbeFn = async () => {
      probeCalls++;
      return { outcome: "ok" };
    };
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("configured"),
      claudeProbeFn: probe,
      // probeClaude omitted → defaults false
    });
    expect(probeCalls).toBe(0);
    // Falls back to the file-token heuristic.
    expect(report.cleanup["claude-code"]!.status).toBe("available");
  });

  test("probe ok → available (live probe authoritative even when token file says not-configured)", async () => {
    const probe: ClaudeProbeFn = async () => ({ outcome: "ok" });
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      // The macOS-unreliable file read says not-configured…
      setupTokenStatusFn: tokenStatus("not-configured"),
      probeClaude: true,
      claudeProbeFn: probe,
    });
    // …but the LIVE probe is authoritative → available.
    expect(report.cleanup["claude-code"]!.status).toBe("available");
  });

  test("probe fail + not-logged-in signature → unauthenticated with launchd-keychain fix", async () => {
    const probe: ClaudeProbeFn = async () => ({
      outcome: "fail",
      output: "Error: Not logged in. Run `claude login`.",
    });
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("configured"),
      probeClaude: true,
      claudeProbeFn: probe,
    });
    const v = report.cleanup["claude-code"]!;
    expect(v.status).toBe("unauthenticated");
    expect(v.fix).toContain("claude setup-token");
    expect(v.fix).toContain("ANTHROPIC_API_KEY");
    expect(v.fix).toContain("keychain");
  });

  test("probe fail + invalid-api-key signature → unauthenticated", async () => {
    const probe: ClaudeProbeFn = async () => ({
      outcome: "fail",
      output: "API Error: invalid API key provided",
    });
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("configured"),
      probeClaude: true,
      claudeProbeFn: probe,
    });
    expect(report.cleanup["claude-code"]!.status).toBe("unauthenticated");
  });

  test("probe enoent → unavailable (binary not runnable)", async () => {
    const probe: ClaudeProbeFn = async () => ({ outcome: "enoent" });
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("configured"),
      probeClaude: true,
      claudeProbeFn: probe,
    });
    expect(report.cleanup["claude-code"]!.status).toBe("unavailable");
  });

  test("probe fail without a recognized signature → warning (inconclusive), not a false unauthenticated", async () => {
    const probe: ClaudeProbeFn = async () => ({
      outcome: "fail",
      output: "some unrelated runtime error",
    });
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("configured"),
      probeClaude: true,
      claudeProbeFn: probe,
    });
    expect(report.cleanup["claude-code"]!.status).toBe("warning");
  });

  test("probe error (e.g. timeout) → warning, never crashes the endpoint", async () => {
    const probe: ClaudeProbeFn = async () => ({ outcome: "error" });
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("configured"),
      probeClaude: true,
      claudeProbeFn: probe,
    });
    expect(report.cleanup["claude-code"]!.status).toBe("warning");
  });

  test("probe throwing degrades to warning, never crashes", async () => {
    const probe: ClaudeProbeFn = async () => {
      throw new Error("boom");
    };
    const report = await computeBackendAvailability({
      which: whichWith(["claude"]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("configured"),
      probeClaude: true,
      claudeProbeFn: probe,
    });
    expect(report.cleanup["claude-code"]!.status).toBe("warning");
  });

  test("claude binary absent → unavailable, probe never consulted", async () => {
    let probeCalls = 0;
    const probe: ClaudeProbeFn = async () => {
      probeCalls++;
      return { outcome: "ok" };
    };
    const report = await computeBackendAvailability({
      which: whichWith([]),
      reach: reachableTrue,
      env: NO_ENV,
      scribeConfig: EMPTY_CONFIG,
      setupTokenStatusFn: tokenStatus("not-configured"),
      probeClaude: true,
      claudeProbeFn: probe,
    });
    expect(report.cleanup["claude-code"]!.status).toBe("unavailable");
    expect(probeCalls).toBe(0);
  });
});
