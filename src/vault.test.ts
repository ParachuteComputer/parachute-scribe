import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { fetchProperNouns, clearVaultCache } from "./vault.ts";
import { buildCleanupPrompt } from "./cleanup/prompt.ts";
import type { ScribeConfig } from "./config.ts";

type MockRoute = (url: URL) => Response | Promise<Response>;

const realFetch = globalThis.fetch;

function mockFetch(route: MockRoute) {
  globalThis.fetch = (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    return route(url);
  }) as typeof fetch;
}

beforeEach(() => {
  clearVaultCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchProperNouns", () => {
  test("returns empty string when no vault config", async () => {
    const result = await fetchProperNouns({});
    expect(result).toBe("");
  });

  test("builds proper-nouns block from vault contexts", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url.pathname + url.search);
      const tag = url.searchParams.get("tag");
      if (tag === "person") {
        return Response.json([
          { path: "People/Margaret", metadata: { summary: "Close friend", aliases: ["Marg"] } },
          { path: "People/Natalie", metadata: { summary: "Friend in Boulder" } },
        ]);
      }
      if (tag === "project") {
        return Response.json([
          {
            path: "Projects/Learn Vibe Build",
            metadata: { summary: "6-week cohort", aliases: ["LVB", "Learn by Build"] },
          },
        ]);
      }
      return Response.json([]);
    });

    const config: ScribeConfig = {
      vault: {
        url: "http://localhost:1940",
        token: "pvt_test",
        contexts: [
          { tag: "person", exclude_tag: "archived" },
          { tag: "project", exclude_tag: "archived" },
        ],
      },
    };

    const block = await fetchProperNouns(config);

    expect(block).toContain("## Proper nouns in this vault");
    expect(block).toContain("People:");
    expect(block).toContain("- [[People/Margaret]] — Close friend (also: \"Marg\")");
    expect(block).toContain("- [[People/Natalie]] — Friend in Boulder");
    expect(block).toContain("Projects:");
    expect(block).toContain("[[Projects/Learn Vibe Build]]");
    expect(block).toContain("\"Learn by Build\"");

    // Sanity: request included exclude_tag + include_metadata
    expect(calls.some((c) => c.includes("exclude_tag=archived"))).toBe(true);
    expect(calls.some((c) => c.includes("include_metadata=summary%2Caliases"))).toBe(true);
    expect(calls.some((c) => c.includes("include_content=false"))).toBe(true);
  });

  test("client-side filters notes carrying excluded tag if vault ignores param", async () => {
    mockFetch(() =>
      Response.json([
        { path: "People/Active", tags: ["person"], metadata: { summary: "x" } },
        { path: "People/Ghost", tags: ["person", "archived"], metadata: { summary: "old" } },
      ]),
    );

    const config: ScribeConfig = {
      vault: {
        url: "http://localhost:1940",
        contexts: [{ tag: "person", exclude_tag: "archived" }],
      },
    };

    const block = await fetchProperNouns(config);
    expect(block).toContain("[[People/Active]]");
    expect(block).not.toContain("[[People/Ghost]]");
  });

  test("returns empty string and does not throw when vault is unreachable", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const config: ScribeConfig = {
      vault: {
        url: "http://localhost:9",
        contexts: [{ tag: "person" }],
      },
    };

    const result = await fetchProperNouns(config);
    expect(result).toBe("");
  });

  test("caches results within the TTL window", async () => {
    let hits = 0;
    mockFetch(() => {
      hits++;
      return Response.json([{ path: "People/Sam", metadata: { summary: "test" } }]);
    });

    const config: ScribeConfig = {
      vault: {
        url: "http://localhost:1940",
        cache_ttl_seconds: 60,
        contexts: [{ tag: "person" }],
      },
    };

    await fetchProperNouns(config);
    await fetchProperNouns(config);
    await fetchProperNouns(config);
    expect(hits).toBe(1);
  });
});

describe("buildCleanupPrompt", () => {
  test("returns base prompt unchanged without proper nouns", () => {
    const prompt = buildCleanupPrompt();
    expect(prompt).toContain("voice memo transcripts");
    expect(prompt).not.toContain("Proper nouns");
  });

  test("appends proper-nouns block when provided", () => {
    const block = "## Proper nouns in this vault\n\nPeople:\n- [[People/X]]";
    const prompt = buildCleanupPrompt(block);
    expect(prompt).toContain("voice memo transcripts");
    expect(prompt).toContain(block);
  });
});
