import { describe, expect, test } from "bun:test";
import { makeCleaner, type SpawnFn } from "./claude-code.ts";
import { cleaners } from "../providers.ts";

type RecordedCall = {
  cmd: string[];
  stdin: string;
  timeoutMs: number;
};

function recordingSpawn(
  response: { stdout: string; stderr?: string; exitCode?: number | null } | Error,
): { spawn: SpawnFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spawn: SpawnFn = async (args) => {
    calls.push(args);
    if (response instanceof Error) throw response;
    return {
      stdout: response.stdout,
      stderr: response.stderr ?? "",
      exitCode: response.exitCode ?? 0,
    };
  };
  return { spawn, calls };
}

describe("claude-code cleanup provider", () => {
  test("pipes prompt + transcript to stdin and returns trimmed stdout", async () => {
    const { spawn, calls } = recordingSpawn({ stdout: "  cleaned transcript  \n" });
    const cleaner = makeCleaner(spawn);

    const result = await cleaner("raw um like words");

    expect(result).toBe("cleaned transcript");
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toEqual(["claude", "-p"]);
    expect(calls[0]!.stdin).toContain("voice memo transcripts");
    expect(calls[0]!.stdin).toContain("raw um like words");
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
  });

  test("includes proper-nouns block in stdin when provided", async () => {
    const { spawn, calls } = recordingSpawn({ stdout: "ok" });
    const cleaner = makeCleaner(spawn);

    await cleaner("some words", "## Proper nouns in this vault\n\nPeople:\n- [[People/Sam]]");

    expect(calls[0]!.stdin).toContain("## Proper nouns in this vault");
    expect(calls[0]!.stdin).toContain("[[People/Sam]]");
  });

  test("throws actionable message when claude is not on PATH (ENOENT)", async () => {
    const { spawn } = recordingSpawn(new Error("ENOENT: claude not found on PATH"));
    const cleaner = makeCleaner(spawn);

    await expect(cleaner("hi")).rejects.toThrow(/claude not found on PATH.*install Claude Code/);
  });

  test("throws when subprocess exits non-zero, includes stderr detail", async () => {
    const { spawn } = recordingSpawn({ stdout: "", stderr: "auth required", exitCode: 1 });
    const cleaner = makeCleaner(spawn);

    await expect(cleaner("hi")).rejects.toThrow(/claude -p exited 1.*auth required/);
  });

  test("throws when subprocess exits 0 but stdout is empty", async () => {
    const { spawn } = recordingSpawn({ stdout: "   \n\n  ", exitCode: 0 });
    const cleaner = makeCleaner(spawn);

    await expect(cleaner("hi")).rejects.toThrow(/empty output/);
  });

  test("rethrows non-ENOENT spawn errors unchanged", async () => {
    const { spawn } = recordingSpawn(new Error("EPERM: denied"));
    const cleaner = makeCleaner(spawn);

    await expect(cleaner("hi")).rejects.toThrow("EPERM: denied");
  });
});

describe("claude-code provider registration", () => {
  test("is available under key 'claude-code' in cleaners registry", () => {
    expect(cleaners["claude-code"]).toBeDefined();
    expect(typeof cleaners["claude-code"]).toBe("function");
  });
});
