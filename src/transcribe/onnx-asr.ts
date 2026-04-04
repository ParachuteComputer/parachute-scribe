import { $ } from "bun";

export async function transcribe(audio: File): Promise<string> {
  const id = crypto.randomUUID();
  const ext = audio.name?.split(".").pop() ?? "wav";
  const tmpFile = `/tmp/scribe-${id}.${ext}`;

  await Bun.write(tmpFile, audio);

  try {
    const model = process.env.ONNX_ASR_MODEL ?? "nemo-parakeet-tdt-0.6b-v3";
    const text = await $`onnx-asr ${model} ${tmpFile}`.text();
    return text.trim();
  } finally {
    await $`rm -f ${tmpFile}`.nothrow().quiet();
  }
}
