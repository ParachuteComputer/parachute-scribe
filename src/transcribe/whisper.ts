import { $ } from "bun";
import { getTranscribeProviderConfig } from "../provider-config.ts";
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
    const cfg = await getTranscribeProviderConfig("whisper");
    const model = cfg.model ?? "small";

    const result = await $`whisper-ctranslate2 ${tmpFile} --model ${model} --output_format txt --output_dir ${tmpDir}`
      .nothrow()
      .quiet();

    // Capture BOTH streams: whisper-ctranslate2 shells to ffmpeg internally;
    // a missing ffmpeg can print an error yet exit 0 with no output — the
    // signature in the combined output is the only signal.
    const combined =
      result.stdout.toString() + "\n" + result.stderr.toString();

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(
        `whisper-ctranslate2 exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
      );
    }

    // Output file is named after input file stem
    const stem = `scribe-${id}`;
    const outFile = `${tmpDir}/${stem}.txt`;
    const file = Bun.file(outFile);

    if (!(await file.exists())) {
      const files = await Array.fromAsync(new Bun.Glob("*.txt").scan(tmpDir));
      if (files.length === 0) {
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
