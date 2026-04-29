import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_NAME_LEN,
  MAX_PAYLOAD_BYTES,
  buildProperNounsBlockFromEntries,
  parseContextPayload,
} from "./context.ts";

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

describe("parseContextPayload — DoS caps (scribe#27)", () => {
  let warnings: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("rejects raw-string payload over MAX_PAYLOAD_BYTES (returns null + warns)", () => {
    const big = `{"entries":[{"name":"${"x".repeat(MAX_PAYLOAD_BYTES + 100)}"}]}`;
    expect(parseContextPayload(big)).toBeNull();
    expect(warnings.some((w) => w.includes("context payload rejected") && w.includes("cap"))).toBe(true);
  });

  test("drops entries whose name exceeds MAX_NAME_LEN (keeps the rest, warns with count)", () => {
    const oversize = "n".repeat(MAX_NAME_LEN + 1);
    const payload = parseContextPayload({
      entries: [
        { name: "Keep" },
        { name: oversize, summary: "should be dropped" },
        { name: "AlsoKeep" },
        { name: oversize, aliases: ["x"] },
      ],
    });
    expect(payload!.entries.map((e) => e.name)).toEqual(["Keep", "AlsoKeep"]);
    expect(warnings.some((w) => w.includes("context entries dropped") && w.includes("2"))).toBe(true);
  });

  test("name at exactly MAX_NAME_LEN is kept; one over is dropped", () => {
    const exact = "a".repeat(MAX_NAME_LEN);
    const over = "b".repeat(MAX_NAME_LEN + 1);
    const payload = parseContextPayload({
      entries: [{ name: exact }, { name: over }],
    });
    expect(payload!.entries.map((e) => e.name)).toEqual([exact]);
  });

  test("does not warn when no entries are dropped", () => {
    parseContextPayload({ entries: [{ name: "small" }] });
    expect(warnings.filter((w) => w.includes("context entries dropped"))).toHaveLength(0);
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
