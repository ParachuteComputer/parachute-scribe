import { transcribers, cleaners, getProvider } from "./providers.ts";

const TRANSCRIBE = process.env.TRANSCRIBE_PROVIDER ?? "parakeet-mlx";
const CLEANUP = process.env.CLEANUP_PROVIDER ?? "none";
const PORT = Number(process.env.PORT ?? 3200);

const transcribe = getProvider(transcribers, TRANSCRIBE, "transcription");
const cleanup = getProvider(cleaners, CLEANUP, "cleanup");

export function startServer() {
  console.log(`scribe listening on :${PORT}`);
  console.log(`  transcribe: ${TRANSCRIBE}`);
  console.log(`  cleanup: ${CLEANUP}`);

  Bun.serve({
    hostname: "0.0.0.0",
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/v1/audio/transcriptions" && req.method === "POST") {
        return handleTranscription(req);
      }

      if (url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      // Whisper-compatible models endpoint (used by clients for health checks)
      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [{ id: TRANSCRIBE, object: "model" }],
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
}

async function handleTranscription(req: Request): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return Response.json({ error: "missing 'file' field" }, { status: 400 });
  }

  const doCleanup = form.get("cleanup") !== "false" && CLEANUP !== "none";

  try {
    let text = await transcribe(file);
    if (doCleanup) {
      text = await cleanup(text);
    }
    return Response.json({ text });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "transcription failed";
    console.error("Transcription error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
