/**
 * Per-backend availability detection for the admin SPA.
 *
 * The pain this fixes: selecting a transcription backend (`onnx-asr`) + a
 * cleanup backend (`claude-code`) in the admin UI *saves fine* — the config
 * write succeeds — but the first actual transcription fails with an opaque
 * subprocess error (`exit 127` / "command not found") because the underlying
 * CLI was never installed. There were ZERO dependency checks anywhere in the
 * config flow; the silent failure surfaced only at request time, far from
 * where the operator made the choice.
 *
 * This module probes each backend's real prerequisite (a CLI on PATH, an
 * API key, a reachable URL) and returns a structured status the SPA renders
 * INLINE next to each backend select. The owner's chosen behavior is
 * **warn + how-to-fix, NON-BLOCKING** — saving is never blocked, but a
 * missing dependency is impossible to miss, and every warning carries the
 * exact fix.
 *
 * Design constraints:
 *
 *   - **Fast + non-fatal.** Each check is a `Bun.which` lookup (a PATH stat),
 *     an env/config read, or a single short-timeout fetch. Any check that
 *     throws degrades to `status: "unknown"` for that one backend — it never
 *     crashes the endpoint or the page.
 *   - **Server-side.** The browser can't `Bun.which` or read the host's env;
 *     detection runs in-process and is surfaced over
 *     `GET /admin/backend-availability`.
 *   - **No secrets on the wire.** API-key checks report only presence
 *     (configured / env-set / missing), never the value.
 */

import { readSetupTokenStatus } from "./claude-token-status.ts";
import { resolveCleanupProviderConfig } from "./provider-config.ts";
import type { ProviderBlock, ScribeConfig } from "./config.ts";
import type { SetupTokenStatus } from "./config-schema.ts";

/** True when the on-disk config block for `name` carries a non-empty apiKey. */
function rawConfigApiKey(
  map: Record<string, ProviderBlock> | undefined,
  name: string,
): boolean {
  const v = map?.[name]?.apiKey;
  return typeof v === "string" && v.length > 0;
}

/** Availability verdict for a single backend. */
export type BackendAvailability = {
  /**
   *   - `available`   — prerequisite satisfied (binary on PATH, key present,
   *                     url reachable). Safe to use.
   *   - `unavailable` — a hard prerequisite is missing. `detail` + `fix`
   *                     carry the exact remedy.
   *   - `warning`     — usable-but-incomplete (e.g. a self-hosted URL we
   *                     couldn't reach but the operator may bring up).
   *   - `unknown`     — the check itself errored / couldn't determine. Never
   *                     a hard fail; the SPA shows "couldn't determine".
   *   - `ok-no-check` — nothing to check (e.g. cleanup `none`).
   */
  status: "available" | "unavailable" | "warning" | "unknown" | "ok-no-check";
  /** One-line human summary, safe to render directly. */
  detail: string;
  /** Exact fix when status is unavailable/warning — install cmd, env export, etc. */
  fix?: string;
  /**
   * For `claude-code`: the raw setup-token status so the SPA can render the
   * token pill alongside the CLI-presence verdict. Omitted for other backends.
   */
  setupTokenStatus?: SetupTokenStatus;
};

export type BackendAvailabilityReport = {
  transcribe: Record<string, BackendAvailability>;
  cleanup: Record<string, BackendAvailability>;
};

/**
 * Seam for testing — defaults to `Bun.which` but overridable so unit tests
 * can simulate present/absent binaries without touching the host PATH.
 */
export type WhichFn = (bin: string) => string | null;

/**
 * Seam for the ollama reachability probe. Defaults to a short-timeout fetch;
 * tests inject a stub so they never hit the network.
 */
export type ReachFn = (url: string) => Promise<boolean>;

export type AvailabilityDeps = {
  which?: WhichFn;
  reach?: ReachFn;
  env?: Record<string, string | undefined>;
  scribeConfig: ScribeConfig;
  setupTokenStatusFn?: (env?: Record<string, string | undefined>) => SetupTokenStatus;
};

const defaultWhich: WhichFn = (bin) => Bun.which(bin);

const defaultReach: ReachFn = async (url) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    try {
      // Hit the ollama root — 200/404/any HTTP response means "reachable".
      // We only care that *something* answered, not the status code.
      const res = await fetch(url, { signal: controller.signal });
      // Touch the body-less response just enough to satisfy lint; the bare
      // fact we got a Response (didn't throw) is the signal.
      void res.status;
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
};

/** Install command per local transcription CLI. Sourced from README + .env.example. */
const TRANSCRIBE_INSTALL: Record<string, { bin: string; fix: string }> = {
  // parakeet-mlx: macOS / Apple-Silicon only (MLX). Published as a uv/pip tool.
  "parakeet-mlx": {
    bin: "parakeet-mlx",
    fix: "Install the parakeet-mlx CLI (macOS / Apple Silicon only): `uv tool install parakeet-mlx` (or `pip install parakeet-mlx`), then ensure it's on PATH.",
  },
  "onnx-asr": {
    bin: "onnx-asr",
    fix: "Install the onnx-asr CLI: `pip install onnx-asr[cpu,hub]` (cross-platform), then ensure it's on PATH.",
  },
  // The `whisper` backend shells to the `whisper-ctranslate2` binary, NOT a
  // bare `whisper` — the install command + the PATH check both target it.
  whisper: {
    bin: "whisper-ctranslate2",
    fix: "Install whisper-ctranslate2: `pip install whisper-ctranslate2`, then ensure it's on PATH.",
  },
};

