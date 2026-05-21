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
  handleConfigSchema,
} from "./config-schema.ts";
import {
  buildPublicResolvedConfig,
  detectRestartRequired,
  mergeIntoFileShape,
  readExistingConfig,
  toFileShape,
  validateConfig,
  writeConfigFileAtomic,
} from "./config-write.ts";
import { readSetupTokenStatus } from "./claude-token-status.ts";
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
  transcribe: ((file: File) => Promise<string>) | null;
  cleanup: Cleaner;
  /**
   * Resolved config snapshot — captured once at boot for the *selected*
   * provider names + the port. Per-provider apiKey/model details are read
   * per-request from the live `scribeConfig` (which mutates in place on PUT).
   */
  resolvedConfig: ResolvedConfig;
  scribeConfig: ScribeConfig;
  /**
   * Path to the on-disk config file the admin PUT writes through. Defaults
   * to `resolveDefaultConfigPath()` so production code never specifies it;
   * tests inject a tmp path.
   */
  configPath?: string;
  /**
   * Optional fault-injection seam for tests — when set, the GET handler uses
   * this instead of reading `~/.claude.json`. Production never passes it.
   */
  setupTokenStatusFn?: () => ReturnType<typeof readSetupTokenStatus>;
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
 * Per-route required scope.
 *
 *   - `/v1/audio/transcriptions` → `scribe:transcribe`
 *   - `/.parachute/config*`      → `scribe:admin`
 *   - `/admin/*`                 → `scribe:admin` (refresh / clear endpoints)
 *   - `/scribe/admin`            → `scribe:admin` (the SPA page itself)
 *   - `/v1/models`               → `scribe:transcribe`
 */
