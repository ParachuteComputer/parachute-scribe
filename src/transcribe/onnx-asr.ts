import { $ } from "bun";

export async function transcribe(audio: File): Promise<string> {
  const id = crypto.randomUUID();
  const ext = audio.name?.split(".").pop() ?? "wav";
  const tmpFile = `/tmp/scribe-${id}.${ext}`;
  const wavFile = `/tmp/scribe-${id}.wav`;

  await Bun.write(tmpFile, audio);

  try {
    // onnx-asr only accepts WAV — convert if needed
    if (ext !== "wav") {
      await $`ffmpeg -i ${tmpFile} -ar 16000 -ac 1 -c:a pcm_s16le ${wavFile} -y`
        .quiet();
    } else {
      await $`cp ${tmpFile} ${wavFile}`.quiet();
    }

    const model = process.env.ONNX_ASR_MODEL ?? "nemo-parakeet-tdt-0.6b-v3";

    // Use --vad silero for audio over ~20s (Parakeet's context limit)
    const result = await $`onnx-asr ${model} --vad silero ${wavFile}`
      .nothrow()
      .quiet();

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(
        `onnx-asr exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
      );
    }

    // With --vad, output is timestamped lines like "[  0.0,  3.2]: text"
    // Strip timestamps and join
    const raw = result.stdout.toString().trim();
    const lines = raw.split("\n").filter((l) => l.trim());
    const text = lines
      .map((l) => l.replace(/^\[\s*[\d.]+,\s*[\d.]+\]:\s*/, ""))
      .join(" ");

    return text.trim();
  } finally {
    await $`rm -f ${tmpFile} ${wavFile}`.nothrow().quiet();
  }
}
