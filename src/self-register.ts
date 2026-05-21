/**
 * `selfRegister()` — stamp scribe's entry into `~/.parachute/services.json`
 * on `parachute-scribe serve` boot.
 *
 * Why this exists, in one sentence: hub-as-supervisor (v0.6) reads
 * `~/.parachute/services.json` to know which modules exist on the host; a
 * module that doesn't self-register is invisible to `parachute status`,
 * `parachute restart`, the admin SPA module catalog, and the live
 * `/.well-known/parachute.json` builder.
 *
 * Mirrors `parachute-runner/src/self-register.ts` (canonical going
 * forward) and `parachute-vault/src/self-register.ts` (the original POC
 * for retiring hub's `FIRST_PARTY_FALLBACKS`).
 *
 * Two reads from the file before we write:
 *   1. The existing row's `port` is preserved on subsequent boots so an
 *      operator (or hub) who set `scribe.port = 1947` in services.json
 *      stays at 1947 across restarts — even if the env var that pointed
 *      scribe at 1947 is later unset. Same first-boot-vs-subsequent-boot
 *      rule scribe + agent settled (scribe#40, paraclaw#145). When this
 *      is a first run, stamp the resolved port (cli arg, env, or
 *      default 1943).
 *   2. The existing row's hub-stamped fields (`installDir` from
 *      parachute-hub#84, future `uiUrl` / `managementUrl`) merge through
 *      because `upsertService` spreads `entry` last. We re-stamp our own
 *      `installDir = resolveProjectRoot()` regardless — hub#293/#302 made
 *      the runtime install path stamp installDir, and we want services.json
 *      to keep that resolution after a `git pull` moves the checkout.
 *
 * Manifest is the source of truth: paths, health, displayName, tagline,
 * stripPrefix are read from `.parachute/module.json` rather than hardcoded
 * in the call site. This is the load-bearing piece of scribe#38 — once all
 * four committed-core modules self-register from their own manifest, hub's
 * `FIRST_PARTY_FALLBACKS[scribe]` retires.
 *
 * Failure mode: any error during the read or write is logged + returned
 * as `{ok: false}`. The daemon still serves locally if module.json is
 * missing, services.json is unwritable, malformed, or fights with a
 * concurrent writer — the operator just won't see scribe in
 * `parachute status` until the underlying issue clears.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import pkg from "../package.json" with { type: "json" };
import { type ServiceEntry, readServiceEntry, upsertService } from "./services-manifest.ts";

/**
 * Subset of `.parachute/module.json` we care about for self-registration.
 * `manifestName` is the row's `name` field in services.json (e.g.
 * `"parachute-scribe"`). The bare `name` ("scribe") is the short slug hub
 * uses for `SERVICE_SPECS`.
 */
interface ModuleManifest {
  name: string;
  manifestName: string;
  displayName?: string;
  tagline?: string;
  paths?: string[];
  health?: string;
  stripPrefix?: boolean;
}