function requiredScopeFor(pathname: string, method: string): string | null {
  if (pathname === "/v1/audio/transcriptions" && method === "POST") return SCOPE_TRANSCRIBE;
  if (pathname.startsWith("/.parachute/config")) return SCOPE_ADMIN;
  if (pathname.startsWith("/admin/")) return SCOPE_ADMIN;
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
    if (url.pathname === "/.parachute/config") return handleConfigGet(deps);
    return new Response("Not found", { status: 404 });
  }

  // Admin actions live under /admin/* — refresh-claude-token-status is the
  // only one shipped in 0.4.4-rc.1; clear-credential follows in Phase 2.
  if (url.pathname === "/admin/refresh-claude-token-status" && req.method === "POST") {
    return handleRefreshSetupTokenStatus(deps);
  }
  if (url.pathname.startsWith("/admin/") && req.method !== "GET") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (url.pathname === "/scribe/admin" && req.method === "GET") {
    return new Response(renderAdminPage(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
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
 * Build + return the public resolved-config response. writeOnly apiKey
 * fields are omitted; per-provider model/url and the claude-code
 * setupTokenStatus are included. Per-request so PUT changes show up
 * immediately on the next GET.
 */
function handleConfigGet(deps: ServerDeps): Response {
  const resolved = buildPublicResolvedConfig({
    transcribeProvider: deps.resolvedConfig.transcribeProvider,
    cleanupProvider: deps.resolvedConfig.cleanupProvider,
    cleanupDefault: deps.resolvedConfig.cleanupDefault,
    scribeConfig: deps.scribeConfig,
    port: deps.resolvedConfig.port,
    setupTokenStatusFn: deps.setupTokenStatusFn,
  });
  return Response.json(resolved);
}

/**
 * `POST /admin/refresh-claude-token-status` — re-read `~/.claude.json` and
 * return the current status as a small JSON body. The SPA hits this when
 * the operator clicks the Refresh button next to the status pill on the
 * claude-code provider section.
 */
function handleRefreshSetupTokenStatus(deps: ServerDeps): Response {
  const status = (deps.setupTokenStatusFn ?? readSetupTokenStatus)();
  return Response.json({ setupTokenStatus: status });
}

/**
 * PUT /.parachute/config — validate, atomically persist, mutate the
 * in-process scribeConfig so dynamically-read fields take effect without
 * restart. Restart-required fields (provider switches, port) flow back to
 * the SPA in the response body.
 *
 * writeOnly apiKey omit-to-keep semantics: an empty-string or absent
 * `apiKey` in the patch preserves the stored value (see
 * `mergeProviderMap`); only a non-empty string overwrites it.
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
  const patch = toFileShape(incoming);
  const path = deps.configPath ?? resolveDefaultConfigPath();

  let existing: ScribeConfig;
  try {
    existing = readExistingConfig(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scribe] config read failed (${path}): ${message}`);
    return Response.json(
      { error: "read_failed", message: `failed to read ${path}: ${message}` },
      { status: 500 },
    );
  }
  const merged = mergeIntoFileShape(existing, patch);

  try {
    writeConfigFileAtomic(path, merged);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scribe] config write failed (${path}): ${message}`);
    return Response.json(
      { error: "write_failed", message: `failed to write ${path}: ${message}` },
      { status: 500 },
    );
  }

  // Sync the in-process scribeConfig with the merged result so the next
  // GET / transcribe request sees the new values without waiting on a
  // restart. Replace each top-level block wholesale to honor null-clears.
  deps.scribeConfig.cleanup = merged.cleanup;
  deps.scribeConfig.transcribe = merged.transcribe;
  deps.scribeConfig.transcribeProviders = merged.transcribeProviders;
  deps.scribeConfig.cleanupProviders = merged.cleanupProviders;

  const restartRequired = detectRestartRequired(deps.resolvedConfig, incoming);
  return Response.json({ ok: true, restart_required: restartRequired });
}

async function handleTranscription(req: Request, deps: ServerDeps): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return Response.json({ error: "missing 'file' field" }, { status: 400 });
  }

  // Graceful first-boot path (site#52 Part 1, resolved Q2): if no transcription
  // provider is wired up, return a stable 400 the caller can branch on. Vault's
  // auto-transcribe maps `error_code: "missing_provider"` to
  // `transcript_status: failed` with a clean `transcript_error` string.
  if (deps.transcribe === null) {
    return Response.json(
      {
        error: "no transcription provider configured",
        error_code: "missing_provider",
        message:
          "Configure a transcription provider in the admin SPA (/scribe/admin) before sending audio.",
      },
      { status: 400 },
    );
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

  // Transcribe provider: config > env > built-in `parakeet-mlx` default.
  // When even the default isn't viable on the host (e.g. Render container
  // without MLX) the request-time call still raises a runtime error; the
  // missing_provider 400 path is reserved for the case where the operator
  // has *explicitly* unset the provider (TRANSCRIBE_PROVIDER="" + no
  // config entry) — site#52 Part 1 graceful-degradation Q2.
  const TRANSCRIBE =
    config.transcribe?.provider ?? process.env.TRANSCRIBE_PROVIDER ?? "parakeet-mlx";
  const CLEANUP = config.cleanup?.provider ?? process.env.CLEANUP_PROVIDER ?? "none";
  const portResolution = resolvePort();
  const PORT = portResolution.port;
  const CLEANUP_DEFAULT = config.cleanup?.default ?? config.cleanup?.enabled ?? true;

  // A truly empty TRANSCRIBE (explicit "" from env or "" in config) yields
  // null — and `/v1/audio/transcriptions` returns the stable
  // `missing_provider` 400 vault#343 can branch on.
  const transcribe = TRANSCRIBE && TRANSCRIBE.length > 0
    ? getProvider(transcribers, TRANSCRIBE, "transcription")
    : null;
  const cleanup = getProvider(cleaners, CLEANUP, "cleanup");

  const transcribeProviderName = TRANSCRIBE && TRANSCRIBE.length > 0 ? TRANSCRIBE : "(none configured)";
  const resolvedConfig: ResolvedConfig = {
    transcribeProvider: transcribeProviderName,
    transcribeProviders: {}, // populated by GET handler per-request
    cleanupProvider: CLEANUP,
    cleanupDefault: CLEANUP_DEFAULT,
    cleanupProviders: {},
    cleanupSystemPrompt: config.cleanup?.system_prompt ?? null,
    cleanupContextTemplate: config.cleanup?.context_template ?? null,
    port: PORT,
  };

  console.log(`scribe listening on :${PORT} (port source: ${portResolution.source})`);
  console.log(`  transcribe: ${transcribeProviderName}`);
  console.log(`  cleanup:    ${CLEANUP}${CLEANUP !== "none" ? ` (default: ${CLEANUP_DEFAULT})` : ""}`);
  console.log(`  auth:       ${isAuthRequired() ? "bearer (SCRIBE_AUTH_TOKEN or hub JWT)" : "open"}`);
  warnIfTokenLooksJwt();

  const handler = createFetchHandler({
    transcribe,
    cleanup,
    resolvedConfig,
    scribeConfig: config,
  });

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
