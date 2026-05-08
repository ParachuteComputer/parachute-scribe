import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePort } from "./port-resolve.ts";
import type { ServiceEntry } from "./services-manifest.ts";

const SCRIBE_ENTRY: ServiceEntry = {
  name: "parachute-scribe",
  port: 1943,
  paths: ["/scribe"],
  health: "/health",
  version: "0.4.0",
};

const noEntry = (_name: string) => undefined;

describe("resolvePort", () => {
  test("services.json entry wins over env and default (operator-set persists)", () => {
    const result = resolvePort({
      readEntry: () => ({ ...SCRIBE_ENTRY, port: 1947 }),
      env: { SCRIBE_PORT: "9999", PORT: "1944" },
    });
    expect(result).toEqual({ port: 1947, source: "services.json" });
  });

  test("services.json with canonical 1943 → respect it (don't drift to env)", () => {
    const result = resolvePort({
      readEntry: () => SCRIBE_ENTRY,
      env: { PORT: "1944" }, // hub's stale port-assigner
    });
    expect(result).toEqual({ port: 1943, source: "services.json" });
  });

  test("no services.json entry → SCRIBE_PORT env wins", () => {
    const result = resolvePort({
      readEntry: noEntry,
      env: { SCRIBE_PORT: "5000", PORT: "1944" },
    });
    expect(result).toEqual({ port: 5000, source: "SCRIBE_PORT" });
  });

  test("no entry, no SCRIBE_PORT → PORT env wins", () => {
    const result = resolvePort({
      readEntry: noEntry,
      env: { PORT: "1944" },
    });
    expect(result).toEqual({ port: 1944, source: "PORT" });
  });

  test("no entry, no env → canonical default 1943", () => {
    const result = resolvePort({
      readEntry: noEntry,
      env: {},
    });
    expect(result).toEqual({ port: 1943, source: "default" });
  });

  test("empty SCRIBE_PORT string → falls through to PORT", () => {
    const result = resolvePort({
      readEntry: noEntry,
      env: { SCRIBE_PORT: "", PORT: "1944" },
    });
    expect(result).toEqual({ port: 1944, source: "PORT" });
  });

  test("malformed services.json port (string 'oops') → falls through to env", () => {
    const result = resolvePort({
      readEntry: () => ({ ...SCRIBE_ENTRY, port: "oops" as unknown as number }),
      env: { PORT: "1944" },
    });
    expect(result).toEqual({ port: 1944, source: "PORT" });
  });

  test("malformed services.json port (zero) → falls through to env", () => {
    const result = resolvePort({
      readEntry: () => ({ ...SCRIBE_ENTRY, port: 0 }),
      env: { PORT: "1944" },
    });
    expect(result).toEqual({ port: 1944, source: "PORT" });
  });

  test("services.json port as numeric string → accepted", () => {
    // Defensive: hand-edited manifests sometimes quote numbers.
    const result = resolvePort({
      readEntry: () => ({ ...SCRIBE_ENTRY, port: "1943" as unknown as number }),
      env: {},
    });
    expect(result).toEqual({ port: 1943, source: "services.json" });
  });

  test("readEntry throws (malformed manifest) → falls through to env without crashing boot", () => {
    const result = resolvePort({
      readEntry: () => {
        throw new Error("manifest is malformed");
      },
      env: { SCRIBE_PORT: "1943" },
    });
    expect(result).toEqual({ port: 1943, source: "SCRIBE_PORT" });
  });

  test("port out of TCP range (70000) → rejected, falls through", () => {
    const result = resolvePort({
      readEntry: () => ({ ...SCRIBE_ENTRY, port: 70000 }),
      env: { PORT: "1944" },
    });
    expect(result).toEqual({ port: 1944, source: "PORT" });
  });

  test("custom canonicalDefault is honored", () => {
    const result = resolvePort({
      readEntry: noEntry,
      env: {},
      canonicalDefault: 1943,
    });
    expect(result).toEqual({ port: 1943, source: "default" });
  });

  test("custom serviceName is forwarded to readEntry", () => {
    let lookedUp = "";
    const result = resolvePort({
      readEntry: (name) => {
        lookedUp = name;
        return undefined;
      },
      env: {},
      serviceName: "scribe-staging",
    });
    expect(lookedUp).toBe("scribe-staging");
    expect(result.source).toBe("default");
  });
});

describe("resolvePort — integration with real services.json (scribe#40)", () => {
  // End-to-end: write a real services.json under a tmp PARACHUTE_HOME, then
  // call `resolvePort()` with no `readEntry` injection so it goes through
  // the real `readServiceEntry` → `readManifest` → file path.
  let dir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scribe-port-resolve-"));
    originalHome = process.env.PARACHUTE_HOME;
    process.env.PARACHUTE_HOME = dir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = originalHome;
    rmSync(dir, { recursive: true, force: true });
  });

  test("operator-set port=1947 in services.json wins over PORT=1944 in env", () => {
    // Write a services.json that pins scribe to 1947 (operator-set).
    writeFileSync(
      join(dir, "services.json"),
      JSON.stringify({
        services: [
          {
            name: "parachute-scribe",
            port: 1947,
            paths: ["/scribe"],
            health: "/health",
            version: "0.4.0",
          },
        ],
      }),
    );

    // Simulate the scribe#40 conditions: hub's port-assigner has stamped
    // PORT=1944 into scribe's env. Without this fix, scribe would have
    // used 1944.
    const result = resolvePort({ env: { PORT: "1944" } });
    expect(result).toEqual({ port: 1947, source: "services.json" });
  });

  test("no scribe entry in services.json → canonical default 1943", () => {
    writeFileSync(
      join(dir, "services.json"),
      JSON.stringify({
        services: [
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/"],
            health: "/health",
            version: "1.0.0",
          },
        ],
      }),
    );
    const result = resolvePort({ env: {} });
    expect(result).toEqual({ port: 1943, source: "default" });
  });

  test("no services.json file at all → canonical default 1943", () => {
    const result = resolvePort({ env: {} });
    expect(result).toEqual({ port: 1943, source: "default" });
  });

  test("services.json port=1944 → respects it (operator wins, even when 'wrong')", () => {
    // If the operator (or hub) recorded 1944 and scribe is rebooted, scribe
    // binds 1944. The operator can correct this by editing services.json;
    // scribe's job is to honor the contract, not second-guess it.
    writeFileSync(
      join(dir, "services.json"),
      JSON.stringify({
        services: [
          {
            name: "parachute-scribe",
            port: 1944,
            paths: ["/scribe"],
            health: "/health",
            version: "0.4.0",
          },
        ],
      }),
    );
    const result = resolvePort({ env: {} });
    expect(result).toEqual({ port: 1944, source: "services.json" });
  });
});
