/**
 * Runnable install routine for a local transcription backend.
 *
 * Companion to `backend-availability.ts`: that module *diagnoses* (reports the
 * `fix` string an operator would run by hand); this one *runs* it. The
 * onboarding-streamline arc (2026-06-25) needs `parachute init`, the hub, and
 * the DigitalOcean install script to actually SET UP local transcription, not
 * just print what to type. This is the foundational piece those layers call.
 *
 * It reuses `TRANSCRIBE_INSTALL` from `backend-availability.ts` as the single
 * source of truth for the pip package + extras (so the runnable command can
 * never drift from the diagnosed `fix` prose), and re-runs
 * `computeBackendAvailability` at the end as the verification step.
 *
 * Design contract:
 *
 *   - **Diagnose-only path untouched.** Nothing here is wired into the SPA's
 *     `/admin/backend-availability` endpoint or `computeBackendAvailability`.
 *     This is an additive runnable layer on top of the existing detector.
 *   - **Non-fatal + idempotent.** Re-running is safe: an already-present binary
 *     is a no-op success; `apt install` / `pip install` of present packages is
 *     a no-op; the model warm-pull is skippable. A failed step reports + sets a
 *     non-zero exit but never leaves a half-state we can't recover from on the
 *     next run.
 *   - **RAM guard.** Below ~2 GB available the routine REFUSES to install a
 *     local backend (it would OOM) and points the operator at a cloud provider.
 *   - **Privilege split.** pip/uv run user-level (a venv, or `uv tool`); apt is
 *     system-level and needs root — we use `sudo` when not already root, and if
 *     neither root nor sudo is available we instruct rather than fail opaquely.
 *   - **Injected runner.** Every subprocess + platform probe goes through the
 *     `InstallDeps` seam so tests exercise the logic, the RAM guard, and
 *     idempotency WITHOUT ever apt/pip-installing anything.
 */

import {
  TRANSCRIBE_INSTALL,
  pipTarget,
  computeBackendAvailability,
  type WhichFn,
} from "./backend-availability.ts";
import { loadConfig, type ScribeConfig } from "./config.ts";

/** The pip install target for a named backend, or null if not a local backend. */
export function pipTargetFor(provider: string): string | null {
  const spec = TRANSCRIBE_INSTALL[provider];
  return spec ? pipTarget(spec) : null;
}

/** Default model warm-pulled for the onnx-asr / parakeet backends. */
export const DEFAULT_MODEL = "nemo-parakeet-tdt-0.6b-v3";

/** Minimum available RAM (in MiB) below which a local backend is refused. */
export const MIN_RAM_MIB = 2048;

/** The cloud-provider steer shown when RAM is too low (mirrors the README). */
export const CLOUD_STEER =
  "This box has too little RAM for a local ASR model (it would be OOM-killed). " +
  "Use a cloud transcription provider instead — `groq` (fast, ~$0.06/hr) or `openai`: " +
  "set `TRANSCRIBE_PROVIDER=groq` and `GROQ_API_KEY=gsk_…` (or via the admin SPA). " +
  "See README → Local transcription backends — install & sizing.";

/** Outcome of one subprocess step. */
export type RunResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Injectable side-effect seam. Defaults run real subprocesses / read real
 * platform state; tests inject stubs so nothing is actually installed.
 */
export type InstallDeps = {
  /** Run a command, capturing exit code + output. Never throws. */
  run: (cmd: string[], opts?: { cwd?: string }) => Promise<RunResult>;
  /** PATH lookup — mirrors backend-availability's `WhichFn`. */
  which: WhichFn;
  /** `process.platform` — `"darwin"` | `"linux"` | other. */
  platform: NodeJS.Platform;
  /** Available RAM in MiB, or `null` when it can't be determined. */
  availableRamMib: () => number | null;
  /** Effective uid; `0` means root. */
  uid: () => number;
  /** Home directory (for the venv path). */
  homeDir: () => string;
  /** Sink for human-readable progress lines. */
  log: (line: string) => void;
  /**
   * Load the scribe config the verify step passes to the detector. Optional —
   * defaults to the real `loadConfig()`; tests inject `{}` so verification
   * stays hermetic (the detector's binary check still flows through `which`).
   */
  loadScribeConfig?: () => Promise<ScribeConfig>;
};

