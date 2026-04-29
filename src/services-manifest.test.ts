import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveManifestPath, upsertService, type ServiceEntry } from "./services-manifest.ts";

const SCRIBE_ENTRY: ServiceEntry = {
  name: "parachute-scribe",
  port: 1943,
  paths: ["/scribe"],
  health: "/health",
  version: "0.1.0",
  displayName: "Scribe",
  tagline: "Audio transcription (Whisper-compatible API + LLM cleanup)",
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
    upsertService({ ...SCRIBE_ENTRY, port: 1944, version: "0.2.0" }, path);
    const got = JSON.parse(readFileSync(path, "utf8"));
    expect(got.services).toHaveLength(1);
    expect(got.services[0].port).toBe(1944);
    expect(got.services[0].version).toBe("0.2.0");
  });

  test("persists paths, displayName, and tagline fields", () => {
    upsertService(SCRIBE_ENTRY, path);
    const got = JSON.parse(readFileSync(path, "utf8"));
    expect(got.services[0].paths).toEqual(["/scribe"]);
    expect(got.services[0].displayName).toBe("Scribe");
    expect(got.services[0].tagline).toBe(
      "Audio transcription (Whisper-compatible API + LLM cleanup)",
    );
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
    expect(scribe?.port).toBe(1943);
  });

  test("throws on malformed manifest rather than clobbering it", () => {
    writeFileSync(path, "not json at all");
    expect(() => upsertService(SCRIBE_ENTRY, path)).toThrow();
  });

  test("preserves hub-stamped fields on the row (e.g. installDir from parachute-hub#84)", () => {
    // Hub stamps `installDir` onto the row at install time. Scribe's self-
    // registration row shape doesn't know about that field, but the upsert
    // must merge rather than replace so the hub-stamped value survives the
    // second write — otherwise `parachute start scribe` after an auto-start
    // round-trip can't resolve installDir → "unknown service".
    writeFileSync(
      path,
      JSON.stringify({
        services: [
          {
            ...SCRIBE_ENTRY,
            installDir: "/Users/test/.parachute/scribe",
          },
        ],
      }),
    );
    upsertService({ ...SCRIBE_ENTRY, version: "0.5.0" }, path);
    const got = JSON.parse(readFileSync(path, "utf8")) as {
      services: { version: string; installDir?: string }[];
    };
    expect(got.services).toHaveLength(1);
    expect(got.services[0]!.version).toBe("0.5.0");
    expect(got.services[0]!.installDir).toBe("/Users/test/.parachute/scribe");
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
