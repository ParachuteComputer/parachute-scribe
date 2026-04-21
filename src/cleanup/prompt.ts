const BASE_PROMPT = `You clean up voice memo transcripts. Your job:

- Remove filler words (um, uh, like, you know, I mean, so, basically, right)
- Fix punctuation, capitalization, and sentence boundaries
- Break run-on sentences into proper paragraphs
- Keep the speaker's voice, tone, and meaning — don't rewrite, just clean
- Don't summarize, don't add anything, don't change meaning

Return only the cleaned text. No commentary, no preamble.`;

export const CLEANUP_PROMPT = BASE_PROMPT;

export type CleanupPromptOpts = {
  /**
   * Full override of the default base prompt. When set, `BASE_PROMPT` is
   * replaced verbatim — the user is responsible for the entire system prompt.
   */
  systemPrompt?: string;
  /**
   * Template for how the proper-nouns block is appended after the base prompt.
   * Only variable is `{{proper_nouns}}`. When unset, the default is to append
   * `\n\n${proper_nouns}` only if proper_nouns is non-empty (no dangling
   * whitespace when there's nothing to append). When set, the template is
   * always rendered, even with an empty substitution — the caller's template
   * owns its own separators.
   */
  contextTemplate?: string;
};

export function buildCleanupPrompt(
  properNouns?: string,
  opts?: CleanupPromptOpts,
): string {
  const base = opts?.systemPrompt ?? BASE_PROMPT;
  const nouns = properNouns?.trim() ?? "";

  if (opts?.contextTemplate !== undefined) {
    return base + opts.contextTemplate.replaceAll("{{proper_nouns}}", nouns);
  }

  if (!nouns) return base;
  return `${base}\n\n${nouns}`;
}