/** Read MemAvailable from /proc/meminfo (Linux). Returns MiB or null. */
async function readLinuxAvailableRamMib(): Promise<number | null> {
  try {
    const text = await Bun.file("/proc/meminfo").text();
    // MemAvailable is the honest figure (free + reclaimable). Fall back to
    // MemFree only if MemAvailable is absent (very old kernels).
    const avail = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
    const free = /^MemFree:\s+(\d+)\s*kB/m.exec(text);
    const kb = avail ? Number(avail[1]) : free ? Number(free[1]) : null;
    if (kb === null || !Number.isFinite(kb)) return null;
    return Math.floor(kb / 1024);
  } catch {
    return null;
  }
}

/** Default RAM probe: /proc/meminfo on Linux; null elsewhere (no refusal). */
function defaultAvailableRamMib(): number | null {
  // Synchronous-shaped seam over an async read: we resolve it eagerly in the
  // default deps builder so the seam stays sync for tests. See buildDefaultDeps.
  return null;
}

/** Real subprocess runner — captures combined output, never throws. */
const defaultRun: InstallDeps["run"] = async (cmd, opts) => {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    // ENOENT / spawn failure: surface as a non-zero result rather than throw,
    // so a missing tool (e.g. no `apt`) is a reportable step failure.
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 127, stdout: "", stderr: message };
  }
};

/** Build the default (real-side-effect) deps. RAM is read eagerly on Linux. */
export async function buildDefaultDeps(): Promise<InstallDeps> {
  const ramMib =
    process.platform === "linux" ? await readLinuxAvailableRamMib() : null;
  return {
    run: defaultRun,
    which: (bin) => Bun.which(bin),
    platform: process.platform,
    availableRamMib: () => ramMib ?? defaultAvailableRamMib(),
    uid: () => (typeof process.getuid === "function" ? process.getuid() : 0),
    homeDir: () => process.env.HOME ?? process.env.USERPROFILE ?? "/root",
    log: (line) => console.log(line),
    loadScribeConfig: () => loadConfig(),
  };
}

/** Result of an install run. */
export type InstallOutcome = {
  /** `true` when the backend is verified available at the end. */
  ok: boolean;
  /** Resolved provider that was targeted. */
  provider: string;
  /** Ordered step log (machine-readable companion to the human `log`). */
  steps: InstallStep[];
  /** One-line summary for the caller (hub / install script). */
  summary: string;
};

export type InstallStep = {
  name: string;
  status: "ok" | "skipped" | "failed" | "refused";
  detail: string;
};

/**
 * The local backend that matches the host platform. The onboarding flow uses
 * this to pick the CORRECT provider (the bug hub PR1 also fixes: the
 * unconditional `→ parakeet-mlx`). Linux → onnx-asr, macOS → parakeet-mlx.
 */
export function platformLocalProvider(
  platform: NodeJS.Platform,
): "onnx-asr" | "parakeet-mlx" | null {
  if (platform === "darwin") return "parakeet-mlx";
  if (platform === "linux") return "onnx-asr";
  return null;
}

type InstallOptions = {
  /** Explicit provider; when omitted, derive from the platform. */
  provider?: string;
  /** Skip the (slow) model warm-pull. */
  skipModel?: boolean;
  /** Model id to warm-pull. Defaults to DEFAULT_MODEL. */
  model?: string;
};

/**
 * Install + verify a local transcription backend. Pure orchestration over the
 * injected `deps`; returns a structured outcome and never throws (every
 * failure mode is a `failed`/`refused` step).
 */
