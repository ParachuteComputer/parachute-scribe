import { cleaners, getProvider, transcribers, type Cleaner } from "./providers.ts";
import { loadConfig, type ScribeConfig } from "./config.ts";
import { buildProperNounsBlockFromEntries, parseContextPayload } from "./context.ts";
import { preflight, withCors } from "./cors.ts";
import { upsertService } from "./services-manifest.ts";
import {
  DEFAULT_PORT,
  DISPLAY_NAME,
  MOUNT_PATH,
  SERVICE_NAME,
  TAGLINE,
  handleParachuteIcon,
  handleParachuteInfo,
} from "./parachute-info.ts";
import {
  type ResolvedConfig,
  handleConfig,
  handleConfigSchema,
} from "./config-schema.ts";
import { enforceAuth, isAuthRequired } from "./auth.ts";
import pkg from "../package.json" with { type: "json" };

export type ServerDeps = {
  transcribe: (file: File) => Promise<string>;
  cleanup: Cleaner;
  resolvedConfig: ResolvedConfig;
  scribeConfig: ScribeConfig;
};

export function createFetchHandler(deps: ServerDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return preflight();
    const url = new URL(req.url);
    const authErr = enforceAuth(req, url.pathname);
    if (authErr) return withCors(authErr);
    return withCors(await route(req, url, deps));
  };
}

async function route(req: Request, url: URL, deps: ServerDeps): Promise<Response> {
  if (url.pathname.startsWith("/.parachute/")) {
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (url.pathname === "/.parachute/info") return handleParachuteInfo();
    if (url.pathname === "/.parachute/icon.svg") return handleParachuteIcon();
    if (url.pathname === "/.parachute/config/schema") return handleConfigSchema();
    if (url.pathname === "/.parachute/config") return handleConfig(deps.resolvedConfig);
    return new Response("Not found", { status: 404 });
  }

  if (url.pathname === "/v1/audio/transcriptions" && req.method === "POST") {
    return handleTranscription(req, deps);
  }

  if (url.pathname === "/health") {
    return Response.json({ ok: true });
  }

  if (url.pathname === "/v1/models") {
    return Response.json({
      data: [{ id: deps.resolvedConfig.transcribeProvider, object: "model" }],
    });
  }

  return new Response("Not found", { status: 404 });
}

async function handleTranscription(req: Request, deps: ServerDeps): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return Response.json({ error: "missing 'file' field" }, { status: 400 });
  }

  const { cleanupProvider, cleanupDefault } = deps.resolvedConfig;
  const cleanupParam = form.get("cleanup");
  const doCleanup =
    cleanupProvider !== "none" &&
    (cleanupParam === "true" || cleanupParam === "1"
      ? true
      : cleanupParam === "false" || cleanupParam === "0"
        ? false
        : cleanupDefault);

  const contextPart = form.get("context");
  let contextPayload: ReturnType<typeof parseContextPayload> = null;
  if (contextPart != null) {
    const raw = contextPart instanceof Blob ? await contextPart.text() : String(contextPart);
    contextPayload = parseContextPayload(raw);
    if (!contextPayload) {
      console.warn("[scribe] malformed 'context' part in transcription request — ignoring, cleanup will run without proper nouns");
    }
  }

  let text: string;
  try {
    text = await deps.transcribe(file);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "transcription failed";
    console.error("Transcription error:", message);
    return Response.json({ error: message }, { status: 500 });
  }

  if (doCleanup) {
    try {
      const properNouns = contextPayload
        ? buildProperNounsBlockFromEntries(contextPayload)
        : "";
      text = await deps.cleanup(text, properNouns, {
        systemPrompt: deps.scribeConfig.cleanup?.system_prompt,
        contextTemplate: deps.scribeConfig.cleanup?.context_template,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Cleanup failed (provider=${cleanupProvider}): ${message} — returning raw transcription`);
    }
  }

  return Response.json({ text });
}

export async function startServer() {
  const config = await loadConfig();

  const TRANSCRIBE = config.transcribe?.provider ?? process.env.TRANSCRIBE_PROVIDER ?? "parakeet-mlx";
  const CLEANUP = config.cleanup?.provider ?? process.env.CLEANUP_PROVIDER ?? "none";
  const PORT = Number(process.env.SCRIBE_PORT ?? process.env.PORT ?? DEFAULT_PORT);
  const CLEANUP_DEFAULT = config.cleanup?.default ?? true;

  const transcribe = getProvider(transcribers, TRANSCRIBE, "transcription");
  const cleanup = getProvider(cleaners, CLEANUP, "cleanup");

  const resolvedConfig: ResolvedConfig = {
    transcribeProvider: TRANSCRIBE,
    cleanupProvider: CLEANUP,
    cleanupDefault: CLEANUP_DEFAULT,
    cleanupSystemPrompt: config.cleanup?.system_prompt ?? null,
    cleanupContextTemplate: config.cleanup?.context_template ?? null,
    port: PORT,
  };

  console.log(`scribe listening on :${PORT}`);
  console.log(`  transcribe: ${TRANSCRIBE}`);
  console.log(`  cleanup:    ${CLEANUP}${CLEANUP !== "none" ? ` (default: ${CLEANUP_DEFAULT})` : ""}`);
  console.log(`  auth:       ${isAuthRequired() ? "bearer (SCRIBE_AUTH_TOKEN)" : "open"}`);

  const handler = createFetchHandler({
    transcribe,
    cleanup,
    resolvedConfig,
    scribeConfig: config,
  });

  Bun.serve({
    hostname: "0.0.0.0",
    port: PORT,
    fetch: handler,
  });

  try {
    upsertService({
      name: SERVICE_NAME,
      port: PORT,
      paths: [MOUNT_PATH],
      health: "/health",
      version: pkg.version,
      displayName: DISPLAY_NAME,
      tagline: TAGLINE,
    });
  } catch (err) {
    console.warn(
      `scribe: skipped services manifest update: ${err instanceof Error ? err.message : err}`,
    );
  }
}