/** API-backend env-var names — mirrors provider-config.ts so the message names the real var. */
const TRANSCRIBE_API_ENV: Record<string, string> = {
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
};

const CLEANUP_API_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
};

function safeWhich(which: WhichFn, bin: string): string | null | "error" {
  try {
    return which(bin);
  } catch {
    return "error";
  }
}

/** ffmpeg is a shared prerequisite for onnx-asr (it converts non-wav input). */
function ffmpegNote(which: WhichFn): string {
  const ff = safeWhich(which, "ffmpeg");
  if (ff === null) {
    return " Also install `ffmpeg` (needed to convert non-WAV audio): `brew install ffmpeg` on macOS, `apt install ffmpeg` on Debian/Ubuntu.";
  }
  return "";
}

function checkTranscribeBinary(
  name: string,
  which: WhichFn,
): BackendAvailability {
  const spec = TRANSCRIBE_INSTALL[name];
  if (!spec) {
    return { status: "ok-no-check", detail: "No local dependency to check." };
  }
  const found = safeWhich(which, spec.bin);
  if (found === "error") {
    return { status: "unknown", detail: `Couldn't check whether \`${spec.bin}\` is installed.` };
  }
  if (found === null) {
    const extra = name === "onnx-asr" ? ffmpegNote(which) : "";
    return {
      status: "unavailable",
      detail: `\`${spec.bin}\` isn't installed.`,
      fix: spec.fix + extra,
    };
  }
  const extra = name === "onnx-asr" ? ffmpegNote(which) : "";
  if (extra) {
    return {
      status: "warning",
      detail: `\`${spec.bin}\` is installed, but \`ffmpeg\` is missing.`,
      fix: extra.trim(),
    };
  }
  return { status: "available", detail: `\`${spec.bin}\` is installed.` };
}

/**
 * API-key presence check. `configHasKey` is the raw config-block presence
 * (NOT the env-merged resolution) so the detail message can correctly
 * distinguish a key stored in config.json from one supplied via the
 * environment — otherwise an env-only key gets mislabeled "stored in config".
 */
function checkApiKey(
  envVar: string,
  configHasKey: boolean,
  env: Record<string, string | undefined>,
): BackendAvailability {
  if (configHasKey) {
    return { status: "available", detail: `API key stored in config (\`${envVar}\` not needed).` };
  }
  const fromEnv = env[envVar];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { status: "available", detail: `Using \`${envVar}\` from the environment.` };
  }
  return {
    status: "unavailable",
    detail: `No \`${envVar}\` set.`,
    fix: `Paste an API key in the field below, or export \`${envVar}\` in scribe's environment and restart.`,
  };
}

async function checkOllama(
  scribeConfig: ScribeConfig,
  reach: ReachFn,
  env: Record<string, string | undefined>,
): Promise<BackendAvailability> {
  const resolved = resolveCleanupProviderConfig("ollama", scribeConfig, env);
  const url = resolved.url ?? "http://localhost:11434";
  let reachable: boolean;
  try {
    reachable = await reach(url);
  } catch {
    return { status: "unknown", detail: `Couldn't check whether ollama is reachable at ${url}.` };
  }
  if (reachable) {
    return { status: "available", detail: `Ollama is reachable at ${url}.` };
  }
  return {
    status: "unavailable",
    detail: `Ollama isn't reachable at ${url}.`,
    fix: `Start ollama (\`ollama serve\`) on this host, or set the Ollama URL below to where it's running.`,
  };
}

function checkClaudeCode(
  which: WhichFn,
  env: Record<string, string | undefined>,
  setupTokenStatusFn: (env?: Record<string, string | undefined>) => SetupTokenStatus,
): BackendAvailability {
  let tokenStatus: SetupTokenStatus;
  try {
    tokenStatus = setupTokenStatusFn(env);
  } catch {
    tokenStatus = "unknown";
  }
  const claudeBin = safeWhich(which, "claude");
  if (claudeBin === "error") {
    return {
      status: "unknown",
      detail: "Couldn't check whether the `claude` CLI is installed.",
      setupTokenStatus: tokenStatus,
    };
  }
  if (claudeBin === null) {
    return {
      status: "unavailable",
      detail: "The `claude` CLI isn't installed.",
      fix: "Install Claude Code (https://claude.com/claude-code), then run `claude setup-token` on this host and click Refresh.",
      setupTokenStatus: tokenStatus,
    };
  }
  // CLI present — the deciding factor is now the setup-token.
  if (tokenStatus === "configured") {
    return {
      status: "available",
      detail: "`claude` CLI installed and a setup-token is configured.",
      setupTokenStatus: tokenStatus,
    };
  }
  if (tokenStatus === "expired") {
    return {
      status: "warning",
      detail: "`claude` CLI installed, but the setup-token has expired.",
      fix: "Re-run `claude setup-token` on this host, then click Refresh.",
      setupTokenStatus: tokenStatus,
    };
  }
  if (tokenStatus === "not-configured") {
    return {
      status: "unavailable",
      detail: "`claude` CLI installed, but no setup-token is configured.",
      fix: "Run `claude setup-token` on this host, then click Refresh.",
      setupTokenStatus: tokenStatus,
    };
  }
  // unknown token status (file present but unreadable)
  return {
    status: "warning",
    detail: "`claude` CLI installed; couldn't determine the setup-token status.",
    fix: "If transcription cleanup fails, run `claude setup-token` on this host and click Refresh.",
    setupTokenStatus: tokenStatus,
  };
}