export async function installBackend(
  deps: InstallDeps,
  opts: InstallOptions = {},
): Promise<InstallOutcome> {
  const steps: InstallStep[] = [];
  const record = (s: InstallStep): InstallStep => {
    steps.push(s);
    return s;
  };

  const provider = opts.provider ?? platformLocalProvider(deps.platform) ?? "";
  const spec = TRANSCRIBE_INSTALL[provider];

  // --- Guard: a known local backend on a supported platform ---------------
  if (!spec) {
    const detail =
      provider === ""
        ? `No local transcription backend is supported on platform "${deps.platform}". Use a cloud provider (groq/openai).`
        : `"${provider}" is not an installable local backend. Local backends: ${Object.keys(TRANSCRIBE_INSTALL).join(", ")}.`;
    deps.log(detail);
    record({ name: "resolve-backend", status: "failed", detail });
    return { ok: false, provider, steps, summary: detail };
  }

  // Platform mismatch (e.g. parakeet-mlx on Linux) — refuse loudly.
  if (spec.platform && spec.platform !== deps.platform) {
    const detail = `"${provider}" only runs on ${spec.platform}; this host is ${deps.platform}. ${
      platformLocalProvider(deps.platform)
        ? `Use \`${platformLocalProvider(deps.platform)}\` here instead.`
        : "Use a cloud provider (groq/openai)."
    }`;
    deps.log(detail);
    record({ name: "resolve-backend", status: "refused", detail });
    return { ok: false, provider, steps, summary: detail };
  }

  deps.log(`Installing local transcription backend: ${provider}`);

  // --- RAM guard ----------------------------------------------------------
  const ram = deps.availableRamMib();
  if (ram !== null && ram < MIN_RAM_MIB) {
    const detail = `Available RAM ${ram} MiB is below the ${MIN_RAM_MIB} MiB floor for local ASR. ${CLOUD_STEER}`;
    deps.log(detail);
    record({ name: "ram-guard", status: "refused", detail });
    return { ok: false, provider, steps, summary: detail };
  }
  record({
    name: "ram-guard",
    status: ram === null ? "skipped" : "ok",
    detail:
      ram === null
        ? "Could not determine available RAM — proceeding (no refusal)."
        : `Available RAM ${ram} MiB ≥ ${MIN_RAM_MIB} MiB floor.`,
  });

  // --- System deps (ffmpeg + python toolchain) via apt --------------------
  // Only Linux has apt; on macOS we instruct (brew) rather than install, since
  // python3 ships and ffmpeg is a brew concern we don't want to drive blindly.
  if (deps.platform === "linux") {
    const aptStep = await ensureLinuxSystemDeps(deps, spec.needsFfmpeg === true);
    record(aptStep);
    if (aptStep.status === "failed") {
      return {
        ok: false,
        provider,
        steps,
        summary: `System dependency install failed: ${aptStep.detail}`,
      };
    }
  } else {
    // macOS: ffmpeg via brew is the operator's call; we check + instruct.
    const ffStep = checkFfmpegInstruct(deps, spec.needsFfmpeg === true);
    record(ffStep);
  }

  // --- Python package (pip in a venv, or uv tool) -------------------------
  const pkgStep = await ensurePythonPackage(deps, provider, spec);
  record(pkgStep);
  if (pkgStep.status === "failed") {
    return {
      ok: false,
      provider,
      steps,
      summary: `Backend package install failed: ${pkgStep.detail}`,
    };
  }

  // --- Warm-pull the default model ----------------------------------------
  if (opts.skipModel) {
    record({ name: "model-warm-pull", status: "skipped", detail: "Skipped by request." });
  } else {
    const model = opts.model ?? DEFAULT_MODEL;
    const modelStep = await warmPullModel(deps, provider, model);
    record(modelStep);
    // A model warm-pull failure is non-fatal: the model fetches lazily on the
    // first real transcription. Report it but don't abort the verify.
  }

  // --- Verify via the existing detector (single source of truth) ----------
  const verifyStep = await verifyBackend(deps, provider);
  record(verifyStep);

  // `ok` (fully available) and `skipped` (installed, but a secondary dep like
  // ffmpeg still needs the operator) both count as a successful install — the
  // backend binary is in place. Only a hard `failed` verify is an install fail.
  const ok = verifyStep.status === "ok" || verifyStep.status === "skipped";
  // Carry the venv PATH caveat into the summary when the venv fallback ran, so a
  // caller reading only `summary` (hub / install script) doesn't miss it.
  const pkgStepFinal = steps.find((s) => s.name === "backend-package");
  const venvCaveat =
    pkgStepFinal?.status === "ok" && pkgStepFinal.detail.includes(".venvs/scribe-asr")
      ? ` NOTE: installed into a venv — add \`${venvDir(deps)}/bin\` to scribe's service PATH (or install \`uv\` and re-run for an on-PATH binary).`
      : "";
  let summary: string;
  if (verifyStep.status === "ok") {
    summary =
      `${provider} installed and verified available. ` +
      (opts.skipModel
        ? "Model warm-pull skipped — it will download on first transcription."
        : `Set TRANSCRIBE_PROVIDER=${provider} (or pick it in the admin SPA) and restart scribe.`) +
      venvCaveat;
  } else if (verifyStep.status === "skipped") {
    // Installed, but one more operator step remains (carried in verifyStep.detail).
    summary = `${provider} installed. ${verifyStep.detail}${venvCaveat}`;
  } else {
    summary = `${provider} install ran but verification did not report it available. ${verifyStep.detail}`;
  }
  deps.log(summary);
  return { ok, provider, steps, summary };
}

