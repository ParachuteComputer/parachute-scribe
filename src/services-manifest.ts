import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
  displayName?: string;
  tagline?: string;
  /**
   * Hub-stamped fields (e.g. `installDir` from parachute-hub#84) ride on the
   * row even though scribe itself never sets them. We merge rather than
   * replace on upsert so they survive scribe's self-registration writes.
   */
  [key: string]: unknown;
}

interface ServicesManifest {
  services: ServiceEntry[];
}

export function resolveManifestPath(): string {
  const base = process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
  return join(base, "services.json");
}

function readManifest(path: string): ServicesManifest {
  if (!existsSync(path)) return { services: [] };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { services?: unknown }).services)) {
    throw new Error(`services manifest at ${path} is malformed (missing "services" array)`);
  }
  return raw as ServicesManifest;
}

/**
 * Look up the existing entry for a service by name. Returns `undefined` when
 * the manifest doesn't exist yet or doesn't contain an entry for `name`.
 *
 * Used at boot so scribe binds the port the operator (or hub) recorded in
 * services.json, instead of overwriting it with a hardcoded default. See
 * scribe#40 — in v0.4.0 scribe ignored services.json on boot and always
 * stamped the env-derived `PORT`, which silently rewrote a canonical 1943
 * entry to 1944 (the unassigned slot agent picks).
 */
export function readServiceEntry(
  name: string,
  path: string = resolveManifestPath(),
): ServiceEntry | undefined {
  const manifest = readManifest(path);
  return manifest.services.find((s) => s.name === name);
}

export function upsertService(
  entry: ServiceEntry,
  path: string = resolveManifestPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const manifest = readManifest(path);
  const idx = manifest.services.findIndex((s) => s.name === entry.name);
  // Merge rather than replace so fields the hub stamps onto the row
  // (`installDir` from parachute-hub#84, etc.) survive a self-registration
  // pass. Scribe still wins for the fields it owns — port, paths, version,
  // health — because they spread last.
  if (idx >= 0) manifest.services[idx] = { ...manifest.services[idx], ...entry };
  else manifest.services.push(entry);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}
