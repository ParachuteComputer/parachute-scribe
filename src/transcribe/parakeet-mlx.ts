import { $ } from "bun";
import {
  FFMPEG_MISSING_MESSAGE,
  TranscribeBackendError,
  looksLikeFfmpegMissing,
} from "./backend-error.ts";

export async function transcribe(audio: File): Promise<string> {
  const id = crypto.randomUUID();
  const ext = audio.name?.split(".").pop() ?? "wav";
  const tmpFile = `/tmp/scribe-${id}.${ext}`;
  const tmpDir = `/tmp/scribe-${id}-out`;

  await Bun.write(tmpFile, audio);

  try {
    const result = await $`parakeet-mlx ${tmpFile} --output-format txt --output-dir ${tmpDir}`
      .nothrow()
      .quiet();

    // Capture BOTH streams: parakeet-mlx shells to ffmpeg internally and,
    // when ffmpeg is missing, prints the error then exits 0 (so the
    // exitCode gate below never fires) — the signature is the only signal.
    const combined =
      result.stdout.toString() + "\n" + result.stderr.toString();

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(
        `parakeet-mlx exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
      );
    }

    const outFile = `${tmpDir}/scribe-${id}.txt`;
    const file = Bun.file(outFile);
    if (!(await file.exists())) {
      // parakeet-mlx may use the original filename stem
      const files = await Array.fromAsync(new Bun.Glob("*.txt").scan(tmpDir));
      if (files.length === 0) {
        // No output AND the tool exited 0 — the classic ffmpeg-missing mask.
        // Promote to a typed error so the HTTP layer returns an actionable
        // 503 instead of an opaque 500.
        if (looksLikeFfmpegMissing(combined)) {
          throw new TranscribeBackendError("ffmpeg_unavailable", FFMPEG_MISSING_MESSAGE);
        }
        throw new Error(
          `No .txt output found in ${tmpDir} — the backend produced no output, often a missing system dependency (ffmpeg).`,
        );
      }
      return (await Bun.file(`${tmpDir}/${files[0]}`).text()).trim();
    }
    return (await file.text()).trim();
  } finally {
    await $`rm -rf ${tmpFile} ${tmpDir}`.nothrow().quiet();
  }
}
