import { describe, expect, test } from "bun:test";
import { buildProperNounsBlockFromEntries, parseContextPayload } from "./context.ts";

describe("parseContextPayload", () => {
  test("accepts raw JSON string and returns the payload", () => {
    const raw = JSON.stringify({
      entries: [{ name: "Margaret", summary: "Close friend", aliases: ["Marg"] }],
    });
    const payload = parseContextPayload(raw);
    expect(payload).not.toBeNull();
    expect(payload!.entries).toHaveLength(1);
    expect(payload!.entries[0]!.name).toBe("Margaret");
  });

  test("accepts a pre-parsed object", () => {
    const payload = parseContextPayload({ entries: [{ name: "Aaron" }] });
    expect(payload!.entries).toHaveLength(1);
  });

  test("returns null for malformed JSON string", () => {
    expect(parseContextPayload("not json")).toBeNull();
  });

  test("returns null when entries is missing or not an array", () => {
    expect(parseContextPayload({})).toBeNull();
    expect(parseContextPayload({ entries: "nope" })).toBeNull();
  });

  test("skips entries missing a usable name, keeps the rest", () => {
    const payload = parseContextPayload({
      entries: [
        { name: "Keep", summary: "ok" },
        { summary: "no name" },
        { name: "" },
        { name: "   " },
        { name: "AlsoKeep" },
      ],
    });
    expect(payload!.entries.map((e) => e.name)).toEqual(["Keep", "AlsoKeep"]);
  });

  test("returns empty entries array for empty input (valid, just no context)", () => {
    const payload = parseContextPayload({ entries: [] });
    expect(payload!.entries).toEqual([]);
  });
});

describe("buildProperNounsBlockFromEntries", () => {
  test("returns empty string when no entries", () => {
    expect(buildProperNounsBlockFromEntries({ entries: [] })).toBe("");
  });

  test("formats name + summary + aliases on one line each", () => {
    const block = buildProperNounsBlockFromEntries({
      entries: [
        { name: "Margaret", summary: "Close friend", aliases: ["Marg"] },
        {
          name: "Learn Vibe Build",
          summary: "6-week cohort",
          aliases: ["LVB", "Learn by Build"],
        },
        { name: "Natalie" },
      ],
    });
    expect(block).toContain("## Known names in this context");
    expect(block).toContain("- Margaret — Close friend (also: \"Marg\")");
    expect(block).toContain("- Learn Vibe Build — 6-week cohort (also: \"LVB\", \"Learn by Build\")");
    expect(block).toContain("- Natalie");
    // Solo name with no summary or aliases shouldn't get a trailing dash or parens
    expect(block).not.toContain("- Natalie —");
    expect(block).not.toContain("- Natalie (");
  });

  test("accepts string-encoded aliases (comma-split, trimmed)", () => {
    const block = buildProperNounsBlockFromEntries({
      entries: [{ name: "Sam", aliases: "Samuel, Sammy" as unknown as string[] }],
    });
    expect(block).toContain("(also: \"Samuel\", \"Sammy\")");
  });

  test("ignores unknown metadata fields without crashing", () => {
    const block = buildProperNounsBlockFromEntries({
      entries: [{ name: "Weird", extraField: 42, nested: { a: 1 } }],
    });
    expect(block).toContain("- Weird");
  });
});
