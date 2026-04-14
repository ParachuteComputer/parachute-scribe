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

export async function loadConfig(path?: string): Promise<ScribeConfig> {
  const configPath = path ?? process.env.SCRIBE_CONFIG;
  const candidates = configPath ? [configPath] : ["./scribe.config.json"];

  for (const p of candidates) {
    const file = Bun.file(p);
    if (await file.exists()) {
      try {
        return (await file.json()) as ScribeConfig;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse config ${p}: ${message}`);
      }
    }
  }

  return {};
}
