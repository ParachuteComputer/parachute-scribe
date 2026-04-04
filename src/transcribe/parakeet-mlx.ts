import { $ } from "bun";

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
        throw new Error(`No .txt output found in ${tmpDir}`);
      }
      return (await Bun.file(`${tmpDir}/${files[0]}`).text()).trim();
    }
    return (await file.text()).trim();
  } finally {
    await $`rm -rf ${tmpFile} ${tmpDir}`.nothrow().quiet();
  }
}