/** sudo-if-needed prefix: `[]` when root, `["sudo"]` otherwise (when sudo exists). */
function sudoPrefix(deps: InstallDeps): { prefix: string[]; haveRoot: boolean; haveSudo: boolean } {
  const haveRoot = deps.uid() === 0;
  const haveSudo = deps.which("sudo") !== null;
  return { prefix: haveRoot ? [] : haveSudo ? ["sudo"] : [], haveRoot, haveSudo };
}

/**
 * Ensure ffmpeg + python toolchain on Debian/Ubuntu via apt. Idempotent: apt
 * is a no-op for already-present packages. Needs root or sudo; instructs if
 * neither is available rather than producing an opaque permission error.
 */
async function ensureLinuxSystemDeps(
  deps: InstallDeps,
  needsFfmpeg: boolean,
): Promise<InstallStep> {
  // Already satisfied? Then nothing to do (the common idempotent re-run path).
  const pyOk = deps.which("python3") !== null;
  const ffOk = !needsFfmpeg || deps.which("ffmpeg") !== null;
  if (pyOk && ffOk) {
    return {
      name: "system-deps",
      status: "skipped",
      detail: "python3" + (needsFfmpeg ? " + ffmpeg" : "") + " already present.",
    };
  }

  const apt = deps.which("apt-get") ?? deps.which("apt");
  if (apt === null) {
    return {
      name: "system-deps",
      status: "failed",
      detail:
        "No apt found and python3/ffmpeg missing. Install them with your package manager, then re-run.",
    };
  }

  const { prefix, haveRoot, haveSudo } = sudoPrefix(deps);
  if (!haveRoot && !haveSudo) {
    return {
      name: "system-deps",
      status: "failed",
      detail:
        "Need root or sudo to apt-install python3/python3-venv" +
        (needsFfmpeg ? "/ffmpeg" : "") +
        ". Re-run as root, or run: `sudo apt-get install -y python3 python3-venv" +
        (needsFfmpeg ? " ffmpeg" : "") +
        "`, then re-run this command.",
    };
  }

  const pkgs = ["python3", "python3-venv", "python3-pip"];
  if (needsFfmpeg) pkgs.push("ffmpeg");

  deps.log(`Installing system deps via apt: ${pkgs.join(" ")} …`);
  // `apt-get update` is best-effort — a failure here (e.g. transient mirror)
  // shouldn't abort if the cache is already warm; we report but continue.
  const update = await deps.run([...prefix, "apt-get", "update"]);
  if (update.exitCode !== 0) {
    deps.log(`apt-get update returned ${update.exitCode} (continuing): ${update.stderr.trim()}`);
  }
  const install = await deps.run([
    ...prefix,
    "apt-get",
    "install",
    "-y",
    ...pkgs,
  ]);
  if (install.exitCode !== 0) {
    return {
      name: "system-deps",
      status: "failed",
      detail: `apt-get install failed (exit ${install.exitCode}): ${install.stderr.trim() || install.stdout.trim()}`,
    };
  }
  return {
    name: "system-deps",
    status: "ok",
    detail: `Installed: ${pkgs.join(", ")}.`,
  };
}

