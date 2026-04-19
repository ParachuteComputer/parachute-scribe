import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveManifestPath, upsertService, type ServiceEntry } from "./services-manifest.ts";

const SCRIBE_ENTRY: ServiceEntry = {
  name: "parachute-scribe",
  port: 3200,
  paths: ["/"],
  health: "/health",
  version: "0.1.0",
};

describe("services-manifest", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-manifest-"));
    path = join(dir, "services.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates manifest with single entry when file does not exist", () => {
    upsertService(SCRIBE_ENTRY, path);
    const got = JSON.parse(readFileSync(path, "utf8"));
    expect(got.services).toHaveLength(1);
    expect(got.services[0]).toEqual(SCRIBE_ENTRY);
  });

  test("updates existing entry by name (idempotent second start)", () => {
    upsertService(SCRIBE_ENTRY, path);
    upsertService({ ...SCRIBE_ENTRY, port: 3300, version: "0.2.0" }, path);
    const got = JSON.parse(readFileSync(path, "utf8"));
    expect(got.services).toHaveLength(1);
    expect(got.services[0].port).toBe(3300);
    expect(got.services[0].version).toBe("0.2.0");
  });

  test("preserves entries owned by other services", () => {
    writeFileSync(
      path,
      JSON.stringify({
        services: [
          { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "1.0.0" },
        ],
      }),
    );
    upsertService(SCRIBE_ENTRY, path);
    const got = JSON.parse(readFileSync(path, "utf8"));
    expect(got.services).toHaveLength(2);
    const vault = got.services.find((s: ServiceEntry) => s.name === "parachute-vault");
    const scribe = got.services.find((s: ServiceEntry) => s.name === "parachute-scribe");
    expect(vault?.port).toBe(1940);
    expect(scribe?.port).toBe(3200);
  });

  test("throws on malformed manifest rather than clobbering it", () => {
    writeFileSync(path, "not json at all");
    expect(() => upsertService(SCRIBE_ENTRY, path)).toThrow();
  });

  test("resolveManifestPath honors PARACHUTE_HOME", () => {
    const orig = process.env.PARACHUTE_HOME;
    process.env.PARACHUTE_HOME = "/opt/parachute";
    try {
      expect(resolveManifestPath()).toBe("/opt/parachute/services.json");
    } finally {
      if (orig === undefined) delete process.env.PARACHUTE_HOME;
      else process.env.PARACHUTE_HOME = orig;
    }
  });
});