function checkCustom(
  scribeConfig: ScribeConfig,
  env: Record<string, string | undefined>,
): BackendAvailability {
  const resolved = resolveCleanupProviderConfig("custom", scribeConfig, env);
  const url = resolved.url;
  // The custom provider has a built-in localhost default; treat an explicit
  // empty/unset as "needs a URL" only when neither config nor env supplied one.
  if (!url || url.length === 0) {
    return {
      status: "unavailable",
      detail: "No endpoint URL set for the custom provider.",
      fix: "Set the endpoint URL below to your OpenAI-compatible server.",
    };
  }
  // Echo a credential-stripped display URL: a custom endpoint of the form
  // `https://user:pass@host/v1` would otherwise surface the embedded password
  // in the admin UI. Rebuild from origin + pathname (drops userinfo, query, and
  // fragment too — none of which belong in a "URL set" confirmation). Fall back
  // to a generic, echo-free message if the URL can't be parsed.
  let display: string | null;
  try {
    const parsed = new URL(url);
    display = parsed.origin + parsed.pathname;
  } catch {
    display = null;
  }
  return {
    status: "available",
    detail: display ? `Endpoint URL set (${display}).` : "Endpoint URL set.",
  };
}

/**
 * Compute the availability report for every transcription + cleanup backend.
 * Pure-ish: all side-effecting probes go through injectable seams so tests
 * stay hermetic. Each per-backend check is independently try/caught so one
 * failing probe can't blank the whole report.
 */
export async function computeBackendAvailability(
  deps: AvailabilityDeps,
): Promise<BackendAvailabilityReport> {
  const which = deps.which ?? defaultWhich;
  const reach = deps.reach ?? defaultReach;
  const env = deps.env ?? process.env;
  const setupTokenStatusFn = deps.setupTokenStatusFn ?? readSetupTokenStatus;
  const scribeConfig = deps.scribeConfig;

  const transcribe: Record<string, BackendAvailability> = {};
  // Local CLI transcribers.
  for (const name of Object.keys(TRANSCRIBE_INSTALL)) {
    try {
      transcribe[name] = checkTranscribeBinary(name, which);
    } catch {
      transcribe[name] = { status: "unknown", detail: "Check failed." };
    }
  }
  // API transcribers. We read the RAW config block presence (not the
  // env-merged resolution) so an env-only key isn't mislabeled "stored in
  // config." The merged resolution is still useful for the available-vs-not
  // decision, but checkApiKey re-derives that from (configHasKey || env).
  for (const [name, envVar] of Object.entries(TRANSCRIBE_API_ENV)) {
    try {
      const configHasKey = rawConfigApiKey(scribeConfig.transcribeProviders, name);
      transcribe[name] = checkApiKey(envVar, configHasKey, env);
    } catch {
      transcribe[name] = { status: "unknown", detail: "Check failed." };
    }
  }

  const cleanup: Record<string, BackendAvailability> = {};
  // API cleaners.
  for (const [name, envVar] of Object.entries(CLEANUP_API_ENV)) {
    try {
      const configHasKey = rawConfigApiKey(scribeConfig.cleanupProviders, name);
      cleanup[name] = checkApiKey(envVar, configHasKey, env);
    } catch {
      cleanup[name] = { status: "unknown", detail: "Check failed." };
    }
  }
  // claude-code.
  try {
    cleanup["claude-code"] = checkClaudeCode(which, env, setupTokenStatusFn);
  } catch {
    cleanup["claude-code"] = { status: "unknown", detail: "Check failed." };
  }
  // ollama (reachability probe).
  try {
    cleanup["ollama"] = await checkOllama(scribeConfig, reach, env);
  } catch {
    cleanup["ollama"] = { status: "unknown", detail: "Check failed." };
  }
  // custom.
  try {
    cleanup["custom"] = checkCustom(scribeConfig, env);
  } catch {
    cleanup["custom"] = { status: "unknown", detail: "Check failed." };
  }
  // none — nothing to check.
  cleanup["none"] = { status: "ok-no-check", detail: "No cleanup — nothing to check." };

  return { transcribe, cleanup };
}
