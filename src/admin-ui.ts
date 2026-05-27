/**
 * Static HTML for `/scribe/admin` — the operator-facing config form.
 *
 * Single self-contained document: HTML + inline CSS + inline JS, no build
 * step, no framework. Ships in the npm tarball as the rendered string this
 * file exports. Same shape as hub's `oauth-ui.ts` / `admin-login-ui.ts`.
 *
 * The page fetches `/.parachute/config/schema` and `/.parachute/config` on
 * load and renders one form field per schema property. On save it PUTs the
 * collected values back to `/.parachute/config` and surfaces the
 * `restart_required` list returned by the server.
 *
 * Auth posture:
 *   - When loaded through hub's reverse proxy, the hub injects a Bearer with
 *     `scribe:admin` scope based on the operator's hub session — the form's
 *     fetch calls go through with that token and the operator never sees it.
 *   - When loaded directly (no hub in front), the page has no token to send.
 *     The schema/config fetch on load surfaces the 401 with a "no auth
 *     detected" banner pointing the operator at the hub. Scribe doesn't try
 *     to invent its own session system — it's stateless by design.
 *   - In open mode (`SCRIBE_AUTH_TOKEN` unset, loopback-trusted), the page
 *     just works without a Bearer because the auth gate is bypassed.
 */

const PALETTE = {
  bg: "#faf8f4",
  bgSoft: "#f3f0ea",
  fg: "#2c2a26",
  fgMuted: "#6b6860",
  fgDim: "#9a9690",
  accent: "#6A9B77",
  accentHover: "#588163",
  accentSoft: "rgba(106, 155, 119, 0.10)",
  border: "#e4e0d8",
  borderLight: "#ece9e2",
  cardBg: "#ffffff",
  danger: "#a3392b",
  dangerSoft: "rgba(163, 57, 43, 0.08)",
  success: "#3d6849",
  successSoft: "rgba(61, 104, 73, 0.08)",
} as const;

const FONT_SERIF = `Georgia, "Times New Roman", serif`;
const FONT_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const FONT_MONO = `ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace`;

/**
 * Render the admin page. Pure function — returns the HTML string. The page
 * itself fetches live state on load (one round-trip for the schema, one for
 * the resolved config), so the rendered HTML is the same across requests
 * for a given mount.
 *
 * `mount` is the path prefix the in-page fetches must use to reach scribe's
 * `/.parachute/config` and `/.parachute/config/schema` endpoints. When
 * scribe is launched with `--mount /scribe`, the canonical URL of those
 * endpoints externally is `/scribe/.parachute/config`; the page can't
 * assume bare-root URLs. Default `""` (no mount) preserves the existing
 * shape for direct-loopback callers. Issue #39.
 */
