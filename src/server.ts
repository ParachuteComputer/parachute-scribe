import { cleaners, getProvider, transcribers, type Cleaner } from "./providers.ts";
import { loadConfig, resolveDefaultConfigPath, type ScribeConfig } from "./config.ts";
import { buildProperNounsBlockFromEntries, parseContextPayload } from "./context.ts";
import { preflight, withCors } from "./cors.ts";
import { upsertService } from "./services-manifest.ts";
import { resolvePort } from "./port-resolve.ts";
import {
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
import {
  detectRestartRequired,
  toFileShape,
  validateConfig,
  writeConfigFileAtomic,
} from "./config-write.ts";
import { renderAdminPage } from "./admin-ui.ts";
import {
  SCOPE_ADMIN,
  SCOPE_TRANSCRIBE,
  enforceAuth,
  hasScope,
  insufficientScopeResponse,
  isAuthRequired,
  warnIfTokenLooksJwt,
} from "./auth.ts";
import pkg from "../package.json" with { type: "json" };

export type ServerDeps = {
  transcribe: (file: File) => Promise<string>;
  cleanup: Cleaner;
  resolvedConfig: ResolvedConfig;
  scribeConfig: ScribeConfig;
  /**
   * Path to the on-disk config file the admin PUT writes through. Defaults
   * to `resolveDefaultConfigPath()` so production code never specifies it;
   * tests inject a tmp path. Pulled out as a dep rather than re-resolved at
   * request time so the test can sandbox the write target without touching
   * the operator's real `~/.parachute`.
   */
  configPath?: string;
};

export function createFetchHandler(deps: ServerDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return preflight();
    const url = new URL(req.url);
    const auth = await enforceAuth(req, url.pathname);
    if (auth instanceof Response) return withCors(auth);
    return withCors(await route(req, url, auth.scopes, deps));
  };
}

/**
 * Per-route required scope. Two routes are scope-gated:
 *   - `/v1/audio/transcriptions` → `scribe:transcribe`
 *   - `/.parachute/config*`      → `scribe:admin` (per the canonical rule:
 *                                   "<service>:admin gates /.parachute/config*")
 *
 * Returns null when no scope check applies (exempt routes, /v1/models, etc.).
 */
function requiredScopeFor(pathname: string, method: string): string | null {
  if (pathname === "/v1/audio/transcriptions" && method === "POST") return SCOPE_TRANSCRIBE;
  if (pathname.startsWith("/.parachute/config")) return SCOPE_ADMIN;
  // `/scribe/admin` is the static admin SPA. The page itself is just HTML
  // and (open mode aside) can't do anything without a Bearer to call back
  // with — but we still scope-gate the HTML response so an unauthorized
  // operator gets a clean 403 rather than a page that 401s on every fetch.
  if (pathname === "/scribe/admin") return SCOPE_ADMIN;
  if (pathname === "/v1/models") return SCOPE_TRANSCRIBE;
  return null;
}

