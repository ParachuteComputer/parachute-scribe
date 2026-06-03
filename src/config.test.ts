import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, migrateClaudeToAnthropic, resolveDefaultConfigPath } from "./config.ts";

describe("config loading + legacy migration", () => {
  let home: string;
  let prevCwd: string;
  let prevHome: string | undefined;
  let prevScribeCfg: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "scribe-home-"));
    prevCwd = process.cwd();
    prevHome = process.env.PARACHUTE_HOME;
    prevScribeCfg = process.env.SCRIBE_CONFIG;
    process.env.PARACHUTE_HOME = home;
    delete process.env.SCRIBE_CONFIG;
    process.chdir(home);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = prevHome;
    if (prevScribeCfg === undefined) delete process.env.SCRIBE_CONFIG;
    else process.env.SCRIBE_CONFIG = prevScribeCfg;
  });

  test("resolveDefaultConfigPath honors PARACHUTE_HOME", () => {
    expect(resolveDefaultConfigPath()).toBe(join(home, "scribe", "config.json"));
  });

  test("reads from the new canonical path when it exists", async () => {
    mkdirSync(join(home, "scribe"), { recursive: true });
    writeFileSync(
      join(home, "scribe", "config.json"),
      JSON.stringify({ cleanup: { provider: "ollama" } }),
    );
    const cfg = await loadConfig();
    expect(cfg.cleanup?.provider).toBe("ollama");
  });

  test("surfaces the auth.required_token block the hub auto-wire writes (scribe#66)", async () => {
    mkdirSync(join(home, "scribe"), { recursive: true });
    writeFileSync(
      join(home, "scribe", "config.json"),
      JSON.stringify({ auth: { required_token: "hub-wired-secret" } }),
    );
    const cfg = await loadConfig();
    expect(cfg.auth?.required_token).toBe("hub-wired-secret");
  });

  test("migrates legacy config on first load and reads contents", async () => {
    const legacy = join(home, "scribe.config.json");
    const canonical = join(home, "scribe", "config.json");
    writeFileSync(legacy, JSON.stringify({ cleanup: { provider: "ollama" } }));

    const cfg = await loadConfig();

    expect(cfg.cleanup?.provider).toBe("ollama");
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(canonical)).toBe(true);
    expect(JSON.parse(readFileSync(canonical, "utf8"))).toEqual({
      cleanup: { provider: "ollama" },
    });
  });

  test("migration is idempotent across repeated loads", async () => {
    const legacy = join(home, "scribe.config.json");
    writeFileSync(legacy, JSON.stringify({ cleanup: { provider: "ollama" } }));
    await loadConfig();
    const cfg = await loadConfig();
    expect(cfg.cleanup?.provider).toBe("ollama");
    expect(existsSync(legacy)).toBe(false);
  });

  test("when both paths exist, new path wins and legacy is left in place", async () => {
    mkdirSync(join(home, "scribe"), { recursive: true });
    writeFileSync(
      join(home, "scribe", "config.json"),
      JSON.stringify({ cleanup: { provider: "new" } }),
    );
    const legacy = join(home, "scribe.config.json");
    writeFileSync(legacy, JSON.stringify({ cleanup: { provider: "legacy" } }));

    const cfg = await loadConfig();

    expect(cfg.cleanup?.provider).toBe("new");
    expect(existsSync(legacy)).toBe(true);
  });

  test("explicit --config path does not trigger migration", async () => {
    const explicit = join(home, "custom.json");
    writeFileSync(explicit, JSON.stringify({ cleanup: { provider: "explicit" } }));
    const legacy = join(home, "scribe.config.json");
    writeFileSync(legacy, JSON.stringify({ cleanup: { provider: "legacy" } }));

    const cfg = await loadConfig(explicit);

    expect(cfg.cleanup?.provider).toBe("explicit");
    expect(existsSync(legacy)).toBe(true);
  });

  test("returns empty config when nothing is present", async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual({});
  });

  test("logs a warning + ignores stale `vault` block (removed in 0.3.0)", async () => {
    mkdirSync(join(home, "scribe"), { recursive: true });
    writeFileSync(
      join(home, "scribe", "config.json"),
      JSON.stringify({
        cleanup: { provider: "ollama" },
        vault: {
          url: "http://localhost:1940",
          contexts: [{ tag: "person" }],
          mode: "fallback",
        },
      }),
    );

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };

    let cfg;
    try {
      cfg = await loadConfig();
    } finally {
      console.warn = origWarn;
    }

    expect(cfg.cleanup?.provider).toBe("ollama");
    expect((cfg as Record<string, unknown>).vault).toBeDefined(); // ignored by typesystem; kept as-is from JSON
    expect(warnings.some((w) => w.includes("\"vault\" block") && w.includes("ignored"))).toBe(true);
  });
});

