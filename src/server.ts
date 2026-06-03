import { cleaners, getProvider, transcribers, type Cleaner } from "./providers.ts";
import { loadConfig, resolveDefaultConfigPath, type ScribeConfig } from "./config.ts";
import {
  buildProperNounsBlockFromEntries,
  parseContextPayload,
  type ContextPayload,
} from "./context.ts";
import { preflight, withCors } from "./cors.ts";
import { normalizeMount, stripMount } from "./mount.ts";
import {
  UrlFetchError,
  fetchAudioFromUrl,
  type FetchedAudio,
} from "./url-fetch.ts";
import { handleScribeMcp } from "./mcp/http.ts";
import { resolveProjectRoot, selfRegister } from "./self-register.ts";
import { resolvePort } from "./port-resolve.ts";
import {
  handleParachuteIcon,
  handleParachuteInfo,
} from "./parachute-info.ts";
import {
  type ResolvedConfig,
  handleConfigSchema,
} from "./config-schema.ts";
import {
  buildPublicResolvedConfig,
  clearProviderCredential,
  detectRestartRequired,
  mergeIntoFileShape,
  readExistingConfig,
  toFileShape,
  validateClearCredentialTarget,
  validateConfig,
  writeConfigFileAtomic,
} from "./config-write.ts";
import { readSetupTokenStatus } from "./claude-token-status.ts";
import { computeBackendAvailability, type ClaudeProbeFn } from "./backend-availability.ts";
import { TranscribeBackendError } from "./transcribe/backend-error.ts";
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
  /**
   * Optional seam for the live `claude -p` auth probe (the `?probe=1` path on
   * `/admin/backend-availability`). When set, the handler forwards it to
   * `computeBackendAvailability` so tests never spawn a real `claude`.
   * Production leaves it undefined → the real subprocess probe is used.
   */
  claudeProbeFn?: ClaudeProbeFn;
  /**
   * Mount prefix this scribe instance answers under. Default `""` means
   * "bare routes at the origin root" — legacy behavior, unchanged for
   * every deployment that didn't pass `--mount`. Set to e.g. `"/scribe"`
   * and external requests to `/scribe/v1/audio/transcriptions` are
   * stripped to `/v1/audio/transcriptions` before the route table fires.
   * Requests that fall outside the mount return 404. Issue #39.
   */
  mount?: string;
};

export function createFetchHandler(deps: ServerDeps) {
  const mount = normalizeMount(deps.mount ?? "");
  // Re-bind the deps with the normalized mount so route handlers (e.g. the
  // admin SPA renderer) read the canonical value, not a raw `--mount foo`
  // that hasn't been through `normalizeMount` yet.
  const boundDeps: ServerDeps = { ...deps, mount };
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return preflight();
    const url = new URL(req.url);
    const internalPath = stripMount(url.pathname, mount);
    if (internalPath === null) {
      // The mount is configured but the request fell outside it. Don't
      // leak which routes exist — a flat 404 is the right signal that
      // this scribe instance doesn't serve the bare path.
      return withCors(new Response("Not found", { status: 404 }));
    }
    const auth = await enforceAuth(req, internalPath);
    if (auth instanceof Response) return withCors(auth);
    return withCors(await route(req, url, internalPath, auth.scopes, boundDeps));
  };
}

/**
 * Per-route required scope. Paths here are **post-mount-strip** — see
 * `createFetchHandler`. The route table is canonically defined at root
 * regardless of where the reverse proxy mounts scribe externally.
 *
 *   - `/v1/audio/transcriptions` → `scribe:transcribe`
 *   - `/.parachute/config*`      → `scribe:admin`
 *   - `/admin/*`                 → `scribe:admin` (refresh / clear endpoints)
 *   - `/scribe/admin`            → `scribe:admin` (SPA page — legacy alias
 *                                  for back-compat with direct-loopback
 *                                  callers using the `/scribe/admin` URL
 *                                  pre-#39; the canonical post-mount
 *                                  match is just `/admin`)
 *   - `/v1/models`               → `scribe:transcribe`
 */