export function renderAdminPage(mount = ""): string {
  // Server-side `mount` builds the visible "Live values" links in the
  // page chrome. For the in-page JS fetches we ALSO detect the mount
  // at runtime from `window.location.pathname` (see the inline
  // <script> below) — that path is the one that works when scribe is
  // launched without `--mount` and accessed through the hub's
  // `/scribe` proxy (the hub strips the `/scribe` prefix before
  // forwarding, so scribe's request-level mount is empty even though
  // the public mount is `/scribe`). Without the runtime fallback the
  // page hits `/.parachute/config/schema` at the origin root and the
  // hub 404s. Aaron hit this 2026-05-27 on the live deploy.
  const configUrl = `${mount}/.parachute/config`;
  const schemaUrl = `${mount}/.parachute/config/schema`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Scribe — Configuration</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <style>${STYLES}</style>
</head>
<body>
  <main>
    <div class="card">
      <header class="card-header">
        <div class="brand">
          <span class="brand-mark">S</span>
          <span class="brand-name">Scribe</span>
          <span class="brand-tag">configuration</span>
        </div>
        <h1>Configure transcription &amp; cleanup</h1>
        <p class="subtitle">Edit values and save. Provider or port changes take effect on the next restart.</p>
      </header>

      <div id="status-banner" class="banner" hidden></div>

      <form id="config-form" class="config-form" novalidate>
        <fieldset class="loading" id="form-loading">
          <legend>Loading current configuration…</legend>
        </fieldset>

        <fieldset class="form-body" id="form-body" hidden>
          <label class="field">
            <span class="field-label">Transcription provider</span>
            <select name="transcribeProvider" id="f-transcribeProvider"></select>
            <span class="field-hint" id="hint-transcribeProvider">Engine used to turn audio into text.</span>
          </label>

          <label class="field">
            <span class="field-label">Cleanup provider</span>
            <select name="cleanupProvider" id="f-cleanupProvider"></select>
            <span class="field-hint" id="hint-cleanupProvider">Optional LLM pass — pick "none" to skip cleanup.</span>
          </label>

          <label class="field field-inline">
            <input type="checkbox" name="cleanupDefault" id="f-cleanupDefault" />
            <span class="field-label-inline">Run cleanup by default</span>
            <span class="field-hint" id="hint-cleanupDefault">Applied when a transcription request omits an explicit cleanup flag.</span>
          </label>

          <label class="field">
            <span class="field-label">Cleanup system prompt</span>
            <textarea name="cleanupSystemPrompt" id="f-cleanupSystemPrompt" rows="10" placeholder="Leave empty to use scribe's built-in prompt."></textarea>
            <span class="field-hint">Full override of the built-in cleanup system prompt. The proper-nouns block from the request payload is still appended after this.</span>
          </label>

          <label class="field">
            <span class="field-label">Cleanup context template</span>
            <textarea name="cleanupContextTemplate" id="f-cleanupContextTemplate" rows="4" placeholder="e.g. \\n\\nKnown names: {{proper_nouns}}"></textarea>
            <span class="field-hint">Template for the proper-nouns block. Use <code>{{proper_nouns}}</code> as the placeholder. Leave empty to use scribe's default rule.</span>
          </label>
        </fieldset>

        <div class="button-row" id="button-row" hidden>
          <button type="submit" class="btn btn-primary" id="save-btn">Save configuration</button>
          <button type="button" class="btn btn-secondary" id="reload-btn">Reload from server</button>
        </div>
      </form>

      <footer class="card-footer">
        <p class="footer-hint">
          File on disk: <code>~/.parachute/scribe/config.json</code>.
          Live values (resolved): <a href="${configUrl}">${configUrl}</a>.
          Schema: <a href="${schemaUrl}">${schemaUrl}</a>.
        </p>
      </footer>
    </div>
  </main>

  <script>
    // Mount-prefix the page-script's fetch URLs see. Two sources of
    // truth here, in priority order:
    //
    //   1. RUNTIME detection from window.location.pathname (the
    //      load-bearing path). The admin page is served at
    //      \`<mount>/admin\` (canonical) or \`<mount>/scribe/admin\`
    //      (legacy alias). Strip the suffix to recover \`<mount>\`.
    //      Works regardless of how scribe was launched: direct
    //      loopback (mount = ""), through a hub mounted at /scribe
    //      (mount = "/scribe"), or any custom prefix.
    //
    //   2. SERVER-rendered fallback (\`${schemaUrl}\` etc.) — used
    //      only when window.location is unavailable (server-side
    //      render harness, future SSR, paranoid env).
    //
    // Aaron hit the wrong-URL bug on 2026-05-27 when scribe was
    // launched without \`--mount /scribe\` but accessed through the
    // hub's /scribe proxy. The hub strips /scribe before forwarding,
    // so scribe's server-side mount is "", but the browser-visible
    // page URL is /scribe/admin and the schema lives at
    // /scribe/.parachute/config/schema. Runtime detection captures
    // this without needing the launcher to pass --mount.
    (function () {
      function detectMount() {
        try {
          var path = window.location.pathname.replace(/\\/+$/, "");
          // The admin page is served at <mount>/admin. Strip just
          // the trailing "/admin" segment to recover <mount>.
          //
          // Works for every shape (Aaron's fix #2 — the prior version
          // had a buggy "/scribe/admin" first-branch that stripped the
          // ENTIRE path, leaving mount="" for the hub-proxy case):
          //
          //   /admin           → mount = ""        (direct loopback)
          //   /scribe/admin    → mount = "/scribe" (hub proxy)
          //   /any/path/admin  → mount = "/any/path" (custom proxy)
          //
          // The dedicated /scribe/admin route in src/server.ts is a
          // legacy alias scribe handles too — but for the purposes of
          // the BROWSER, the path is just a path; what we need is the
          // prefix that comes BEFORE /admin to build sibling URLs.
          if (path.endsWith("/admin")) return path.slice(0, -"/admin".length);
          // Unrecognized suffix — return null so the server-rendered
          // fallback fires. Avoids silently producing wrong URLs if a
          // future proxy nests scribe under a non-canonical shape.
          return null;
        } catch (_e) {
          return null;
        }
      }
      var runtimeMount = detectMount();
      var serverConfigUrl = ${JSON.stringify(configUrl)};
      var serverSchemaUrl = ${JSON.stringify(schemaUrl)};
      if (runtimeMount === null) {
        window.__SCRIBE_CONFIG_URL__ = serverConfigUrl;
        window.__SCRIBE_SCHEMA_URL__ = serverSchemaUrl;
      } else {
        window.__SCRIBE_CONFIG_URL__ = runtimeMount + "/.parachute/config";
        window.__SCRIBE_SCHEMA_URL__ = runtimeMount + "/.parachute/config/schema";
      }
    })();
  </script>
  <script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${FONT_SANS};
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    line-height: 1.55;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  main {
    display: flex;
    justify-content: center;
    padding: 2.5rem 1.5rem;
  }
  .card {
    width: 100%;
    max-width: 44rem;
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.border};
    border-radius: 12px;
    padding: 2rem 1.75rem;
    box-shadow: 0 1px 2px rgba(44, 42, 38, 0.04), 0 8px 24px rgba(44, 42, 38, 0.06);
  }
  .card-header { margin-bottom: 1.5rem; }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: ${PALETTE.accent};
    font-weight: 500;
    font-size: 0.95rem;
    margin-bottom: 1.25rem;
  }
  .brand-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
    font-weight: 600;
    font-size: 0.85rem;
    line-height: 1;
  }
  .brand-name { letter-spacing: 0.01em; font-weight: 600; }
  .brand-tag {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
    color: ${PALETTE.fgDim};
    border-left: 1px solid ${PALETTE.border};
    padding-left: 0.55rem;
    margin-left: 0.15rem;
  }
  h1 {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.75rem;
    line-height: 1.2;
    margin: 0 0 0.4rem;
    color: ${PALETTE.fg};
  }
  .subtitle {
    margin: 0;
    color: ${PALETTE.fgMuted};
    font-size: 0.95rem;
  }

  .banner {
    margin: 0 0 1.25rem;
    padding: 0.75rem 0.9rem;
    border-radius: 6px;
    font-size: 0.9rem;
    border: 1px solid transparent;
  }
  .banner-error {
    background: ${PALETTE.dangerSoft};
    border-color: ${PALETTE.danger};
    color: ${PALETTE.danger};
  }
  .banner-success {
    background: ${PALETTE.successSoft};
    border-color: ${PALETTE.success};
    color: ${PALETTE.success};
  }
  .banner-warn {
    background: ${PALETTE.bgSoft};
    border-color: ${PALETTE.border};
    color: ${PALETTE.fgMuted};
  }
  .banner ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
  .banner-footnote {
    margin: 0.6rem 0 0;
    padding-top: 0.5rem;
    border-top: 1px solid rgba(0,0,0,0.08);
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .banner code {
    font-family: ${FONT_MONO};
    font-size: 0.85em;
    background: rgba(255,255,255,0.5);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }

  .config-form { display: flex; flex-direction: column; gap: 1.25rem; }
  fieldset {
    border: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  fieldset.loading {
    padding: 1.25rem;
    background: ${PALETTE.bgSoft};
    border-radius: 6px;
    color: ${PALETTE.fgMuted};
    font-size: 0.9rem;
    text-align: center;
  }
  fieldset.loading legend { padding: 0; }

  .field { display: flex; flex-direction: column; gap: 0.3rem; }
  .field-inline {
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .field-inline .field-hint { flex-basis: 100%; margin-left: 1.6rem; }
  .field-label {
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
    letter-spacing: 0.01em;
  }
  .field-label-inline { font-size: 0.95rem; }
  .field-hint {
    font-size: 0.8rem;
    color: ${PALETTE.fgDim};
  }
  .field-hint code {
    font-family: ${FONT_MONO};
    font-size: 0.85em;
    background: ${PALETTE.bgSoft};
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    color: ${PALETTE.fgMuted};
  }
  .field-error {
    font-size: 0.8rem;
    color: ${PALETTE.danger};
    font-weight: 500;
  }

  select, textarea, input[type=text], input[type=number] {
    font: inherit;
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  textarea {
    font-family: ${FONT_MONO};
    font-size: 0.88rem;
    resize: vertical;
    min-height: 4rem;
    line-height: 1.5;
  }
  select:focus, textarea:focus, input:focus {
    outline: none;
    border-color: ${PALETTE.accent};
    background: ${PALETTE.cardBg};
    box-shadow: 0 0 0 3px ${PALETTE.accentSoft};
  }
  input[type=checkbox] {
    width: 1.1rem;
    height: 1.1rem;
    accent-color: ${PALETTE.accent};
    margin: 0;
  }
  .field-invalid select, .field-invalid textarea, .field-invalid input {
    border-color: ${PALETTE.danger};
  }

  .btn {
    font: inherit;
    font-weight: 500;
    padding: 0.6rem 1.1rem;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .btn-primary {
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
  }
  .btn-primary:hover { background: ${PALETTE.accentHover}; }
  .btn-primary:disabled { background: ${PALETTE.fgDim}; cursor: progress; }
  .btn-secondary {
    background: ${PALETTE.cardBg};
    color: ${PALETTE.fgMuted};
    border-color: ${PALETTE.border};
  }
  .btn-secondary:hover { color: ${PALETTE.fg}; border-color: ${PALETTE.fgDim}; }
  .button-row { display: flex; gap: 0.6rem; margin-top: 0.5rem; }

  .card-footer {
    margin-top: 1.75rem;
    padding-top: 1.25rem;
    border-top: 1px solid ${PALETTE.borderLight};
    color: ${PALETTE.fgMuted};
    font-size: 0.82rem;
  }
  .footer-hint { margin: 0; }
  .footer-hint code {
    font-family: ${FONT_MONO};
    font-size: 0.85em;
    background: ${PALETTE.bgSoft};
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    color: ${PALETTE.fg};
  }
  .footer-hint a { color: ${PALETTE.accent}; }
  .footer-hint a:hover { color: ${PALETTE.accentHover}; }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1 { color: #f0ece4; }
    .subtitle, .field-label, .field-hint { color: #a8a29a; }
    select, textarea, input[type=text], input[type=number] {
      background: #1f1c18; border-color: #3a362f; color: #e8e4dc;
    }
    select:focus, textarea:focus, input:focus { background: #25221d; }
    .btn-secondary { background: #25221d; border-color: #3a362f; color: #a8a29a; }
    .btn-secondary:hover { color: #e8e4dc; border-color: #6b6860; }
    .card-footer { border-color: #3a362f; }
    fieldset.loading { background: #1f1c18; }
  }

  @media (max-width: 600px) {
    main { padding: 1rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.45rem; }
    .button-row { flex-direction: column; }
    .button-row .btn { width: 100%; }
  }
`;

// The page script is intentionally vanilla JS — no bundler, no transpile.
// It runs on whatever the browser supports today; modern fetch + async/await
// + DOM APIs are everywhere we care about. The string is interpolated into
// the served HTML; do NOT use backticks inside without escaping them, since
// this whole file is a TS template literal.
const PAGE_SCRIPT = String.raw`
  "use strict";

  const FIELD_IDS = {
    transcribeProvider: "f-transcribeProvider",
    cleanupProvider: "f-cleanupProvider",
    cleanupDefault: "f-cleanupDefault",
    cleanupSystemPrompt: "f-cleanupSystemPrompt",
    cleanupContextTemplate: "f-cleanupContextTemplate",
  };

  const RESTART_LABELS = {
    transcribeProvider: "Transcription provider",
    cleanupProvider: "Cleanup provider",
    port: "Server port",
  };

  function el(id) { return document.getElementById(id); }

  // The second arg is named trustedHtml as a signal that callers MUST have
  // sanitized any untrusted content (escapeHtml() etc.) before passing it
  // in. innerHTML is the right primitive here because the success banner
  // composes its own HTML <ul>; renaming makes the contract explicit at
  // every call site.
  function setBanner(kind, trustedHtml) {
    const b = el("status-banner");
    b.className = "banner banner-" + kind;
    b.innerHTML = trustedHtml;
    b.hidden = false;
    b.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function clearBanner() {
    const b = el("status-banner");
    b.hidden = true;
    b.innerHTML = "";
    b.className = "banner";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function clearFieldErrors() {
    document.querySelectorAll(".field-error").forEach(function (n) { n.remove(); });
    document.querySelectorAll(".field-invalid").forEach(function (n) {
      n.classList.remove("field-invalid");
    });
  }

  function setFieldError(name, message) {
    const id = FIELD_IDS[name];
    if (!id) return;
    const input = el(id);
    if (!input) return;
    const field = input.closest(".field");
    if (!field) return;
    field.classList.add("field-invalid");
    const err = document.createElement("span");
    err.className = "field-error";
    err.textContent = message;
    field.appendChild(err);
  }

  function populateSelect(id, options, current) {
    const select = el(id);
    select.innerHTML = "";
    options.forEach(function (opt) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (opt === current) o.selected = true;
      select.appendChild(o);
    });
  }

  function collectForm() {
    return {
      transcribeProvider: el(FIELD_IDS.transcribeProvider).value,
      cleanupProvider: el(FIELD_IDS.cleanupProvider).value,
      cleanupDefault: el(FIELD_IDS.cleanupDefault).checked,
      cleanupSystemPrompt: el(FIELD_IDS.cleanupSystemPrompt).value || null,
      cleanupContextTemplate: el(FIELD_IDS.cleanupContextTemplate).value || null,
    };
  }

  function applyConfig(schema, current) {
    const props = schema.properties || {};
    const transcribeEnum = (props.transcribeProvider && props.transcribeProvider.enum) || [];
    const cleanupEnum = (props.cleanupProvider && props.cleanupProvider.enum) || [];
    populateSelect(FIELD_IDS.transcribeProvider, transcribeEnum, current.transcribeProvider);
    populateSelect(FIELD_IDS.cleanupProvider, cleanupEnum, current.cleanupProvider);
    el(FIELD_IDS.cleanupDefault).checked = !!current.cleanupDefault;
    el(FIELD_IDS.cleanupSystemPrompt).value = current.cleanupSystemPrompt || "";
    el(FIELD_IDS.cleanupContextTemplate).value = current.cleanupContextTemplate || "";
  }

  async function loadConfig() {
    clearBanner();
    clearFieldErrors();
    el("form-loading").hidden = false;
    el("form-body").hidden = true;
    el("button-row").hidden = true;

    try {
      const [schemaRes, configRes] = await Promise.all([
        fetch(window.__SCRIBE_SCHEMA_URL__ || "/.parachute/config/schema"),
        fetch(window.__SCRIBE_CONFIG_URL__ || "/.parachute/config"),
      ]);
      if (schemaRes.status === 401 || configRes.status === 401) {
        setBanner(
          "warn",
          "<strong>No auth detected.</strong> Scribe requires a bearer token with the <code>scribe:admin</code> scope, " +
            "but this page has no way to mint one. Access the configuration through the Parachute hub (which proxies " +
            "with the appropriate session), or set <code>SCRIBE_AUTH_TOKEN</code> empty for loopback-trusted mode."
        );
        el("form-loading").hidden = true;
        return;
      }
      if (!schemaRes.ok) throw new Error("schema fetch failed (" + schemaRes.status + ")");
      if (!configRes.ok) throw new Error("config fetch failed (" + configRes.status + ")");

      const schema = await schemaRes.json();
      const current = await configRes.json();
      applyConfig(schema, current);
      el("form-loading").hidden = true;
      el("form-body").hidden = false;
      el("button-row").hidden = false;
    } catch (err) {
      el("form-loading").hidden = true;
      setBanner(
        "error",
        "<strong>Could not load configuration.</strong> " + escapeHtml(err && err.message ? err.message : String(err))
      );
    }
  }

  async function saveConfig(ev) {
    ev.preventDefault();
    clearBanner();
    clearFieldErrors();
    const saveBtn = el("save-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    const body = collectForm();
    let res;
    try {
      res = await fetch(window.__SCRIBE_CONFIG_URL__ || "/.parachute/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save configuration";
      setBanner("error", "<strong>Network error.</strong> " + escapeHtml(err && err.message ? err.message : String(err)));
      return;
    }

    let payload = null;
    try { payload = await res.json(); } catch (_e) { /* non-JSON */ }

    if (res.status === 400 && payload && Array.isArray(payload.errors)) {
      payload.errors.forEach(function (err) {
        if (err && err.path) setFieldError(err.path, err.message || "invalid");
      });
      setBanner(
        "error",
        "<strong>Validation failed.</strong> Fix the highlighted fields and save again."
      );
    } else if (res.status === 401) {
      setBanner(
        "error",
        "<strong>Unauthorized.</strong> Reload this page through the Parachute hub so it proxies with your operator session."
      );
    } else if (res.status === 403) {
      setBanner(
        "error",
        "<strong>Forbidden.</strong> Your session is missing the <code>scribe:admin</code> scope."
      );
    } else if (!res.ok) {
      const msg = payload && payload.message ? payload.message : ("HTTP " + res.status);
      setBanner("error", "<strong>Save failed.</strong> " + escapeHtml(msg));
    } else {
      const restart = (payload && payload.restart_required) || [];
      if (restart.length === 0) {
        setBanner("success", "<strong>Configuration saved.</strong> Changes take effect immediately.");
      } else {
        const items = restart.map(function (f) {
          return "<li><code>" + escapeHtml(f) + "</code> — " + escapeHtml(RESTART_LABELS[f] || f) + "</li>";
        }).join("");
        // Surface the port-is-not-in-config.json gotcha: when 'port' shows
        // up in restart_required, an unwary operator will edit config.json
        // (or re-save the form) and find scribe still binds the same port.
        // Port resolution reads services.json + SCRIBE_PORT env, not
        // config.json -- call that out inline so the operator knows where
        // to actually change it.
        const portNote = restart.indexOf("port") !== -1
          ? "<p class=\"banner-footnote\">Note: <code>port</code> is set via <code>services.json</code> or the <code>SCRIBE_PORT</code> environment variable, not <code>config.json</code>.</p>"
          : "";
        setBanner(
          "success",
          "<strong>Configuration saved.</strong> Restart scribe to apply these changes:<ul>" + items + "</ul>" + portNote
        );
      }
    }

    saveBtn.disabled = false;
    saveBtn.textContent = "Save configuration";
  }

  document.addEventListener("DOMContentLoaded", function () {
    el("config-form").addEventListener("submit", saveConfig);
    el("reload-btn").addEventListener("click", loadConfig);
    loadConfig();
  });
`;
