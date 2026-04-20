import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type VaultContext = {
  tag: string;
  exclude_tag?: string | string[];
  include_metadata?: string[];
};

export type ScribeConfig = {
  transcribe?: {
    provider?: string;
  };
  cleanup?: {
    provider?: string;
    model?: string;
    default?: boolean;
  };
  vault?: {
    url: string;
    token?: string;
    contexts?: VaultContext[];
    cache_ttl_seconds?: number;
  };
};

function parachuteHome(): string {
  return process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
}

export function resolveDefaultConfigPath(): string {
  return join(parachuteHome(), "scribe", "config.json");
}

function legacyConfigPath(): string {
  return join(parachuteHome(), "scribe.config.json");
}

function migrateLegacyConfig(canonical: string): void {
  const legacy = legacyConfigPath();
  if (!existsSync(legacy) || existsSync(canonical)) return;
  mkdirSync(dirname(canonical), { recursive: true });
  renameSync(legacy, canonical);
  console.log(`scribe: migrated config ${legacy} → ${canonical}`);
}

async function readJsonConfig(path: string): Promise<ScribeConfig | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return (await file.json()) as ScribeConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config ${path}: ${message}`);
  }
}

export async function loadConfig(path?: string): Promise<ScribeConfig> {
  const explicit = path ?? process.env.SCRIBE_CONFIG;
  if (explicit) {
    return (await readJsonConfig(explicit)) ?? {};
  }

  const canonical = resolveDefaultConfigPath();
  migrateLegacyConfig(canonical);

  for (const candidate of [canonical, "./scribe.config.json"]) {
    const result = await readJsonConfig(candidate);
    if (result !== undefined) return result;
  }

  return {};
}