async function route(
  req: Request,
  url: URL,
  scopes: readonly string[],
  deps: ServerDeps,
): Promise<Response> {
  const required = requiredScopeFor(url.pathname, req.method);
  if (required && !hasScope(scopes, required)) {
    return insufficientScopeResponse(required, scopes);
  }

  if (url.pathname.startsWith("/.parachute/")) {
    if (url.pathname === "/.parachute/config" && req.method === "PUT") {
      return handleConfigPut(req, deps);
    }
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (url.pathname === "/.parachute/info") return handleParachuteInfo();
    if (url.pathname === "/.parachute/icon.svg") return handleParachuteIcon();
    if (url.pathname === "/.parachute/config/schema") return handleConfigSchema();
    if (url.pathname === "/.parachute/config") return handleConfig(deps.resolvedConfig);
    return new Response("Not found", { status: 404 });
  }

  if (url.pathname === "/scribe/admin" && req.method === "GET") {
    return new Response(renderAdminPage(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // The page is per-instance branded but otherwise static and small.
        // Short cache so a `bun link`-updated scribe serves the new HTML on
        // reload without manual cache-busts.
        "Cache-Control": "no-cache",
      },
    });
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

/**
 * PUT /.parachute/config — schema-validate the incoming body, atomically
 * persist it to `~/.parachute/scribe/config.json`, return the list of fields
 * whose change requires a restart to take effect.
 *
 * The in-process resolved config is NOT mutated here. Provider/port values
 * are bound to the running handler at boot in `startServer()`; an in-place
 * swap would skip provider-init invariants. Operators see the new config on
 * the next process boot. `restart_required` makes that explicit.
 *
 * Fields that ARE read dynamically per-request (the cleanup default flag, the
 * cleanup prompt overrides) take effect on the next call without restart
 * because `handleTranscription` re-reads `deps.scribeConfig.cleanup.*` each
 * time. To keep that working we mutate the existing `scribeConfig` object's
 * `cleanup` block in place after a successful write — the running handler's
 * closure already holds the reference, so the new prompts apply immediately.
 *
 * `transcribeProvider` / `cleanupProvider` / `port` changes still require
 * restart because the provider *functions* (`deps.transcribe`, `deps.cleanup`)
 * were closed over at boot. We don't repoint them mid-life — too easy to
 * misconfigure a provider with no boot-time validation.
 */
async function handleConfigPut(req: Request, deps: ServerDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return Response.json(
      {
        error: "invalid_json",
        message: err instanceof Error ? err.message : "request body was not valid JSON",
      },
      { status: 400 },
    );
  }
  const result = validateConfig(body);
  if (!result.ok) {
    return Response.json(
      {
        error: "validation_failed",
        message: result.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
        errors: result.errors,
      },
      { status: 400 },
    );
  }
  const incoming = result.value;
  const file = toFileShape(incoming);
  const path = deps.configPath ?? resolveDefaultConfigPath();
  try {
    writeConfigFileAtomic(path, file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scribe] config write failed (${path}): ${message}`);
    return Response.json(
      { error: "write_failed", message: `failed to write ${path}: ${message}` },
      { status: 500 },
    );
  }
  // Mutate the in-process scribe config so the dynamically-read fields
  // (cleanup default + prompts) take effect without restart. The provider
  // closures from boot still hold for the restart-required fields.
  if (file.cleanup) {
    deps.scribeConfig.cleanup = { ...deps.scribeConfig.cleanup, ...file.cleanup };
  }
  const restartRequired = detectRestartRequired(deps.resolvedConfig, incoming);
  return Response.json({ ok: true, restart_required: restartRequired });
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
  // Port resolution: services.json wins, then env, then canonical default.
  // See `port-resolve.ts` and scribe#40 for the precedence rationale.
  const portResolution = resolvePort();
  const PORT = portResolution.port;
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

  console.log(`scribe listening on :${PORT} (port source: ${portResolution.source})`);
  console.log(`  transcribe: ${TRANSCRIBE}`);
  console.log(`  cleanup:    ${CLEANUP}${CLEANUP !== "none" ? ` (default: ${CLEANUP_DEFAULT})` : ""}`);
  console.log(`  auth:       ${isAuthRequired() ? "bearer (SCRIBE_AUTH_TOKEN or hub JWT)" : "open"}`);
  warnIfTokenLooksJwt();

  const handler = createFetchHandler({
    transcribe,
    cleanup,
    resolvedConfig,
    scribeConfig: config,
  });

  // Fail-loud on bind: if PORT is in use we want a named, actionable error
  // rather than a silent "address in use" deep inside Bun. The hub probes
  // `/health` after spawn, so an unbound scribe surfaces as "service didn't
  // come up" — which is hard to debug without this hint.
  try {
    Bun.serve({
      hostname: "0.0.0.0",
      port: PORT,
      fetch: handler,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `scribe: failed to bind port ${PORT} (source: ${portResolution.source}): ${message}\n` +
        `  another process is already listening on :${PORT}.\n` +
        `  if this is unexpected, check ~/.parachute/services.json for a stale entry,\n` +
        `  or run \`parachute status\` / \`lsof -iTCP:${PORT} -sTCP:LISTEN\` to identify the conflict.`,
    );
    throw err;
  }

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
