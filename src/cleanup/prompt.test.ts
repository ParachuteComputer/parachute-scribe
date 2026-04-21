import { describe, expect, test } from "bun:test";
import { CLEANUP_PROMPT, buildCleanupPrompt } from "./prompt.ts";

describe("buildCleanupPrompt", () => {
  test("no opts, no proper nouns → returns base prompt unchanged", () => {
    const result = buildCleanupPrompt();
    expect(result).toBe(CLEANUP_PROMPT);
  });

  test("no opts, with proper nouns → appends block with '\\n\\n' separator", () => {
    const result = buildCleanupPrompt("## Proper nouns\n\nPeople:\n- Sam");
    expect(result).toBe(`${CLEANUP_PROMPT}\n\n## Proper nouns\n\nPeople:\n- Sam`);
  });

  test("systemPrompt override → uses override and default-appends proper-nouns block", () => {
    const result = buildCleanupPrompt("NOUNS", {
      systemPrompt: "OVERRIDE",
    });
    expect(result).toBe("OVERRIDE\n\nNOUNS");
    expect(result).not.toContain("voice memo transcripts");
  });

  test("systemPrompt override with empty proper nouns → override only, no trailing separator", () => {
    const result = buildCleanupPrompt(undefined, { systemPrompt: "OVERRIDE" });
    expect(result).toBe("OVERRIDE");
  });

  test("both overrides → systemPrompt + rendered contextTemplate with proper nouns substituted", () => {
    const result = buildCleanupPrompt("NOUNS", {
      systemPrompt: "OVERRIDE",
      contextTemplate: "\n---\n{{proper_nouns}}\n---\n",
    });
    expect(result).toBe("OVERRIDE\n---\nNOUNS\n---\n");
  });

  test("contextTemplate with empty proper nouns → template renders with empty substitution (no dangling newlines)", () => {
    const result = buildCleanupPrompt("", {
      contextTemplate: "[nouns: {{proper_nouns}}]",
    });
    expect(result).toBe(`${CLEANUP_PROMPT}[nouns: ]`);
  });

  test("contextTemplate overrides default '\\n\\n' separator behavior — template owns separators", () => {
    // Without the template, default would prepend "\n\n". With template,
    // the caller's template is the only thing appended to the base prompt.
    const result = buildCleanupPrompt("NOUNS", {
      contextTemplate: " — {{proper_nouns}}",
    });
    expect(result).toBe(`${CLEANUP_PROMPT} — NOUNS`);
  });
});
