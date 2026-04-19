import { transcribers, cleaners, getProvider } from "./providers.ts";
import { loadConfig } from "./config.ts";
import { fetchProperNouns } from "./vault.ts";
import { preflight, withCors } from "./cors.ts";

export async function startServer() {
  const config = await loadConfig();

  const TRANSCRIBE = config.transcribe?.provider ?? process.env.TRANSCRIBE_PROVIDER ?? "parakeet-mlx";
  const CLEANUP = config.cleanup?.provider ?? process.env.CLEANUP_PROVIDER ?? "none";
  const PORT = Number(process.env.PORT ?? 3200);
  const CLEANUP_DEFAULT = config.cleanup?.default ?? true;

  const transcribe = getProvider(transcribers, TRANSCRIBE, "transcription");
  const cleanup = getProvider(cleaners, CLEANUP, "cleanup");

  console.log(`scribe listening on :${PORT}`);
  console.log(`  transcribe: ${TRANSCRIBE}`);
  console.log(`  cleanup:    ${CLEANUP}${CLEANUP !== "none" ? ` (default: ${CLEANUP_DEFAULT})` : ""}`);
  if (config.vault?.url && config.vault.contexts?.length) {
    console.log(`  vault:      ${config.vault.url} (${config.vault.contexts.length} contexts)`);
  }

  Bun.serve({
    hostname: "0.0.0.0",
    port: PORT,
    async fetch(req) {
      if (req.method === "OPTIONS") return preflight();
      return withCors(await route(req));
    },
  });

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/v1/audio/transcriptions" && req.method === "POST") {
      return handleTranscription(req);
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/v1/models") {
      return Response.json({
        data: [{ id: TRANSCRIBE, object: "model" }],
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async function handleTranscription(req: Request): Promise<Response> {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return Response.json({ error: "missing 'file' field" }, { status: 400 });
    }

    const cleanupParam = form.get("cleanup");
    const doCleanup = CLEANUP !== "none" && (
      cleanupParam === "true" || cleanupParam === "1" ? true :
      cleanupParam === "false" || cleanupParam === "0" ? false :
      CLEANUP_DEFAULT
    );

    try {
      let text = await transcribe(file);
      if (doCleanup) {
        const properNouns = await fetchProperNouns(config);
        text = await cleanup(text, properNouns);
      }
      return Response.json({ text });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "transcription failed";
      console.error("Transcription error:", message);
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
