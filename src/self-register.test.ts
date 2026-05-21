/**
 * Tests for `src/self-register.ts` — services.json self-registration on
 * `parachute-scribe serve` boot. Mirrors `parachute-runner/src/__tests__/
 * self-register.test.ts` (same scenarios, same shape).
 *
 * Coverage:
 *   - First boot: stamps the resolved port + installDir + version +
 *     paths/health/displayName/tagline/stripPrefix from .parachute/module.json
 *   - Subsequent boot: preserves the existing port (operator-override
 *     discipline — paraclaw#145 / scribe#40 shape)
 *   - Hub-stamped fields on a prior row survive the merge (installDir from
 *     parachute-hub#84)
 *   - Idempotent: re-running with the same opts doesn't drift the file
 *   - Sibling entries (vault, runner, etc.) survive
 *   - Best-effort: missing .parachute/module.json yields {ok:false} + warn
 *   - Best-effort: malformed module.json yields {ok:false} + warn
 *   - Best-effort: malformed services.json yields {ok:false} + warn
 *   - Best-effort: unwritable target yields {ok:false} + warn
 *   - resolveProjectRoot points at the package root (contains module.json)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveProjectRoot, selfRegister } from "./self-register.ts";

interface CapturedLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  warnings: string[];
  logs: string[];
  errors: string[];
}

function makeLogger(): CapturedLogger {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    log: (msg: string) => logs.push(msg),
    warn: (msg: string) => warnings.push(msg),
    error: (msg: string) => errors.push(msg),
    logs,
    warnings,
    errors,
  };
}

/**
 * Build a tmp fake installDir tree with `.parachute/module.json` so
 * `selfRegister` reads its manifest from a fixture rather than the
 * live repo. Mirrors scribe's real `.parachute/module.json` shape.
 */
function makeFakeInstall(root: string, overrides: Record<string, unknown> = {}): string {
  fs.mkdirSync(path.join(root, ".parachute"), { recursive: true });
  const manifest = {
    name: "scribe",
    manifestName: "parachute-scribe",
    displayName: "Scribe",
    tagline: "Audio transcription (Whisper-compatible API + LLM cleanup)",
    kind: "api",
    port: 1943,
    paths: ["/scribe"],
    health: "/health",
    stripPrefix: true,
    startCmd: ["parachute-scribe", "serve"],
    ...overrides,
  };
  fs.writeFileSync(
    path.join(root, ".parachute", "module.json"),
    JSON.stringify(manifest, null, 2),
  );
  return root;
}

let tmpDir: string;
let installDir: string;
let manifestPath: string;
let logger: CapturedLogger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-self-register-"));
  installDir = path.join(tmpDir, "install");
  makeFakeInstall(installDir);
  manifestPath = path.join(tmpDir, "services.json");
  logger = makeLogger();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("selfRegister — first boot", () => {
  test("writes a fresh services.json with our entry", () => {
    const result = selfRegister({
      boundPort: 1943,
      installDir,
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(true);
    expect(result.hadExistingEntry).toBe(false);
    expect(result.portWritten).toBe(1943);

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services).toHaveLength(1);
    const entry = raw.services[0]!;
    expect(entry.name).toBe("parachute-scribe");
    expect(entry.port).toBe(1943);
    expect(entry.paths).toEqual(["/scribe"]);
    expect(entry.health).toBe("/health");
    expect(entry.installDir).toBe(installDir);
    expect(entry.displayName).toBe("Scribe");
    expect(entry.tagline).toBe(
      "Audio transcription (Whisper-compatible API + LLM cleanup)",
    );
    expect(entry.stripPrefix).toBe(true);
    expect(typeof entry.version).toBe("string");
  });

  test("logs a single info-level line on success", () => {
    selfRegister({
      boundPort: 1943,
      installDir,
      manifestPath,
      logger,
    });
    expect(logger.logs).toHaveLength(1);
    expect(logger.logs[0]).toContain("self-registered");
    expect(logger.warnings).toHaveLength(0);
  });

  test("manifest fields without optional fields still register correctly", () => {
    // Stripped-down module.json missing the optional fields — verifies the
    // helper degrades gracefully and doesn't stamp `undefined` keys.
    const minimal = path.join(tmpDir, "minimal-install");
    fs.mkdirSync(path.join(minimal, ".parachute"), { recursive: true });
    fs.writeFileSync(
      path.join(minimal, ".parachute", "module.json"),
      JSON.stringify({
        name: "scribe",
        manifestName: "parachute-scribe",
      }),
    );
    const result = selfRegister({
      boundPort: 1943,
      installDir: minimal,
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(true);
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    // Defaults from selfRegister apply when module.json omits them.
    expect(raw.services[0]?.paths).toEqual(["/scribe"]);
    expect(raw.services[0]?.health).toBe("/health");
    // Optional fields stay absent rather than stamped as undefined.
    expect("displayName" in (raw.services[0] ?? {})).toBe(false);
    expect("tagline" in (raw.services[0] ?? {})).toBe(false);
    expect("stripPrefix" in (raw.services[0] ?? {})).toBe(false);
  });
});

describe("selfRegister — subsequent boot (existing entry)", () => {
  test("preserves an operator-set port from services.json", () => {
    // Seed with a port the operator chose by hand.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "parachute-scribe",
            port: 1947, // operator override, not the default
            paths: ["/scribe"],
            health: "/health",
            version: "0.4.3",
            installDir: "/old/checkout",
          },
        ],
      }),
    );
    const result = selfRegister({
      boundPort: 1943,
      installDir,
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(true);
    expect(result.hadExistingEntry).toBe(true);
    // The result.portWritten should be the operator-override port, NOT
    // boundPort — that's the load-bearing invariant for restart-stability.
    expect(result.portWritten).toBe(1947);

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services[0]?.port).toBe(1947);
    expect(raw.services[0]?.installDir).toBe(installDir); // we re-stamp this
  });

  test("hub-stamped fields on prior row survive the merge", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "parachute-scribe",
            port: 1943,
            paths: ["/scribe"],
            health: "/health",
            version: "0.4.3",
            // Hub-stamped fields (parachute-hub#84 stamps installDir; a
            // future hub may stamp uiUrl / managementUrl). The merge
            // invariant: we re-stamp `installDir` ourselves, but any
            // field scribe doesn't author rides through.
            hubStampedField: "preserve-me",
            uiUrl: "/scribe/admin",
          },
        ],
      }),
    );
    selfRegister({
      boundPort: 1943,
      installDir,
      manifestPath,
      logger,
    });
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services[0]?.hubStampedField).toBe("preserve-me");
    expect(raw.services[0]?.uiUrl).toBe("/scribe/admin");
    expect(raw.services[0]?.installDir).toBe(installDir);
  });

  test("idempotent — calling twice doesn't drift the file", () => {
    const opts = {
      boundPort: 1943,
      installDir,
      manifestPath,
      logger,
    };
    selfRegister(opts);
    const first = fs.readFileSync(manifestPath, "utf8");
    selfRegister(opts);
    const second = fs.readFileSync(manifestPath, "utf8");
    expect(second).toBe(first);
  });

  test("preserves sibling entries", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          { name: "parachute-vault", port: 1940, paths: ["/vault"], health: "/h", version: "1" },
          { name: "runner", port: 1945, paths: ["/runner"], health: "/h", version: "1" },
        ],
      }),
    );
    selfRegister({
      boundPort: 1943,
      installDir,
      manifestPath,
      logger,
    });
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<{ name: string }>;
    };
    expect(raw.services.map((s) => s.name).sort()).toEqual([
      "parachute-scribe",
      "parachute-vault",
      "runner",
    ]);
  });
});