/** macOS: check ffmpeg; instruct the brew install rather than driving it. */
function checkFfmpegInstruct(deps: InstallDeps, needsFfmpeg: boolean): InstallStep {
  if (!needsFfmpeg || deps.which("ffmpeg") !== null) {
    return {
      name: "system-deps",
      status: "skipped",
      detail: needsFfmpeg ? "ffmpeg already present." : "No system deps needed.",
    };
  }
  return {
    name: "system-deps",
    status: "skipped",
    detail:
      "ffmpeg is missing (needed to decode non-WAV audio). Install it with `brew install ffmpeg`, then re-run.",
  };
}

/** The venv directory under the user's home. */
function venvDir(deps: InstallDeps): string {
  return `${deps.homeDir()}/.venvs/scribe-asr`;
}

/**
 * Install the backend's python package. Two user-level strategies, in order of
 * preference:
 *
 *   1. `uv tool install <pkg>` — puts the binary directly on PATH, no venv
 *      activation needed (the daemon-friendly path the README recommends).
 *   2. A dedicated venv + `pip install <pkg>` — keeps it off the system Python.
 *
 * Idempotent: if the binary is already on PATH we no-op; uv/pip re-install of a
 * present package is itself a no-op.
 */
async function ensurePythonPackage(
  deps: InstallDeps,
  provider: string,
  spec: { bin: string; pipPackage: string; pipExtras?: string },
): Promise<InstallStep> {
  // Already installed? Idempotent no-op.
  if (deps.which(spec.bin) !== null) {
    return {
      name: "backend-package",
      status: "skipped",
      detail: `\`${spec.bin}\` already on PATH — nothing to install.`,
    };
  }

  const target = pipTarget(spec);

  // Strategy 1: uv tool install (on-PATH binary, no activation).
  if (deps.which("uv") !== null) {
    deps.log(`Installing ${target} via \`uv tool install\` …`);
    const r = await deps.run(["uv", "tool", "install", target]);
    if (r.exitCode === 0) {
      return {
        name: "backend-package",
        status: "ok",
        detail: `Installed ${target} via uv tool (on PATH).`,
      };
    }
    deps.log(`uv tool install failed (exit ${r.exitCode}); falling back to a venv + pip.`);
  }

  // Strategy 2: venv + pip.
  const venv = venvDir(deps);
  const pip = `${venv}/bin/pip`;
  const venvBin = `${venv}/bin/${spec.bin}`;

  // Create the venv (idempotent: re-creating an existing venv is harmless).
  const mk = await deps.run(["python3", "-m", "venv", venv]);
  if (mk.exitCode !== 0) {
    return {
      name: "backend-package",
      status: "failed",
      detail: `Could not create venv at ${venv} (exit ${mk.exitCode}): ${mk.stderr.trim() || mk.stdout.trim()}. Is python3-venv installed?`,
    };
  }

  deps.log(`Installing ${target} into ${venv} via pip …`);
  const install = await deps.run([pip, "install", target]);
  if (install.exitCode !== 0) {
    return {
      name: "backend-package",
      status: "failed",
      detail: `pip install ${target} failed (exit ${install.exitCode}): ${install.stderr.trim() || install.stdout.trim()}`,
    };
  }
  return {
    name: "backend-package",
    status: "ok",
    detail:
      `Installed ${target} into ${venv}. NOTE: a venv only exports \`${spec.bin}\` while activated — ` +
      `add \`${venv}/bin\` to scribe's service PATH (or install \`uv\` and re-run for an on-PATH binary). ` +
      `Binary at: ${venvBin}.`,
  };
}

