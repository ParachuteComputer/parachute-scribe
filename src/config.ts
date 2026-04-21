import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ScribeConfig = {
  transcribe?: {
    provider?: string;
  };
  cleanup?: {
    provider?: string;
    model?: string;
    default?: boolean;
    /**
     * Optional full override of the built-in cleanup system prompt. When set,
     * the caller owns the entire instruction to the cleanup LLM. The
     * proper-nouns block (from the request `context` part) is still appended
     * per context_template.
     */
    system_prompt?: string;
    /**
     * Optional template for how the proper-nouns block is appended after
     * the system prompt. Supports one variable: {{proper_nouns}}. When unset,
     * scribe uses its default rule (append `\n\n{proper_nouns}` only if the
     * block is non-empty). When set, the template is always rendered — the
     * caller's template owns its own separators.
     */
    context_template?: string;
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
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config ${path}: ${message}`);
  }
  warnIfStaleVaultBlock(parsed, path);
  return parsed as ScribeConfig;
}

function warnIfStaleVaultBlock(parsed: unknown, path: string): void {
  if (!parsed || typeof parsed !== "object") return;
  if (!("vault" in parsed)) return;
  console.warn(
    `[scribe] "vault" block in ${path} ignored — scribe no longer calls back to vault; callers push context in the request payload now`,
  );
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
