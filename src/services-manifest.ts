import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
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

export function upsertService(
  entry: ServiceEntry,
  path: string = resolveManifestPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const manifest = readManifest(path);
  const idx = manifest.services.findIndex((s) => s.name === entry.name);
  if (idx >= 0) manifest.services[idx] = entry;
  else manifest.services.push(entry);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}
