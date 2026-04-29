/**
 * Parse + format the `context` multipart part that callers send alongside
 * audio in POST /v1/audio/transcriptions.
 *
 * Shape (matches vault's transcription-worker `appendContextPart` output):
 *
 *   {
 *     "entries": [
 *       { "name": "Margaret", "summary": "Close friend", "aliases": ["Marg"] },
 *       { "name": "Learn Vibe Build", "summary": "6-week cohort",
 *         "aliases": ["LVB", "Learn by Build"] }
 *     ]
 *   }
 *
 * Each entry's `name` is the canonical form (typically a note path basename
 * from the sender's vault). Other fields are whitelisted metadata carried
 * through unchanged. When present in the payload, scribe uses this block
 * directly and does NOT call back into any vault — the caller has supplied
 * everything the cleanup LLM needs.
 *
 * DoS caps (scribe#27): individual `name` values are dropped past
 * `MAX_NAME_LEN`; whole-payload bodies past `MAX_PAYLOAD_BYTES` are rejected
 * (parsed as null) so a misbehaving caller can't drag scribe into a
 * GB-sized JSON.parse. A single warn line per request reports the count of
 * dropped entries.
 */

export const MAX_NAME_LEN = 256;
export const MAX_PAYLOAD_BYTES = 1_000_000;

export interface ContextEntry {
  name: string;
  [key: string]: unknown;
}

export interface ContextPayload {
  entries: ContextEntry[];
}

/**
 * Tolerant parser. Accepts either a raw JSON string or a pre-parsed object.
 * Returns null on malformed input (or when a raw string exceeds
 * `MAX_PAYLOAD_BYTES`) so the caller can log and fall through to
 * cleanup-without-proper-nouns rather than 400-ing the whole transcription.
 */
export function parseContextPayload(raw: unknown): ContextPayload | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_PAYLOAD_BYTES) {
      console.warn(
        `[scribe] context payload rejected: ${raw.length} chars exceeds ${MAX_PAYLOAD_BYTES} cap`,
      );
      return null;
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;

  let droppedOversize = 0;
  const valid: ContextEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const rec = e as Record<string, unknown>;
    if (typeof rec.name !== "string" || !rec.name.trim()) continue;
    if (rec.name.length > MAX_NAME_LEN) {
      droppedOversize += 1;
      continue;
    }
    valid.push(rec as ContextEntry);
  }
  if (droppedOversize > 0) {
    console.warn(
      `[scribe] context entries dropped: ${droppedOversize} entry name(s) exceeded ${MAX_NAME_LEN} chars`,
    );
  }
  return { entries: valid };
}

export function buildProperNounsBlockFromEntries(payload: ContextPayload): string {
  if (!payload.entries.length) return "";
  const lines = payload.entries.map(formatEntryLine);
  return [
    "## Known names in this context",
    "",
    "The speaker knows these names. If the transcript mentions any of them (exact match OR alias match), correct the spelling to the canonical form shown here. Do not invent names or add ones that aren't listed.",
    "",
    ...lines,
  ].join("\n");
}

function formatEntryLine(entry: ContextEntry): string {
  let line = `- ${entry.name}`;
  const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
  if (summary) line += ` — ${summary}`;
  const aliases = normalizeAliases(entry.aliases);
  if (aliases.length) line += ` (also: ${aliases.map((a) => `"${a}"`).join(", ")})`;
  return line;
}

function normalizeAliases(aliases: unknown): string[] {
  if (Array.isArray(aliases)) {
    return aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
  }
  if (typeof aliases === "string") {
    return aliases.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