export type SelfRegisterOpts = {
  /**
   * The port scribe just bound. Used only as the first-run fallback —
   * if services.json already has an entry, we re-stamp the existing port
   * unchanged to preserve operator/hub overrides.
   */
  boundPort: number;
  /**
   * Absolute path to the scribe package root (where `.parachute/` and
   * `package.json` live). Stamped as `installDir` so hub can resolve
   * `parachute restart scribe` back to this checkout.
   */
  installDir: string;
  /**
   * Override the services.json location (tests). Defaults to
   * `$PARACHUTE_HOME/services.json`.
   */
  manifestPath?: string;
  /**
   * Override the `.parachute/module.json` location (tests). Defaults to
   * `<installDir>/.parachute/module.json`.
   */
  moduleManifestPath?: string;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type SelfRegisterResult = {
  ok: boolean;
  /** The path we wrote to (or attempted to write to). */
  manifestPath: string;
  /** True when services.json already had a row for scribe before we wrote. */
  hadExistingEntry: boolean;
  /** The port we ended up stamping (existing-entry port or boundPort). */
  portWritten: number;
  /** Set when ok=false — the error swallowed by the caller. */
  error?: Error;
};

function readModuleManifest(p: string): ModuleManifest {
  const raw = JSON.parse(readFileSync(p, "utf8"));
  if (!raw || typeof raw !== "object") {
    throw new Error(`module manifest at ${p} is not an object`);
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.manifestName !== "string" || m.manifestName.length === 0) {
    throw new Error(`module manifest at ${p} is missing "manifestName"`);
  }
  return raw as ModuleManifest;
}

/**
 * Self-register scribe's services.json entry. Best-effort: returns
 * `{ok: false, error}` on any failure rather than throwing, so the caller's
 * "log + continue" branch is one shape regardless of failure mode.
 *
 * Idempotent against repeated calls — the canonical case is `serve()`
 * invoking this once per boot, but if the daemon restarts in-process (PUT
 * config triggering a reload, etc.) repeated calls converge to the same
 * disk state.
 */
export function selfRegister(opts: SelfRegisterOpts): SelfRegisterResult {
  const logger = opts.logger ?? console;
  const manifestPath = opts.manifestPath; // undefined → resolveManifestPath() default
  const moduleManifestPath =
    opts.moduleManifestPath ?? path.join(opts.installDir, ".parachute", "module.json");

  let module: ModuleManifest;
  try {
    if (!existsSync(moduleManifestPath)) {
      logger.warn(
        `[scribe] skipped self-register: .parachute/module.json not found at ${moduleManifestPath}`,
      );
      return {
        ok: false,
        manifestPath: manifestPath ?? "~/.parachute/services.json",
        hadExistingEntry: false,
        portWritten: opts.boundPort,
        error: new Error(`module.json not found at ${moduleManifestPath}`),
      };
    }
    module = readModuleManifest(moduleManifestPath);
  } catch (e) {
    const err = e as Error;
    logger.warn(`[scribe] skipped self-register: ${err.message}`);
    return {
      ok: false,
      manifestPath: manifestPath ?? "~/.parachute/services.json",
      hadExistingEntry: false,
      portWritten: opts.boundPort,
      error: err,
    };
  }

  let existing: ServiceEntry | undefined;
  try {
    existing = readServiceEntry(module.manifestName, manifestPath);
  } catch (e) {
    // Malformed services.json — don't blow up boot. The first write below
    // would also throw; we trade an early bail for a noisy log so the
    // operator sees what's wrong.
    const err = e as Error;
    logger.warn(`[scribe] skipped self-register: ${err.message}`);
    return {
      ok: false,
      manifestPath: manifestPath ?? "~/.parachute/services.json",
      hadExistingEntry: false,
      portWritten: opts.boundPort,
      error: err,
    };
  }

  const portToWrite = existing?.port ?? opts.boundPort;
  const entry: ServiceEntry = {
    name: module.manifestName,
    port: portToWrite,
    paths: module.paths ?? ["/scribe"],
    health: module.health ?? "/health",
    version: pkg.version,
    installDir: opts.installDir,
  };
  if (module.displayName !== undefined) entry.displayName = module.displayName;
  if (module.tagline !== undefined) entry.tagline = module.tagline;
  if (module.stripPrefix !== undefined) entry.stripPrefix = module.stripPrefix;

  try {
    upsertService(entry, manifestPath);
  } catch (e) {
    const err = e as Error;
    logger.warn(`[scribe] skipped self-register: ${err.message}`);
    return {
      ok: false,
      manifestPath: manifestPath ?? "~/.parachute/services.json",
      hadExistingEntry: existing !== undefined,
      portWritten: portToWrite,
      error: err,
    };
  }

  logger.log(
    `[scribe] self-registered services.json entry (port=${portToWrite}, installDir=${opts.installDir}${existing ? ", existing entry merged" : ", first boot"})`,
  );
  return {
    ok: true,
    manifestPath: manifestPath ?? "~/.parachute/services.json",
    hadExistingEntry: existing !== undefined,
    portWritten: portToWrite,
  };
}

/**
 * Resolve the scribe package root — the directory containing
 * `.parachute/module.json` + `package.json`. `import.meta.dir` points at
 * `src/`; walk up one level.
 */
export function resolveProjectRoot(): string {
  return path.resolve(import.meta.dir, "..");
}
