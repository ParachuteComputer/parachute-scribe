import type { ScribeConfig, VaultContext } from "./config.ts";

type NoteRow = {
  path: string;
  tags?: string[];
  metadata?: {
    summary?: string;
    aliases?: string[] | string;
    [k: string]: unknown;
  };
};

type CacheEntry = { at: number; value: string };
const cache = new Map<string, CacheEntry>();

const DEFAULT_TTL_SECONDS = 300;

export function clearVaultCache() {
  cache.clear();
}

export async function fetchProperNouns(config: ScribeConfig): Promise<string> {
  const vault = config.vault;
  if (!vault?.url || !vault.contexts?.length) return "";

  const ttlMs = (vault.cache_ttl_seconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const cacheKey = JSON.stringify({ url: vault.url, contexts: vault.contexts });
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  try {
    const sections: string[] = [];
    for (const ctx of vault.contexts) {
      const notes = await queryVault(vault.url, vault.token, ctx);
      if (!notes.length) continue;
      const heading = prettifyTag(ctx.tag);
      const lines = notes
        .map((n) => formatNoteLine(n))
        .filter((line): line is string => line !== null);
      if (!lines.length) continue;
      sections.push(`${heading}:\n${lines.join("\n")}`);
    }

    const body = sections.length ? buildProperNounsBlock(sections) : "";
    cache.set(cacheKey, { at: Date.now(), value: body });
    return body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[scribe] vault proper-noun fetch failed: ${message}`);
    return "";
  }
}

async function queryVault(
  baseUrl: string,
  token: string | undefined,
  ctx: VaultContext,
): Promise<NoteRow[]> {
  const url = new URL("/api/notes", baseUrl);
  url.searchParams.set("tag", ctx.tag);
  url.searchParams.set("include_content", "false");
  url.searchParams.set("limit", "500");

  const metaFields = ctx.include_metadata?.length
    ? ctx.include_metadata.join(",")
    : "summary,aliases";
  url.searchParams.set("include_metadata", metaFields);

  const exclude = ctx.exclude_tag
    ? Array.isArray(ctx.exclude_tag) ? ctx.exclude_tag : [ctx.exclude_tag]
    : [];
  for (const t of exclude) url.searchParams.append("exclude_tag", t);

  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`vault ${res.status} on ${url.pathname}: ${await res.text()}`);
  }
  const data = (await res.json()) as NoteRow[];

  // Client-side fallback in case the vault build doesn't honor exclude_tag.
  if (!exclude.length) return data;
  return data.filter((n) => !n.tags?.some((t) => exclude.includes(t)));
}

function formatNoteLine(note: NoteRow): string | null {
  if (!note.path) return null;
  const summary = note.metadata?.summary?.toString().trim();
  const aliases = normalizeAliases(note.metadata?.aliases);

  let line = `- [[${note.path}]]`;
  if (summary) line += ` — ${summary}`;
  if (aliases.length) line += ` (also: ${aliases.map((a) => `"${a}"`).join(", ")})`;
  return line;
}

function normalizeAliases(aliases: unknown): string[] {
  if (!aliases) return [];
  if (Array.isArray(aliases)) return aliases.filter((a): a is string => typeof a === "string");
  if (typeof aliases === "string") return aliases.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function prettifyTag(tag: string): string {
  // "person" → "People", "project" → "Projects"
  const map: Record<string, string> = { person: "People", project: "Projects" };
  if (map[tag]) return map[tag]!;
  return tag.charAt(0).toUpperCase() + tag.slice(1) + "s";
}

function buildProperNounsBlock(sections: string[]): string {
  return [
    "## Proper nouns in this vault",
    "",
    "Here are the people and projects the speaker knows. If the transcript mentions any of them (exact match OR alias match), correct the spelling AND wrap the mention as a wikilink using the canonical path shown in brackets.",
    "",
    "Example: if the transcript says \"learn by build\" and \"[[Projects/Learn Vibe Build]]\" has alias \"Learn by Build\", output `[[Projects/Learn Vibe Build]]` (not the raw words, not `[Learn by Build](...)`).",
    "",
    ...sections,
  ].join("\n");
}