describe("site#52 — cleanupProvider 'claude' → 'anthropic' migration shim", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevScribeCfg: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "scribe-mig-"));
    prevHome = process.env.PARACHUTE_HOME;
    prevScribeCfg = process.env.SCRIBE_CONFIG;
    process.env.PARACHUTE_HOME = home;
    delete process.env.SCRIBE_CONFIG;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = prevHome;
    if (prevScribeCfg === undefined) delete process.env.SCRIBE_CONFIG;
    else process.env.SCRIBE_CONFIG = prevScribeCfg;
  });

  test("migrateClaudeToAnthropic(): pure rewrite on the in-memory shape", () => {
    const before = { cleanup: { provider: "claude", default: true } };
    const { config, migrated } = migrateClaudeToAnthropic(before);
    expect(migrated).toBe(true);
    expect(config.cleanup?.provider).toBe("anthropic");
    // Sibling fields preserved.
    expect(config.cleanup?.default).toBe(true);
    // Input not mutated.
    expect(before.cleanup.provider).toBe("claude");
  });

  test("migrateClaudeToAnthropic(): no-op when provider is anything else", () => {
    for (const prov of ["anthropic", "ollama", "claude-code", "none"]) {
      const { config, migrated } = migrateClaudeToAnthropic({
        cleanup: { provider: prov },
      });
      expect(migrated).toBe(false);
      expect(config.cleanup?.provider).toBe(prov);
    }
  });

  test("migrateClaudeToAnthropic(): no-op when cleanup block absent", () => {
    const { config, migrated } = migrateClaudeToAnthropic({});
    expect(migrated).toBe(false);
    expect(config).toEqual({});
  });

  test("loadConfig() rewrites disk + returns migrated value on first load", async () => {
    mkdirSync(join(home, "scribe"), { recursive: true });
    const path = join(home, "scribe", "config.json");
    writeFileSync(
      path,
      JSON.stringify({ cleanup: { provider: "claude", default: true } }),
    );

    const cfg = await loadConfig();
    expect(cfg.cleanup?.provider).toBe("anthropic");

    // Disk file rewritten so the migration is one-shot. Sibling fields
    // survive the round-trip.
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.cleanup.provider).toBe("anthropic");
    expect(onDisk.cleanup.default).toBe(true);
  });

  test("loadConfig() migration is idempotent across repeated loads", async () => {
    mkdirSync(join(home, "scribe"), { recursive: true });
    const path = join(home, "scribe", "config.json");
    writeFileSync(path, JSON.stringify({ cleanup: { provider: "claude" } }));

    await loadConfig();
    await loadConfig();
    const final = await loadConfig();
    expect(final.cleanup?.provider).toBe("anthropic");
    expect(JSON.parse(readFileSync(path, "utf8")).cleanup.provider).toBe("anthropic");
  });

  test("loadConfig() logs a one-line migration notice", async () => {
    mkdirSync(join(home, "scribe"), { recursive: true });
    writeFileSync(
      join(home, "scribe", "config.json"),
      JSON.stringify({ cleanup: { provider: "claude" } }),
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await loadConfig();
    } finally {
      console.log = origLog;
    }
    expect(
      logs.some(
        (l) =>
          l.includes("migrating config") &&
          l.includes("claude") &&
          l.includes("anthropic"),
      ),
    ).toBe(true);
  });
});
