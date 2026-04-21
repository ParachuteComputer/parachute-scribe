import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveDefaultConfigPath } from "./config.ts";

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
      JSON.stringify({ cleanup: { provider: "claude" } }),
    );
    const cfg = await loadConfig();
    expect(cfg.cleanup?.provider).toBe("claude");
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
    writeFileSync(legacy, JSON.stringify({ cleanup: { provider: "claude" } }));
    await loadConfig();
    const cfg = await loadConfig();
    expect(cfg.cleanup?.provider).toBe("claude");
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
        cleanup: { provider: "claude" },
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

    expect(cfg.cleanup?.provider).toBe("claude");
    expect((cfg as Record<string, unknown>).vault).toBeDefined(); // ignored by typesystem; kept as-is from JSON
    expect(warnings.some((w) => w.includes("\"vault\" block") && w.includes("ignored"))).toBe(true);
  });
});
