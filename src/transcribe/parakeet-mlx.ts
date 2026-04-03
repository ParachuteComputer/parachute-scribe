import { $ } from "bun";

export async function transcribe(audio: File): Promise<string> {
  const id = crypto.randomUUID();
  const ext = audio.name?.split(".").pop() ?? "wav";
  const tmpFile = `/tmp/scribe-${id}.${ext}`;
  const tmpDir = `/tmp/scribe-${id}-out`;

  await Bun.write(tmpFile, audio);

  try {
    await $`parakeet-mlx ${tmpFile} --output-format txt --output-dir ${tmpDir}`.quiet();

    const outFile = `${tmpDir}/scribe-${id}.txt`;
    return (await Bun.file(outFile).text()).trim();
  } finally {
    await $`rm -rf ${tmpFile} ${tmpDir}`.nothrow().quiet();
  }
}