function requiredScopeFor(pathname: string, method: string): string | null {
  if (pathname === "/v1/audio/transcriptions" && method === "POST") return SCOPE_TRANSCRIBE;
  if (pathname === "/v1/audio/transcriptions-url" && method === "POST") return SCOPE_TRANSCRIBE;
  if (pathname.startsWith("/.parachute/config")) return SCOPE_ADMIN;
  if (pathname.startsWith("/admin/")) return SCOPE_ADMIN;
  if (pathname === "/admin" || pathname === "/scribe/admin") return SCOPE_ADMIN;
  if (pathname === "/v1/models") return SCOPE_TRANSCRIBE;
  if (
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/scribe/mcp" ||
    pathname.startsWith("/scribe/mcp/")
  ) {
    // MCP transport — the SDK negotiates capabilities on the first call;
    // per-tool scope enforcement happens inside the handler so a caller
    // with only `scribe:transcribe` can list/call tools without needing
    // `scribe:admin`. The transport itself just needs *some* valid auth.
    return SCOPE_TRANSCRIBE;
  }
  return null;
}

async function route(
  req: Request,
  url: URL,
  internalPath: string,
  scopes: readonly string[],
  deps: ServerDeps,
): Promise<Response> {
  const required = requiredScopeFor(internalPath, req.method);
  if (required && !hasScope(scopes, required)) {
    return insufficientScopeResponse(required, scopes);
  }

  if (internalPath.startsWith("/.parachute/")) {
    if (internalPath === "/.parachute/config" && req.method === "PUT") {
      return handleConfigPut(req, deps);
    }
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (internalPath === "/.parachute/info") return handleParachuteInfo();
    if (internalPath === "/.parachute/icon.svg") return handleParachuteIcon();
    if (internalPath === "/.parachute/config/schema") return handleConfigSchema();
    if (internalPath === "/.parachute/config") return handleConfigGet(deps);
    return new Response("Not found", { status: 404 });
  }

  // Admin actions live under /admin/* — refresh-claude-token-status and
  // clear-credential (Phase 2 polish from scribe#47).
  if (internalPath === "/admin/backend-availability" && req.method === "GET") {
    // `?probe=1` opts into the live `claude -p` auth probe (the SPA's Refresh
    // button sends it). Absent → fast, file-token-only path (no subprocess).
    const probeClaude = url.searchParams.get("probe") === "1";
    return handleBackendAvailability(deps, probeClaude);
  }
  if (internalPath === "/admin/refresh-claude-token-status" && req.method === "POST") {
    return handleRefreshSetupTokenStatus(deps);
  }
  if (internalPath.startsWith("/admin/clear-credential/") && req.method === "POST") {
    return handleClearCredential(internalPath, deps);
  }
  if (internalPath.startsWith("/admin/") && req.method !== "GET") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // SPA page: canonical at `/admin` (post-mount), with `/scribe/admin` kept
  // as a legacy alias for direct-loopback callers using the pre-#39 URL
  // unchanged. Both serve the same HTML; the mount value baked into the
  // page determines what URLs the in-page fetches use.
  if ((internalPath === "/admin" || internalPath === "/scribe/admin") && req.method === "GET") {
    return new Response(renderAdminPage(deps.mount ?? ""), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }

  if (internalPath === "/v1/audio/transcriptions" && req.method === "POST") {
    return handleTranscription(req, deps);
  }

  if (internalPath === "/v1/audio/transcriptions-url" && req.method === "POST") {
    return handleTranscriptionUrl(req, deps);
  }

  if (
    internalPath === "/mcp" ||
    internalPath.startsWith("/mcp/") ||
    internalPath === "/scribe/mcp" ||
    internalPath.startsWith("/scribe/mcp/")
  ) {
    return handleScribeMcp(req, scopes, deps);
  }

  if (internalPath === "/health") {
    return Response.json({ ok: true });
  }

  if (internalPath === "/v1/models") {
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
 * `GET /admin/backend-availability` — probe every transcription + cleanup
 * backend's real prerequisite (CLI on PATH, API key present, URL reachable)
 * and return a structured report the SPA renders inline next to each backend
 * select.
 *
 * The pain this fixes: selecting a backend whose dependency isn't installed
 * SAVES fine, then fails opaquely (`exit 127`) only at the first
 * transcription. This endpoint surfaces the missing dependency at config
 * time with the exact fix — warn, never block. Each per-backend probe is
 * try/caught inside `computeBackendAvailability` so a flaky check degrades to
 * `"unknown"` rather than failing the whole response. The outer try/catch is
 * belt-and-braces: a top-level failure still returns a 200 with an empty
 * report so the page never breaks on this advisory endpoint.
 */
async function handleBackendAvailability(
  deps: ServerDeps,
  probeClaude = false,
): Promise<Response> {
  try {
    const report = await computeBackendAvailability({
      scribeConfig: deps.scribeConfig,
      setupTokenStatusFn: deps.setupTokenStatusFn,
      probeClaude,
      claudeProbeFn: deps.claudeProbeFn,
    });
    return Response.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scribe] backend-availability check failed: ${message}`);
    // Advisory endpoint — never 500 the SPA over it. Return an empty report;
    // the page falls back to "couldn't determine" for every backend.
    return Response.json({ transcribe: {}, cleanup: {} });
  }
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
 * `POST /admin/clear-credential/<kind>/<name>` — remove the stored
 * writeOnly `apiKey` for a provider. Pairs with PUT /.parachute/config's
 * omit-to-keep semantics: PUT preserves apiKey when omitted, so this
 * endpoint is the only way to actually erase a stored credential without
 * hand-editing `config.json`.
 *
 * - 200 `{ok: true, cleared: {kind, name, field}, hadStoredValue: bool}`
 *   on success. Idempotent: clearing a provider with no stored apiKey still
 *   returns 200, with `hadStoredValue: false` to distinguish the no-op.
 * - 400 `{error: "invalid_kind"|"unknown_provider", message}` for bad path
 *   segments (kind not in enum, name not in the provider registry).
 * - 401/403 inherited from the standard auth gate (scribe:admin scope).
 *
 * Phase 2 polish from scribe#47 + #48 reviews. Today the only clearable
 * `field` is `apiKey`; the response carries `field` explicitly so future
 * additions (e.g. claude-code `setupToken`) can extend without reshaping
 * the wire contract.
 */
async function handleClearCredential(
  internalPath: string,
  deps: ServerDeps,
): Promise<Response> {
  // Path is `/admin/clear-credential/<kind>/<name>` — anything past the
  // two segments is a bad request (no field-targeting yet; apiKey is the
  // only clearable field for now).
  const suffix = internalPath.slice("/admin/clear-credential/".length);
  const parts = suffix.split("/").filter((s) => s.length > 0);
  if (parts.length !== 2) {
    return Response.json(
      {
        error: "invalid_path",
        message:
          "expected /admin/clear-credential/<kind>/<name> — e.g. /admin/clear-credential/cleanup/anthropic",
      },
      { status: 400 },
    );
  }
  const [kindRaw, nameRaw] = parts;
  // Decode in case the SPA URL-encoded a provider name with special chars.
  let kind: string;
  let name: string;
  try {
    kind = decodeURIComponent(kindRaw!);
    name = decodeURIComponent(nameRaw!);
  } catch {
    return Response.json(
      { error: "invalid_path", message: "malformed URL encoding in path" },
      { status: 400 },
    );
  }
  const validation = validateClearCredentialTarget(kind, name);
  if (!validation.ok) {
    return Response.json(
      { error: validation.error, message: validation.message },
      { status: 400 },
    );
  }

  const path = deps.configPath ?? resolveDefaultConfigPath();
  let existing: ScribeConfig;
  try {
    existing = readExistingConfig(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scribe] clear-credential config read failed (${path}): ${message}`);
    return Response.json(
      { error: "read_failed", message: `failed to read ${path}: ${message}` },
      { status: 500 },
    );
  }

  const { cleared, config: nextConfig } = clearProviderCredential(
    existing,
    validation.kind,
    validation.name,
  );

  try {
    writeConfigFileAtomic(path, nextConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scribe] clear-credential config write failed (${path}): ${message}`);
    return Response.json(
      { error: "write_failed", message: `failed to write ${path}: ${message}` },
      { status: 500 },
    );
  }

  // Sync the in-process scribeConfig so the next transcribe/cleanup request
  // doesn't keep using the just-cleared apiKey from memory.
  deps.scribeConfig.transcribeProviders = nextConfig.transcribeProviders;
  deps.scribeConfig.cleanupProviders = nextConfig.cleanupProviders;

  return Response.json({
    ok: true,
    cleared: { kind: validation.kind, name: validation.name, field: "apiKey" },
    hadStoredValue: cleared,
  });
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

  const missingProvider = guardMissingProvider(deps);
  if (missingProvider) return missingProvider;

  const cleanupParam = form.get("cleanup");
  const contextPart = form.get("context");
  let contextPayload: ContextPayload | null = null;
  if (contextPart != null) {
    const raw = contextPart instanceof Blob ? await contextPart.text() : String(contextPart);
    contextPayload = parseContextPayload(raw);
    if (!contextPayload) {
      console.warn("[scribe] malformed 'context' part in transcription request — ignoring, cleanup will run without proper nouns");
    }
  }

  return runTranscribePipeline(file, deps, {
    cleanupParam: typeof cleanupParam === "string" ? cleanupParam : null,
    contextPayload,
  });
}

/**
 * URL-source transcription: download an audio file from a public URL,
 * then run the same pipeline. The body is JSON (not multipart) — the
 * caller has nothing to upload, just a URL and optional options.
 *
 * Request body:
 *   { "url": "https://...", "cleanup"?: bool|"true"|"false",
 *     "context"?: ContextPayload }
 *
 * Response: same `{text}` shape as the file endpoint, with an
 * additional `source.url` echoing what was actually fetched (post any
 * redirects).
 */
async function handleTranscriptionUrl(req: Request, deps: ServerDeps): Promise<Response> {
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
  if (!body || typeof body !== "object") {
    return Response.json({ error: "missing 'url' field" }, { status: 400 });
  }
  const { url: urlInput, cleanup: cleanupParam, context: contextRaw } = body as Record<string, unknown>;
  if (typeof urlInput !== "string" || urlInput.trim() === "") {
    return Response.json({ error: "missing 'url' field" }, { status: 400 });
  }

  const missingProvider = guardMissingProvider(deps);
  if (missingProvider) return missingProvider;

  let fetched: FetchedAudio;
  try {
    fetched = await fetchAudioFromUrl(urlInput.trim());
  } catch (err) {
    if (err instanceof UrlFetchError) {
      return Response.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scribe] unexpected url-fetch error:", message);
    return Response.json(
      { error: "fetch_failed", message },
      { status: 502 },
    );
  }

  let contextPayload: ContextPayload | null = null;
  if (contextRaw != null) {
    // Accept either a parsed object OR a JSON string (mirrors the
    // multipart endpoint where the `context` part arrives as a Blob).
    const raw =
      typeof contextRaw === "string" ? contextRaw : JSON.stringify(contextRaw);
    contextPayload = parseContextPayload(raw);
    if (!contextPayload) {
      console.warn(
        "[scribe] malformed 'context' field on /v1/audio/transcriptions-url — ignoring",
      );
    }
  }

  const normalizedCleanup =
    typeof cleanupParam === "boolean"
      ? cleanupParam
        ? "true"
        : "false"
      : typeof cleanupParam === "string"
        ? cleanupParam
        : null;

  return runTranscribePipeline(fetched.file, deps, {
    cleanupParam: normalizedCleanup,
    contextPayload,
    source: { url: fetched.finalUrl, bytes: fetched.bytes, contentType: fetched.contentType },
  });
}

/**
 * Shared pipeline driver — used by both the multipart file endpoint and
 * the JSON URL endpoint. Decides whether to run cleanup based on the
 * `cleanupParam` string ("true"/"false"/null) and the resolved config's
 * default, then returns the standard `{text, source?}` response.
 */
export async function runTranscribePipeline(
  file: File,
  deps: ServerDeps,
  opts: {
    cleanupParam: string | null;
    contextPayload: ContextPayload | null;
    source?: { url: string; bytes: number; contentType: string | null };
  },
): Promise<Response> {
  if (deps.transcribe === null) {
    // Belt + braces — both call sites already guard, but a future caller
    // (MCP) could reach here directly.
    return missingProviderResponse();
  }
  const { cleanupProvider, cleanupDefault } = deps.resolvedConfig;
  const { cleanupParam, contextPayload, source } = opts;
  const doCleanup =
    cleanupProvider !== "none" &&
    (cleanupParam === "true" || cleanupParam === "1"
      ? true
      : cleanupParam === "false" || cleanupParam === "0"
        ? false
        : cleanupDefault);

  let text: string;
  try {
    text = await deps.transcribe(file);
  } catch (err: unknown) {
    // A typed backend error (e.g. ffmpeg missing) is a structured,
    // operator-fixable failure — return a stable `backend_unavailable` 503
    // mirroring the `missing_provider` 400 path, so the cause + fix reach the
    // caller (and vault's transcription worker) instead of an opaque 500.
    if (err instanceof TranscribeBackendError) {
      return backendUnavailableResponse(err);
    }
    const message = err instanceof Error ? err.message : "transcription failed";
    console.error("Transcription error:", message);
    return Response.json({ error: message }, { status: 500 });
  }

  // Cleanup outcome, surfaced on the response so a skipped cleanup is no
  // longer silent (Part 2 / finding C). `applied:false` carries the short
  // error; the raw transcript is still returned with a 200 (semantics
  // unchanged — additive field only).
  let cleanup: CleanupOutcome | undefined;
  if (doCleanup) {
    try {
      const properNouns = contextPayload
        ? buildProperNounsBlockFromEntries(contextPayload)
        : "";
      text = await deps.cleanup(text, properNouns, {
        systemPrompt: deps.scribeConfig.cleanup?.system_prompt,
        contextTemplate: deps.scribeConfig.cleanup?.context_template,
      });
      cleanup = { applied: true, provider: cleanupProvider };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      cleanup = { applied: false, provider: cleanupProvider, error: message };
      // Unmissable WARNING — the operator must know the returned transcript is
      // RAW (proper-noun correction NOT applied), not the cleaned text they
      // configured. (Previously a single quiet console.error.)
      console.error(
        `[scribe] WARNING: cleanup skipped (provider=${cleanupProvider}): ${message} — RAW transcript returned, proper-noun correction NOT applied`,
      );
    }
  }

  const body: { text: string; source?: typeof source; cleanup?: CleanupOutcome } = { text };
  if (source) body.source = source;
  if (cleanup) body.cleanup = cleanup;
  return Response.json(body);
}

/**
 * Cleanup outcome surfaced on the transcribe response. Additive +
 * backwards-compatible: present only when cleanup was attempted (i.e. a
 * cleanup provider other than `none` was selected for the request). Callers
 * that don't know the field ignore it; callers that do can detect "raw
 * transcript returned because cleanup failed" without parsing logs.
 */
type CleanupOutcome =
  | { applied: true; provider: string }
  | { applied: false; provider: string; error: string };

/**
 * Structured 503 for a typed transcription-backend failure (today: ffmpeg
 * missing). Mirrors `missingProviderResponse`'s shape so vault's worker —
 * which JSON-parses `{error, error_code, message}` — gets a clean,
 * branch-able body. 503 (≥500) is retriable in vault's `callScribe`, which is
 * the desired behavior: the operator installs ffmpeg and the next sweep
 * succeeds without a manual re-queue.
 */
function backendUnavailableResponse(err: TranscribeBackendError): Response {
  console.error(`[scribe] transcription backend unavailable (${err.code}): ${err.message}`);
  return Response.json(
    {
      error: err.message,
      error_code: "backend_unavailable",
      message: err.message,
    },
    { status: 503 },
  );
}

function guardMissingProvider(deps: ServerDeps): Response | null {
  if (deps.transcribe !== null) return null;
  return missingProviderResponse();
}

function missingProviderResponse(): Response {
  // Graceful first-boot path (site#52 Part 1, resolved Q2): if no
  // transcription provider is wired up, return a stable 400 the caller
  // can branch on. Vault's auto-transcribe maps `error_code:
  // "missing_provider"` to `transcript_status: failed` with a clean
  // `transcript_error` string.
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

export type StartServerOptions = {
  /**
   * Mount-prefix this scribe instance answers under. Forwarded from
   * `parachute-scribe serve --mount <prefix>`. Default `""` keeps
   * routes bare at the origin root (legacy behavior). Issue #39.
   */
  mount?: string;
};

export async function startServer(opts: StartServerOptions = {}) {
  const config = await loadConfig();
  const mount = normalizeMount(opts.mount ?? "");

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
  console.log(`  mount:      ${mount === "" ? "(none — bare routes at origin root)" : mount}`);
  warnIfTokenLooksJwt();

  const handler = createFetchHandler({
    transcribe,
    cleanup,
    resolvedConfig,
    scribeConfig: config,
    mount,
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

  // Self-register into `~/.parachute/services.json` so `parachute status`,
  // `parachute restart scribe`, hub's admin SPA module catalog, and the
  // live `/.well-known/parachute.json` builder see scribe without an
  // operator step. Best-effort: a failure here doesn't block the daemon
  // from serving locally — `selfRegister` swallows the error and logs.
  // The helper reads `.parachute/module.json` for the canonical paths /
  // health / displayName / tagline / stripPrefix shape (scribe#38), and
  // honors a pre-existing services.json port so an operator override
  // survives restarts (scribe#40 / paraclaw#145).
  selfRegister({
    boundPort: PORT,
    installDir: resolveProjectRoot(),
  });
}