/**
 * Warm-pull the default model so the first real transcription isn't a long
 * cold download. Best-effort: a failure here is non-fatal (the model fetches
 * lazily anyway), so this always returns `ok` or `skipped`, never `failed`.
 * Resolves the just-installed binary from PATH or the venv.
 */
async function warmPullModel(
  deps: InstallDeps,
  provider: string,
  model: string,
): Promise<InstallStep> {
  // onnx-asr can warm-pull a named model directly. parakeet-mlx fetches its
  // model implicitly on first use and has no separate pull verb, so we skip it.
  if (provider !== "onnx-asr") {
    return {
      name: "model-warm-pull",
      status: "skipped",
      detail: `${provider} downloads its model on first use — no separate warm-pull.`,
    };
  }

  const bin =
    deps.which("onnx-asr") ?? `${venvDir(deps)}/bin/onnx-asr`;

  deps.log(`Warm-pulling model ${model} (one-time download) …`);
  // `onnx-asr <model> --help` is enough to trigger the model fetch+cache
  // without needing an audio file; if that interface changes the worst case is
  // a no-op skip (the model still lazy-loads on first transcription).
  const r = await deps.run([bin, model, "--help"]);
  if (r.exitCode === 0) {
    return {
      name: "model-warm-pull",
      status: "ok",
      detail: `Model ${model} cached.`,
    };
  }
  return {
    name: "model-warm-pull",
    status: "skipped",
    detail: `Could not warm-pull ${model} now (exit ${r.exitCode}); it will download on first transcription.`,
  };
}

/**
 * Verify the install by re-running the EXISTING detector
 * (`computeBackendAvailability`). Single source of truth: if the SPA would
 * show this backend as available, so do we.
 */
async function verifyBackend(deps: InstallDeps, provider: string): Promise<InstallStep> {
  let scribeConfig: ScribeConfig;
  try {
    scribeConfig = await (deps.loadScribeConfig ?? loadConfig)();
  } catch {
    scribeConfig = {};
  }
  const report = await computeBackendAvailability({
    which: deps.which,
    scribeConfig,
  });
  const verdict = report.transcribe[provider];
  if (!verdict) {
    return {
      name: "verify",
      status: "failed",
      detail: `Detector returned no verdict for ${provider}.`,
    };
  }
  if (verdict.status === "available") {
    return { name: "verify", status: "ok", detail: verdict.detail };
  }
  // "warning" means the backend BINARY is installed but a secondary dependency
  // the operator must address remains (e.g. ffmpeg missing on macOS, where we
  // instruct `brew install ffmpeg` rather than driving it). The install itself
  // succeeded — treat it as a partial success ("skipped", non-fatal) carrying
  // the detector's own fix, NOT a hard failure that exits 1 on an installed box.
  if (verdict.status === "warning") {
    return {
      name: "verify",
      status: "skipped",
      detail: `${verdict.detail}${verdict.fix ? " " + verdict.fix : ""}`,
    };
  }
  // unavailable / unknown / etc — the backend isn't usable. Hard fail.
  return {
    name: "verify",
    status: "failed",
    detail: `${verdict.detail}${verdict.fix ? " " + verdict.fix : ""}`,
  };
}