describe("selfRegister — best-effort failure modes", () => {
  test("missing .parachute/module.json yields {ok:false} + warn log, doesn't throw", () => {
    const empty = path.join(tmpDir, "no-manifest");
    fs.mkdirSync(empty, { recursive: true });
    const result = selfRegister({
      boundPort: 1943,
      installDir: empty,
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(logger.warnings.length).toBeGreaterThan(0);
    expect(logger.warnings[0]).toContain("module.json not found");
    // services.json must remain untouched on the manifest-missing path.
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  test("malformed module.json yields {ok:false} + warn log, doesn't throw", () => {
    const bad = path.join(tmpDir, "bad-manifest");
    fs.mkdirSync(path.join(bad, ".parachute"), { recursive: true });
    fs.writeFileSync(path.join(bad, ".parachute", "module.json"), "{not json");
    const result = selfRegister({
      boundPort: 1943,
      installDir: bad,
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  test("module.json missing manifestName yields {ok:false} + warn log", () => {
    const bad = path.join(tmpDir, "no-manifestName");
    fs.mkdirSync(path.join(bad, ".parachute"), { recursive: true });
    fs.writeFileSync(
      path.join(bad, ".parachute", "module.json"),
      JSON.stringify({ name: "scribe" }), // manifestName missing
    );
    const result = selfRegister({
      boundPort: 1943,
      installDir: bad,
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("manifestName");
  });

  test("malformed services.json yields {ok:false} + warn log, doesn't throw", () => {
    fs.writeFileSync(manifestPath, "{not json");
    const result = selfRegister({
      boundPort: 1943,
      installDir,
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(logger.warnings.length).toBeGreaterThan(0);
    expect(logger.warnings[0]).toContain("skipped self-register");
  });

  test("unwritable manifest path yields {ok:false} + warn log, doesn't throw", () => {
    // Point at a path under a file (not a dir) — mkdir will fail.
    const blocker = path.join(tmpDir, "im-a-file-not-a-dir");
    fs.writeFileSync(blocker, "");
    const unwritable = path.join(blocker, "services.json");
    const result = selfRegister({
      boundPort: 1943,
      installDir,
      manifestPath: unwritable,
      logger,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(logger.warnings.length).toBeGreaterThan(0);
  });
});

describe("selfRegister — moduleManifestPath override", () => {
  test("tests can point at an arbitrary manifest path", () => {
    // Verifies the test seam — wire installDir at one location, manifest
    // at another, useful for fixtures that don't want to fake an install
    // tree.
    const customManifest = path.join(tmpDir, "custom-module.json");
    fs.writeFileSync(
      customManifest,
      JSON.stringify({
        name: "scribe",
        manifestName: "parachute-scribe-custom",
        paths: ["/custom"],
        health: "/custom-health",
      }),
    );
    const result = selfRegister({
      boundPort: 1943,
      installDir,
      manifestPath,
      moduleManifestPath: customManifest,
      logger,
    });
    expect(result.ok).toBe(true);
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services[0]?.name).toBe("parachute-scribe-custom");
    expect(raw.services[0]?.paths).toEqual(["/custom"]);
    expect(raw.services[0]?.health).toBe("/custom-health");
  });
});

describe("resolveProjectRoot", () => {
  test("points at a directory containing .parachute/module.json", () => {
    const root = resolveProjectRoot();
    const manifestFile = path.join(root, ".parachute", "module.json");
    expect(fs.existsSync(manifestFile)).toBe(true);
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      name: string;
      manifestName: string;
    };
    expect(m.name).toBe("scribe");
    expect(m.manifestName).toBe("parachute-scribe");
  });
});
