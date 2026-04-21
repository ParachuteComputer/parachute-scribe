import { buildCleanupPrompt } from "./prompt.ts";

export type SpawnResult = { stdout: string; stderr: string; exitCode: number | null };

export type SpawnFn = (args: {
  cmd: string[];
  stdin: string;
  timeoutMs: number;
}) => Promise<SpawnResult>;

export const TIMEOUT_MS = 60_000;

const defaultSpawn: SpawnFn = async ({ cmd, stdin, timeoutMs }) => {
  const bin = cmd[0]!;
  if (Bun.which(bin) === null) {
    throw new Error(`ENOENT: ${bin} not found on PATH`);
  }

  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(stdin);
  await proc.stdin.end();

  const killTimer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(killTimer);
  }
};

export function makeCleaner(spawnFn: SpawnFn = defaultSpawn) {
  return async (text: string, properNouns?: string): Promise<string> => {
    const prompt = buildCleanupPrompt(properNouns);
    const stdin = `${prompt}\n\nTranscript to clean:\n\n${text}`;

    let result: SpawnResult;
    try {
      result = await spawnFn({ cmd: ["claude", "-p"], stdin, timeoutMs: TIMEOUT_MS });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found/i.test(msg)) {
        throw new Error(
          "claude not found on PATH — install Claude Code (https://claude.com/claude-code) or switch cleanup provider",
        );
      }
      throw err;
    }

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(
        `claude -p exited ${result.exitCode}${detail ? `: ${detail}` : ""}`,
      );
    }

    const out = result.stdout.trim();
    if (!out) throw new Error("claude -p produced empty output");
    return out;
  };
}

export const cleanup = makeCleaner();
