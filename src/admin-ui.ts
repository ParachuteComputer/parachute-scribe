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
 *   - When loaded through hub's reverse proxy, the page fetches a
 *     `scribe:admin` Bearer from the hub on load (cookie-gated mint endpoint
 *     at `/admin/module-token/scribe`, `credentials:"include"` — same-origin
 *     under the proxy so the operator's hub session cookie flows). Every
 *     data/mutation fetch attaches `Authorization: Bearer <token>`. On a 401,
 *     the page re-fetches the token once and retries. This mirrors channel's
 *     `src/admin-ui.ts` `fetchToken()` + `authHeaders()` pattern.
 *   - When loaded directly (no hub in front / not signed in), the token fetch
 *     fails; the page surfaces a "not signed in" banner pointing the operator
 *     at the hub. Scribe doesn't try to invent its own session system — it is
 *     stateless by design.
 *   - In open mode (`SCRIBE_AUTH_TOKEN` unset, loopback-trusted), the token
 *     fetch will fail (no hub), but the data calls succeed anyway because the
 *     auth gate is bypassed — the page sends requests without a Bearer and
 *     scribe accepts them in open mode.
 *
 * Link to a vault (modular-UI R3, the consistent-with-channel flow):
 *   Scribe is STATELESS — it never reads from or writes to a vault. The
 *   vault↔scribe relationship is driven entirely vault-side: a vault's
 *   in-process transcription worker reads an audio attachment and POSTs it to
 *   scribe's `/v1/audio/transcriptions` (discovered via services.json) WHEN the
 *   vault's `auto_transcribe.enabled` toggle is on. So "link scribe to a vault"
 *   is NOT a hub `vault-trigger` connection (scribe accepts no per-note webhook
 *   and holds no vault credentials) — it is a CONFIG link: enable auto-transcribe
 *   in the chosen vault. The page mirrors channel's UX (pick a vault from the
 *   hub's public well-known doc, the click is the approval) but provisions a
 *   vault config edit instead of a hub connection:
 *     1. Populate the vault dropdown from `<origin>/.well-known/parachute.json`
 *        (same-origin under the hub proxy, public — no token).
 *     2. On link: mint a short-lived `vault:<vault>:admin` from the hub's
 *        cookie-gated `<origin>/admin/vault-admin-token/<vault>`
 *        (`credentials:"include"` — the operator's hub session is the approval).
 *     3. PATCH `<origin>/vault/<vault>/api/vault` with that Bearer to set
 *        `config.auto_transcribe.enabled = true`, then READ IT BACK and only
 *        report success when the vault confirms it — so an older vault that
 *        doesn't yet accept the toggle surfaces an honest "enable it in the
 *        vault's own settings" notice instead of a false success.
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
            <!-- Inline availability status for the SELECTED transcription
                 backend. Populated by checkAvailability() — ✓ available, or
                 ⚠ with the exact fix. Non-blocking: it never prevents save. -->
            <div class="backend-status" id="status-transcribeProvider" hidden></div>
          </label>

          <label class="field">
            <span class="field-label">Cleanup provider</span>
            <select name="cleanupProvider" id="f-cleanupProvider"></select>
            <span class="field-hint" id="hint-cleanupProvider">Optional LLM pass — pick "none" to skip cleanup.</span>
            <div class="backend-status" id="status-cleanupProvider" hidden></div>
          </label>

          <label class="field field-inline">
            <input type="checkbox" name="cleanupDefault" id="f-cleanupDefault" />
            <span class="field-label-inline">Run cleanup by default</span>
            <span class="field-hint" id="hint-cleanupDefault">Applied when a transcription request omits an explicit cleanup flag.</span>
          </label>

          <!-- Cleanup tuning — promoted into its own labeled section so the
               system-prompt + proper-nouns knobs are discoverable, not buried
               below the provider selects. -->
          <div class="section" id="cleanup-tuning">
            <div class="section-head">
              <h2 class="section-title">Cleanup tuning</h2>
              <p class="section-desc">
                Shape how the cleanup LLM rewrites raw transcripts. Both fields are optional —
                leave them empty to use scribe's built-in defaults.
              </p>
            </div>

            <label class="field">
              <span class="field-label">Cleanup system prompt</span>
              <textarea name="cleanupSystemPrompt" id="f-cleanupSystemPrompt" rows="10" placeholder="Leave empty to use scribe's built-in prompt."></textarea>
              <span class="field-hint">
                A full override of scribe's built-in cleanup instructions (filler-word removal, punctuation, formatting).
                The proper-nouns / vocabulary block is still appended after this.
              </span>
            </label>

            <label class="field">
              <span class="field-label">Proper-nouns / vocabulary template</span>
              <textarea name="cleanupContextTemplate" id="f-cleanupContextTemplate" rows="4" placeholder="e.g. \\n\\nKnown names &amp; terms: {{proper_nouns}}"></textarea>
              <span class="field-hint">
                Controls how vocabulary hints are appended to the prompt. Use <code>{{proper_nouns}}</code> as the placeholder.
                Leave empty to use scribe's default rule.
                <strong>Note:</strong> the proper nouns themselves are supplied <em>per request</em> (in the transcription
                request's <code>context</code> part) — they are not stored here. This field only sets the wrapping template.
              </span>
            </label>
          </div>
        </fieldset>

        <div class="button-row" id="button-row" hidden>
          <button type="submit" class="btn btn-primary" id="save-btn">Save configuration</button>
          <button type="button" class="btn btn-secondary" id="reload-btn">Reload from server</button>
        </div>
      </form>

      <section class="section" id="link-vault-section">
        <div class="section-head">
          <h2 class="section-title">Link to a vault</h2>
          <p class="section-desc">
            Turn on auto-transcription for a Parachute vault: audio notes recorded there are
            sent to scribe automatically and the transcript lands back on the note. Pick a vault and
            link it &mdash; <strong>clicking the button is your approval</strong>. Scribe stays stateless;
            this flips the chosen vault's <code>auto_transcribe</code> setting (the vault calls scribe over
            loopback when an audio note appears).
          </p>
        </div>
        <div id="link-banner" class="banner" hidden></div>
        <form id="link-form" class="config-form" novalidate>
          <label class="field">
            <span class="field-label">Vault</span>
            <select name="linkVault" id="f-linkVault">
              <option value="" disabled selected>Loading vaults&hellip;</option>
            </select>
            <span class="field-hint" id="hint-linkVault">Which vault's audio notes scribe should transcribe.</span>
          </label>
          <div class="button-row">
            <button type="submit" class="btn btn-primary" id="link-btn" disabled>Link to vault</button>
          </div>
        </form>
      </section>

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
  /* The 'hidden' HTML attribute resolves to UA-stylesheet 'display: none',
   * which loses specificity to the author-stylesheet 'fieldset { display:
   * flex; }' rule above. Without this override, el("form-loading").hidden
   * = true sets the attribute but the loading legend stays visible —
   * stacked on top of the loaded form below it. The operator sees BOTH
   * "Loading current configuration…" AND the rendered fields. Same
   * collision applies to #form-body's initial 'hidden' state (it hides
   * via the display: none rule below before applyConfig runs), so the
   * !important is necessary to make the attribute reliably win over any
   * fieldset display rule. Caught 2026-05-27 on Aaron's deploy after the
   * 0.4.5 mount-detect fix made the form actually reachable. */
  fieldset[hidden] { display: none !important; }
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

  /* Inline per-backend availability status — sits directly under the
     provider select it describes. Three visual states keyed off the
     server-computed verdict: ok (green ✓), warn (amber ⚠ + fix), unknown
     (muted). NON-BLOCKING by design — purely advisory. */
  .backend-status {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.45rem;
    padding: 0.55rem 0.7rem;
    border-radius: 6px;
    font-size: 0.82rem;
    border: 1px solid transparent;
  }
  .backend-status .bs-line { display: flex; align-items: baseline; gap: 0.4rem; }
  .backend-status .bs-icon { font-size: 0.9rem; line-height: 1; }
  .backend-status .bs-detail { font-weight: 500; }
  .backend-status .bs-fix {
    margin: 0;
    font-weight: 400;
    line-height: 1.45;
    opacity: 0.95;
  }
  .backend-status code {
    font-family: ${FONT_MONO};
    font-size: 0.85em;
    background: rgba(0,0,0,0.05);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
  .backend-status .bs-actions { margin-top: 0.35rem; }
  .bs-ok {
    background: ${PALETTE.successSoft};
    border-color: ${PALETTE.success};
    color: ${PALETTE.success};
  }
  .bs-warn {
    background: ${PALETTE.dangerSoft};
    border-color: ${PALETTE.danger};
    color: ${PALETTE.danger};
  }
  .bs-unknown {
    background: ${PALETTE.bgSoft};
    border-color: ${PALETTE.border};
    color: ${PALETTE.fgMuted};
  }
  /* A small inline button used inside a backend-status block (the claude-code
     Refresh affordance). Smaller than the form buttons; inherits the status
     color for its border so it reads as part of the block. */
  .bs-btn {
    font: inherit;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.3rem 0.7rem;
    border-radius: 5px;
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .bs-btn:hover { background: rgba(0,0,0,0.06); }
  .bs-btn:disabled { opacity: 0.6; cursor: progress; }

  /* Cleanup tuning section — a labeled, visually-separated block so the
     prompt + vocabulary knobs are discoverable instead of buried. */
  .section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding-top: 1.25rem;
    border-top: 1px solid ${PALETTE.borderLight};
  }
  .section-head { display: flex; flex-direction: column; gap: 0.3rem; }
  .section-title {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.2rem;
    margin: 0;
    color: ${PALETTE.fg};
  }
  .section-desc {
    margin: 0;
    font-size: 0.85rem;
    color: ${PALETTE.fgMuted};
  }
  .field-hint em { font-style: italic; }

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
    .section { border-color: #3a362f; }
    .section-title { color: #f0ece4; }
    .section-desc { color: #a8a29a; }
    .backend-status code { background: rgba(255,255,255,0.08); }
    .bs-btn:hover { background: rgba(255,255,255,0.08); }
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

  // --- Auth bootstrap: mint a scribe:admin Bearer from the hub ---------------
  //
  // The page loads open (no Bearer required to GET the HTML). On DOMContentLoaded
  // we fetch a short-lived scribe:admin JWT from the hub's cookie-gated endpoint
  // (same-origin under the hub proxy -- credentials:"include" lets the operator's
  // hub session cookie flow). The token is stored in window.__scribeToken and
  // attached to every subsequent data/mutation fetch via authHeaders().
  //
  // Open mode (SCRIBE_AUTH_TOKEN unset): the token fetch will fail (no hub endpoint),
  // but the data calls succeed because the auth gate is bypassed server-side.
  // That case is harmless: authHeaders() returns an empty object when the token
  // is null, and scribe accepts no-token requests in open mode.
  //
  // Mirrors channel's fetchToken() + authHeaders() pattern exactly.
  window.__scribeToken = null;

  function fetchScribeToken() {
    return fetch(window.location.origin + "/admin/module-token/scribe", {
      credentials: "include",
      headers: { accept: "application/json" },
    })
      .then(function (r) {
        if (!r.ok) return null;
        return r.json().catch(function () { return null; });
      })
      .then(function (j) {
        window.__scribeToken = (j && j.token) ? j.token : null;
        return window.__scribeToken;
      })
      .catch(function () {
        window.__scribeToken = null;
        return null;
      });
  }

  function authHeaders(extra) {
    var h = extra || {};
    if (window.__scribeToken) h.authorization = "Bearer " + window.__scribeToken;
    return h;
  }

  // Re-fetch the token once, then retry a single fetch call. Used when a data
  // call returns 401 -- re-mints the token in case it expired, then retries.
  // Returns the response from the retried call (or the original 401 if the
  // token is still null after re-mint, so the caller can surface the error).
  function retryWithFreshToken(fetchFn) {
    return fetchScribeToken().then(function () {
      return fetchFn();
    });
  }

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

  // Latest backend-availability report (set by checkAvailability). Keyed by
  // { transcribe: {name: {...}}, cleanup: {name: {...}} }. Held so a provider
  // select-change can re-render the inline status without another fetch.
  var AVAILABILITY = null;

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

  // --- Backend availability (Change 1) -------------------------------------
  //
  // Fetch the server-side report and render the inline status for whatever
  // backend is currently SELECTED in each provider dropdown. The report is
  // advisory: we never disable Save based on it. A failed fetch leaves the
  // status blocks hidden rather than erroring the page.

  var STATUS_IDS = {
    transcribeProvider: "status-transcribeProvider",
    cleanupProvider: "status-cleanupProvider",
  };

  // Build the inner HTML for one status block from a verdict object.
  function renderStatusInner(verdict, opts) {
    opts = opts || {};
    // Icons as HTML numeric entities -- NOT literal glyphs. This page-script
    // string is a String.raw template, where non-ASCII source characters are
    // unreliable (Bun's transpile can emit them as literal backslash-u escapes
    // that String.raw then preserves verbatim). ASCII entities render fine via
    // innerHTML on every browser: check = &#10003;, warn = &#9888;, info =
    // &#8505;.
    var icon;
    var cls;
    if (verdict.status === "available") { icon = "&#10003;"; cls = "bs-ok"; }
    else if (verdict.status === "unavailable" || verdict.status === "warning" || verdict.status === "unauthenticated") { icon = "&#9888;"; cls = "bs-warn"; }
    else { icon = "&#8505;"; cls = "bs-unknown"; } // unknown / ok-no-check fall here; ok-no-check is filtered before render

    var html = '<div class="bs-line"><span class="bs-icon">' + icon + '</span>' +
      '<span class="bs-detail">' + escapeHtml(verdict.detail || "") + "</span></div>";
    if (verdict.fix) {
      html += '<p class="bs-fix">' + escapeHtml(verdict.fix) + "</p>";
    }
    if (opts.refreshButton) {
      // The claude-code Refresh affordance (Change 3) -- re-reads the
      // setup-token status + re-runs the availability probe in place.
      html += '<div class="bs-actions">' +
        '<button type="button" class="bs-btn" id="claude-refresh-btn">Refresh status</button>' +
        "</div>";
    }
    return { html: html, cls: cls };
  }

  function renderBackendStatus(blockId, verdict, opts) {
    var node = el(blockId);
    if (!node) return;
    // ok-no-check (e.g. cleanup "none", or a provider with no local dep AND no
    // key requirement) -> nothing useful to show; keep the block hidden.
    if (!verdict || verdict.status === "ok-no-check") {
      node.hidden = true;
      node.innerHTML = "";
      node.className = "backend-status";
      return;
    }
    var r = renderStatusInner(verdict, opts);
    node.className = "backend-status " + r.cls;
    node.innerHTML = r.html;
    node.hidden = false;
  }

  // Re-render both inline status blocks for the currently-selected providers.
  function refreshStatusDisplay() {
    if (!AVAILABILITY) return;
    var tName = el(FIELD_IDS.transcribeProvider).value;
    var cName = el(FIELD_IDS.cleanupProvider).value;
    var tVerdict = (AVAILABILITY.transcribe || {})[tName];
    var cVerdict = (AVAILABILITY.cleanup || {})[cName];
    renderBackendStatus(STATUS_IDS.transcribeProvider, tVerdict, {});
    // The claude-code cleanup block gets the inline Refresh button.
    renderBackendStatus(STATUS_IDS.cleanupProvider, cVerdict, {
      refreshButton: cName === "claude-code",
    });
    wireClaudeRefresh();
  }

  // "probe" opts into the live "claude -p" auth probe server-side (?probe=1).
  // Initial page load passes it falsy (fast, file-token only -- no subprocess
  // spawned on every page view); the claude-code Refresh button passes true so
  // the operator gets an authoritative auth verdict (the file-token read is
  // unreliable on macOS under launchd). NB: avoid backticks in this comment --
  // this whole block is a String.raw template; a backtick would close it early.
  async function checkAvailability(probe) {
    var base = (window.__SCRIBE_CONFIG_URL__ || "/.parachute/config").replace(/\/\.parachute\/config$/, "");
    var url = base + "/admin/backend-availability" + (probe ? "?probe=1" : "");
    try {
      var res = await fetch(url, { headers: authHeaders() });
      // On 401, re-mint token once and retry. Advisory endpoint: any
      // non-200 after retry leaves status hidden (no page error).
      if (res.status === 401) {
        res = await retryWithFreshToken(function () {
          return fetch(url, { headers: authHeaders() });
        });
      }
      if (!res.ok) return; // advisory: leave status hidden on non-200
      AVAILABILITY = await res.json();
      refreshStatusDisplay();
    } catch (_e) {
      // Network/parse failure -- advisory endpoint, swallow silently.
    }
  }

  // --- claude-code Refresh button (Change 3) -------------------------------
  function wireClaudeRefresh() {
    var btn = el("claude-refresh-btn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      var prev = btn.textContent;
      // Plain ASCII "..." -- a literal ellipsis glyph in this String.raw block
      // renders as a visible backslash-u escape in the served JS (Bun transpile
      // + String.raw quirk). textContent can't use an HTML entity, so use "...".
      btn.textContent = "Refreshing...";
      var base = (window.__SCRIBE_CONFIG_URL__ || "/.parachute/config").replace(/\/\.parachute\/config$/, "");
      try {
        // POST /admin/refresh-claude-token-status re-reads ~/.claude.json. We
        // then re-run the full availability probe so the inline status (CLI
        // presence + token) updates in place without a page reload.
        var refreshRes = await fetch(base + "/admin/refresh-claude-token-status", {
          method: "POST",
          headers: authHeaders(),
        });
        // On 401: re-mint token then retry the POST (best-effort; the re-probe
        // below is the meaningful work, so any outcome here is fine).
        if (refreshRes.status === 401) {
          await retryWithFreshToken(function () {
            return fetch(base + "/admin/refresh-claude-token-status", {
              method: "POST",
              headers: authHeaders(),
            });
          });
        }
      } catch (_e) { /* fall through to re-probe */ }
      // Pass probe=true: run the authoritative live "claude -p" auth probe,
      // not just the (macOS-unreliable) file-token read.
      await checkAvailability(true);
      // checkAvailability re-renders + re-wires; if it failed, restore the
      // button so the operator can retry.
      var stillThere = el("claude-refresh-btn");
      if (stillThere) { stillThere.disabled = false; stillThere.textContent = prev; }
    });
  }

  // Perform the actual schema+config fetch pair (shared by loadConfig and the
  // 401-retry path). Returns { schemaRes, configRes } or throws on network error.
  function fetchConfigPair() {
    return Promise.all([
      fetch(window.__SCRIBE_SCHEMA_URL__ || "/.parachute/config/schema", { headers: authHeaders() }),
      fetch(window.__SCRIBE_CONFIG_URL__ || "/.parachute/config", { headers: authHeaders() }),
    ]).then(function (res) { return { schemaRes: res[0], configRes: res[1] }; });
  }

  async function loadConfig() {
    clearBanner();
    clearFieldErrors();
    el("form-loading").hidden = false;
    el("form-body").hidden = true;
    el("button-row").hidden = true;

    try {
      var pair = await fetchConfigPair();
      var schemaRes = pair.schemaRes;
      var configRes = pair.configRes;

      // 401: re-mint the token once and retry. This handles the case where the
      // token expired between page load and the first data fetch, or the token
      // fetch itself silently failed (open-mode, hub not running).
      if (schemaRes.status === 401 || configRes.status === 401) {
        await fetchScribeToken();
        var retried = await fetchConfigPair();
        schemaRes = retried.schemaRes;
        configRes = retried.configRes;
      }

      // After retry, if still 401, surface a clear not-signed-in notice.
      if (schemaRes.status === 401 || configRes.status === 401) {
        setBanner(
          "warn",
          "<strong>Not signed in to the hub.</strong> Scribe requires a <code>scribe:admin</code> token. " +
            "Open this page through the Parachute hub portal (signed in) at <code>/scribe/admin</code>, " +
            "or set <code>SCRIBE_AUTH_TOKEN</code> empty for loopback-trusted (open) mode."
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
      // Inline backend-availability status (Change 1) -- fire after the form
      // is visible so a slow/failing probe never blocks rendering the config.
      checkAvailability();
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
    // ASCII "..." -- see the Refreshing button note: a literal ellipsis renders
    // as a visible backslash-u escape in this String.raw page-script.
    saveBtn.textContent = "Saving...";

    const body = collectForm();
    const configBodyStr = JSON.stringify(body);
    function doSaveFetch() {
      return fetch(window.__SCRIBE_CONFIG_URL__ || "/.parachute/config", {
        method: "PUT",
        headers: authHeaders({ "content-type": "application/json" }),
        body: configBodyStr,
      });
    }
    let res;
    try {
      res = await doSaveFetch();
      // On 401: re-mint token once and retry the PUT.
      if (res.status === 401) {
        res = await retryWithFreshToken(doSaveFetch);
      }
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
        "warn",
        "<strong>Not signed in to the hub.</strong> Open this page through the Parachute hub portal at <code>/scribe/admin</code> (signed in), then try again."
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
        setBanner("success", "<strong>Configuration saved.</strong> Changes take effect immediately &mdash; no restart needed.");
      } else {
        const items = restart.map(function (f) {
          return "<li><code>" + escapeHtml(f) + "</code> &mdash; " + escapeHtml(RESTART_LABELS[f] || f) + "</li>";
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
        // Change 4 -- make restart-required unmistakable + actionable. The
        // saved value is on disk but the RUNNING server still uses the old
        // provider until restart; an operator who doesn't restart thinks the
        // new backend is live when it isn't. Spell out HOW to restart.
        // Banner copy uses the &mdash; entity, not a literal em-dash -- see the
        // icon-entity note above; non-ASCII glyphs in this String.raw block are
        // unreliable. innerHTML renders &mdash; as the em-dash.
        setBanner(
          "success",
          "<strong>Saved &mdash; but not live yet.</strong> These changes only take effect after you restart scribe:" +
            "<ul>" + items + "</ul>" +
            "<p class=\"banner-footnote\">Restart now: run <code>parachute restart scribe</code> (or restart it however you run scribe). " +
            "Until you do, the server keeps using the previous setting.</p>" +
            portNote
        );
      }
      // A successful save can change availability (e.g. an API key was just
      // stored) -- re-probe so the inline status reflects reality immediately.
      checkAvailability();
    }

    saveBtn.disabled = false;
    saveBtn.textContent = "Save configuration";
  }

  // --- Link to a vault (modular-UI R3, the config-link flow) ---------------
  //
  // Scribe is stateless: it never reads or writes a vault. "Link to a vault"
  // means "turn on auto-transcribe in that vault" -- the vault then calls
  // scribe over loopback when an audio note appears. We mirror channel's UX
  // (pick a vault from the hub's PUBLIC well-known doc; the click is the
  // approval) but provision a vault CONFIG edit, not a hub connection.
  //
  // ORIGIN. Everything here is keyed off window.location.origin -- the page is
  // same-origin under the hub proxy, so the hub's /.well-known, /admin/* mint,
  // and /vault/* proxy all resolve at the page origin. A direct-to-daemon load
  // (no hub) has no /admin mint endpoint; the flow surfaces a clear notice.

  function setLinkBanner(kind, trustedHtml) {
    var b = el("link-banner");
    if (!b) return;
    b.className = "banner banner-" + kind;
    b.innerHTML = trustedHtml;
    b.hidden = false;
    b.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function clearLinkBanner() {
    var b = el("link-banner");
    if (!b) return;
    b.hidden = true;
    b.innerHTML = "";
    b.className = "banner";
  }

  // Populate the vault dropdown from the hub's PUBLIC discovery doc. Same-origin
  // under the /scribe proxy, no token needed -- it's public.
  function loadVaults() {
    return fetch(window.location.origin + "/.well-known/parachute.json", {
      headers: { accept: "application/json" },
      credentials: "include",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) {
        var sel = el("f-linkVault");
        if (!sel) return;
        var vaults = (doc && Array.isArray(doc.vaults)) ? doc.vaults : [];
        sel.innerHTML = "";
        if (!vaults.length) {
          var opt = document.createElement("option");
          opt.value = "";
          opt.disabled = true;
          opt.selected = true;
          opt.textContent = "No vaults found";
          sel.appendChild(opt);
          el("link-btn").disabled = true;
          el("hint-linkVault").textContent =
            "No vaults are installed on this hub yet -- create one in the hub portal first.";
          return;
        }
        vaults.forEach(function (v, i) {
          var opt = document.createElement("option");
          opt.value = v.name;
          opt.textContent = v.name;
          if (i === 0) opt.selected = true;
          sel.appendChild(opt);
        });
        el("link-btn").disabled = false;
      })
      .catch(function () {
        var sel = el("f-linkVault");
        if (!sel) return;
        sel.innerHTML = "";
        var opt = document.createElement("option");
        opt.value = "";
        opt.disabled = true;
        opt.selected = true;
        opt.textContent = "Could not load vaults";
        sel.appendChild(opt);
        el("link-btn").disabled = true;
      });
  }

  // Mint a short-lived vault:<vault>:admin from the hub (cookie-gated to the
  // logged-in operator). Returns the token string, or null on any failure --
  // the caller renders the right notice from the HTTP status it observed.
  function mintVaultAdminToken(vault) {
    return fetch(
      window.location.origin + "/admin/vault-admin-token/" + encodeURIComponent(vault),
      { credentials: "include", headers: { accept: "application/json" } }
    ).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (payload) {
        return { status: r.status, token: payload && payload.token ? payload.token : null };
      });
    });
  }

  async function linkToVault(ev) {
    ev.preventDefault();
    clearLinkBanner();
    var vault = el("f-linkVault").value;
    if (!vault) { setLinkBanner("error", "<strong>Pick a vault.</strong>"); return; }
    var btn = el("link-btn");
    btn.disabled = true;
    var prev = btn.textContent;
    // ASCII "..." -- a literal ellipsis renders as a visible backslash-u escape
    // in this String.raw page-script (Bun transpile + String.raw quirk).
    btn.textContent = "Linking...";
    try {
      // 1. Mint the vault admin token from the hub (the operator's hub session
      //    cookie is the approval). A 401/403 here means "not signed in to the
      //    hub as admin" -- surface that, don't pretend it worked.
      var mint = await mintVaultAdminToken(vault);
      if (mint.status === 401) {
        setLinkBanner(
          "warn",
          "<strong>Not signed in to the hub.</strong> Linking a vault uses your hub admin session. " +
            "Open this page through the Parachute hub portal (signed in) at <code>/scribe/admin</code>, then try again."
        );
        return;
      }
      if (mint.status === 403) {
        setLinkBanner(
          "error",
          "<strong>Not permitted.</strong> Only the hub admin can enable auto-transcribe on a vault."
        );
        return;
      }
      if (!mint.token) {
        setLinkBanner(
          "error",
          "<strong>Could not get vault access.</strong> The hub did not mint a vault admin token (HTTP " +
            escapeHtml(String(mint.status)) + "). Open this page through the hub portal and retry."
        );
        return;
      }

      // 2. PATCH the vault config to enable auto-transcribe, through the hub's
      //    per-vault proxy. The body shape mirrors the vault's PATCH /api/vault
      //    contract (config block); auto_transcribe.enabled is the master toggle
      //    (vault#353).
      var patchRes = await fetch(
        window.location.origin + "/vault/" + encodeURIComponent(vault) + "/api/vault",
        {
          method: "PATCH",
          headers: {
            authorization: "Bearer " + mint.token,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ config: { auto_transcribe: { enabled: true } } }),
        }
      );
      if (!patchRes.ok) {
        var pErr = await patchRes.json().catch(function () { return {}; });
        setLinkBanner(
          "error",
          "<strong>Link failed.</strong> " +
            escapeHtml((pErr && (pErr.message || pErr.error)) || ("HTTP " + patchRes.status))
        );
        return;
      }

      // 3. READ IT BACK and only claim success when the vault confirms the
      //    toggle. An older vault that doesn't yet accept auto_transcribe will
      //    PATCH 200 but won't echo it enabled -- we must NOT report a false
      //    success. We branch on whether the readback reports it on.
      var confirmed = false;
      try {
        var getRes = await fetch(
          window.location.origin + "/vault/" + encodeURIComponent(vault) + "/api/vault",
          { headers: { authorization: "Bearer " + mint.token, accept: "application/json" } }
        );
        if (getRes.ok) {
          var doc = await getRes.json();
          var at = doc && doc.config && doc.config.auto_transcribe;
          confirmed = !!(at && at.enabled === true);
        }
      } catch (_e) { /* readback failed -- fall through to the unconfirmed path */ }

      if (confirmed) {
        setLinkBanner(
          "success",
          "<strong>Linked.</strong> Vault <code>" + escapeHtml(vault) +
            "</code> now auto-transcribes audio notes through scribe. " +
            "Make sure scribe stays running and reachable (it self-registers in <code>services.json</code>)."
        );
      } else {
        // PATCH was accepted but the readback didn't confirm the toggle is on --
        // almost always an older vault build whose PATCH /api/vault doesn't yet
        // handle auto_transcribe. Tell the operator exactly how to finish.
        setLinkBanner(
          "warn",
          "<strong>Couldn't confirm the toggle.</strong> The hub accepted the request, but vault <code>" +
            escapeHtml(vault) + "</code> didn't report auto-transcribe as enabled &mdash; it's likely on an older " +
            "version. Enable it from the vault's own settings (set <code>auto_transcribe.enabled: true</code> in its " +
            "<code>config.yaml</code>), then make sure scribe is running."
        );
      }
    } catch (err) {
      setLinkBanner("error", "<strong>Network error.</strong> " + escapeHtml(err && err.message ? err.message : String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    el("config-form").addEventListener("submit", saveConfig);
    el("reload-btn").addEventListener("click", loadConfig);
    // Link-to-a-vault flow (R3). The vault dropdown loads in parallel with the
    // config form (public well-known doc, no token).
    var linkForm = el("link-form");
    if (linkForm) {
      linkForm.addEventListener("submit", linkToVault);
      loadVaults();
    }
    // When the operator picks a different backend, re-render the inline
    // availability status for the newly-selected one from the cached report
    // (no refetch needed -- the report covers every backend).
    el(FIELD_IDS.transcribeProvider).addEventListener("change", refreshStatusDisplay);
    el(FIELD_IDS.cleanupProvider).addEventListener("change", refreshStatusDisplay);
    // Fetch the hub token first so the config API calls go out authenticated.
    // A token failure (open mode / hub not running) still proceeds to loadConfig
    // -- which succeeds in open mode (auth gate bypassed) and surfaces the
    // not-signed-in banner on a resulting 401 so the operator sees one clear
    // notice. Mirrors channel's fetchToken().then(loadChannels) pattern.
    fetchScribeToken().then(loadConfig);
  });
`;
