import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type VaultContext = {
  tag: string;
  exclude_tag?: string | string[];
  include_metadata?: string[];
};

export type VaultMode = "off" | "fallback" | "required";

export const DEFAULT_VAULT_MODE: VaultMode = "fallback";

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
    url?: string;
    token?: string;
    contexts?: VaultContext[];
    cache_ttl_seconds?: number;
    /**
     * How scribe handles the vault backchannel when the request payload does
     * NOT carry a `context` part. Defaults to "fallback" (today's behavior).
     *
     *   - "off"      — never call vault; if no context in payload, no proper nouns
     *   - "fallback" — call vault; if unreachable, continue cleanup with no proper nouns
     *   - "required" — call vault; if unreachable, the cleanup step raises.
     *                  handleTranscription's cleanup-failure wrapper catches it
     *                  and returns 200 with the raw transcription (no cleanup).
     *                  Transcription always survives vault outages.
     */
    mode?: VaultMode;
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
