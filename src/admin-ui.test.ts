/**
 * Tests for `renderAdminPage()`. Focused on the runtime-mount-detection
 * shape — the load-bearing fix for the "hub strips /scribe before
 * forwarding" case where server-side `mount` is empty but the browser
 * page URL is `/scribe/admin`.
 *
 * No DOM tests here; this just verifies the rendered HTML strings
 * carry the right script shape.
 */
import { describe, expect, test } from "bun:test";
import { renderAdminPage } from "./admin-ui.ts";

describe("renderAdminPage", () => {
  test("renders with the server-side mount in the visible chrome", () => {
    const html = renderAdminPage("/scribe");
    expect(html).toContain('href="/scribe/.parachute/config"');
    expect(html).toContain('href="/scribe/.parachute/config/schema"');
  });

  test("renders with empty server-side mount → visible URLs at root", () => {
    const html = renderAdminPage("");
    expect(html).toContain('href="/.parachute/config"');
    expect(html).toContain('href="/.parachute/config/schema"');
  });

  test("inline script contains the runtime-mount-detection function", () => {
    const html = renderAdminPage("");
    // The detection function strips /scribe/admin and /admin suffixes
    // from window.location.pathname. The test asserts both literal
    // suffix strings are present in the script body — guards against
    // a future refactor accidentally removing the legacy alias.
    expect(html).toContain('"/scribe/admin"');
    expect(html).toContain('"/admin"');
    expect(html).toContain("window.location.pathname");
    expect(html).toContain("__SCRIBE_CONFIG_URL__");
    expect(html).toContain("__SCRIBE_SCHEMA_URL__");
  });

  test("inline script falls back to server-rendered URLs when detection fails", () => {
    // The detection function returns null when window.location is
    // unavailable. The script then uses the server-rendered fallback
    // (the literal string the server interpolated).
    const html = renderAdminPage("/scribe");
    // The fallback values are JSON-encoded literals in the script.
    expect(html).toContain('"/scribe/.parachute/config"');
    expect(html).toContain('"/scribe/.parachute/config/schema"');
  });

  test("STYLES carries fieldset[hidden] override so the loading legend can be hidden", () => {
    // The 'fieldset { display: flex }' rule in the styles block beats the
    // UA-stylesheet `[hidden] { display: none }` in specificity (author
    // element selector vs. UA attribute selector), so without an explicit
    // `fieldset[hidden] { display: none !important }` the `hidden` attribute
    // toggles in loadConfig() set the attribute but don't visually hide the
    // legend — operator sees both "Loading current configuration…" AND the
    // rendered form fields stacked together. Caught 2026-05-27 on Aaron's
    // deploy after the 0.4.5 mount-detect fix made the form reachable.
    const html = renderAdminPage("");
    expect(html).toContain("fieldset[hidden]");
    expect(html).toContain("display: none !important");
  });

  test("inline script wires both runtime and fallback URL branches", () => {
    // Pure structural check: the runtime-detected branch (uses
    // `runtimeMount + ...`) and the server-rendered fallback branch
    // (uses the JSON-encoded server values) must BOTH be present and
    // gated by the `runtimeMount === null` discriminator. If a
    // refactor removes either branch, the bug Aaron hit (server-side
    // mount = "" but real public mount is /scribe) reappears.
    const html = renderAdminPage("");
    expect(html).toContain("runtimeMount + ");
    expect(html).toContain("= serverConfigUrl");
    expect(html).toContain("runtimeMount === null");
  });
});

/**
 * Behavioral tests for the inline `detectMount` function. We extract
 * the JS body via regex + evaluate it under a stubbed `window` so we
 * can assert the actual return value for each pathname shape — not
 * just the presence of source strings.
 *
 * Pinning the regression Aaron hit twice:
 *   1. Original bug — pathname `/scribe/admin` produced mount `""`
 *      because no detection logic existed at all (server-side mount
 *      was "" because scribe was launched without --mount).
 *   2. First-fix bug — pathname `/scribe/admin` STILL produced mount
 *      `""` because the detection function's first branch stripped
 *      the ENTIRE `/scribe/admin` suffix. The fix in this PR strips
 *      just `/admin`, leaving `/scribe` as the prefix.
 */
function extractAndRunDetectMount(pathname: string): string | null {
  const html = renderAdminPage("");
  // The detect function body is the function literal in the inline
  // <script>. Grab it via a sentinel comment + run it in a stubbed
  // window context.
  const start = html.indexOf("function detectMount()");
  if (start === -1) throw new Error("detectMount not found in rendered HTML");
  // Find the matching closing brace for the function body. Simple
  // brace-counting since the body is well-formed.
  let depth = 0;
  let i = html.indexOf("{", start);
  const bodyStart = i;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const fnSource = `(function () { ${html.slice(start, i + 1)} return detectMount; })`;
  // biome-ignore lint/security/noGlobalEval: test-only eval of trusted source rendered by the page.
  const factory = eval(fnSource);
  const fn = factory();
  // Stub window.location.pathname in a sandboxed global.
  const prevWindow = (globalThis as { window?: { location: { pathname: string } } }).window;
  (globalThis as { window?: { location: { pathname: string } } }).window = {
    location: { pathname },
  };
  try {
    return fn() as string | null;
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  }
  // Use `bodyStart` to silence lint (the brace-finder uses it as the entry index).
  void bodyStart;
}

describe("detectMount runtime behavior", () => {
  test("/admin (direct loopback) → mount = \"\"", () => {
    expect(extractAndRunDetectMount("/admin")).toBe("");
  });

  test("/scribe/admin (hub proxy) → mount = \"/scribe\"", () => {
    // Load-bearing assertion. The original bug AND the first-fix bug
    // both produced "" here. The fix in this PR returns "/scribe".
    expect(extractAndRunDetectMount("/scribe/admin")).toBe("/scribe");
  });

  test("/some/custom/prefix/admin → mount = \"/some/custom/prefix\"", () => {
    expect(extractAndRunDetectMount("/some/custom/prefix/admin")).toBe("/some/custom/prefix");
  });

  test("/admin/ (trailing slash) → mount = \"\"", () => {
    expect(extractAndRunDetectMount("/admin/")).toBe("");
  });

  test("/scribe/admin/ (trailing slash) → mount = \"/scribe\"", () => {
    expect(extractAndRunDetectMount("/scribe/admin/")).toBe("/scribe");
  });

  test("unrecognized path → null (server fallback fires)", () => {
    expect(extractAndRunDetectMount("/some/other/page")).toBeNull();
  });
});

describe("config UX additions (scribe config-UX PR)", () => {
  test("renders inline backend-status containers for both provider selects", () => {
    const html = renderAdminPage("");
    expect(html).toContain('id="status-transcribeProvider"');
    expect(html).toContain('id="status-cleanupProvider"');
  });

  test("script fetches the backend-availability endpoint", () => {
    const html = renderAdminPage("");
    expect(html).toContain("/admin/backend-availability");
    expect(html).toContain("checkAvailability");
  });

  test("promotes a labeled 'Cleanup tuning' section with both knobs", () => {
    const html = renderAdminPage("");
    expect(html).toContain("Cleanup tuning");
    // Both fields still present, now inside the section.
    expect(html).toContain('name="cleanupSystemPrompt"');
    expect(html).toContain('name="cleanupContextTemplate"');
    // Explains proper nouns are supplied per-request, not stored in config.
    expect(html).toContain("per request");
  });

  test("wires the claude-code Refresh button + its endpoint", () => {
    const html = renderAdminPage("");
    expect(html).toContain("claude-refresh-btn");
    expect(html).toContain("/admin/refresh-claude-token-status");
    expect(html).toContain("Refresh status");
  });

  test("restart banner is unmistakable + names the restart command", () => {
    const html = renderAdminPage("");
    // Source carries the &mdash; entity (non-ASCII glyphs are unreliable
    // inside the String.raw page-script block — see admin-ui.ts).
    expect(html).toContain("Saved &mdash; but not live yet");
    expect(html).toContain("parachute restart scribe");
  });
});

describe("token bootstrap (open-page + hub-mint pattern)", () => {
  test("page script declares fetchScribeToken that hits /admin/module-token/scribe", () => {
    const html = renderAdminPage("");
    expect(html).toContain("fetchScribeToken");
    expect(html).toContain("/admin/module-token/scribe");
    // credentials:"include" so the hub session cookie flows same-origin.
    expect(html).toContain('credentials: "include"');
  });

  test("page script declares authHeaders() that attaches window.__scribeToken as Bearer", () => {
    const html = renderAdminPage("");
    expect(html).toContain("authHeaders");
    expect(html).toContain("window.__scribeToken");
    expect(html).toContain('"Bearer " + window.__scribeToken');
  });

  test("page script calls fetchScribeToken before loadConfig on DOMContentLoaded", () => {
    const html = renderAdminPage("");
    // Mirrors channel's fetchToken().then(loadChannels) boot order.
    expect(html).toContain("fetchScribeToken().then(loadConfig)");
  });

  test("page script retries data fetches with a fresh token on 401", () => {
    const html = renderAdminPage("");
    // retryWithFreshToken is the shared retry helper.
    expect(html).toContain("retryWithFreshToken");
    expect(html).toContain("fetchScribeToken");
  });

  test("not-signed-in banner copy matches the new hub-portal framing", () => {
    // The old copy pointed at SCRIBE_AUTH_TOKEN; the new copy points at
    // the hub portal since that is now the auth path.
    const html = renderAdminPage("");
    expect(html).toContain("Not signed in to the hub");
    expect(html).toContain("/scribe/admin");
  });
});

describe("link to a vault (modular-UI R3)", () => {
  test("renders the link-to-vault section with a vault picker + button", () => {
    const html = renderAdminPage("");
    expect(html).toContain('id="link-vault-section"');
    expect(html).toContain("Link to a vault");
    expect(html).toContain('id="f-linkVault"');
    expect(html).toContain('id="link-btn"');
    expect(html).toContain('id="link-form"');
  });

  test("vault picker is populated from the hub's public well-known doc", () => {
    const html = renderAdminPage("");
    expect(html).toContain("/.well-known/parachute.json");
    expect(html).toContain("loadVaults");
    // Reads the `vaults` array off the discovery doc, same as channel.
    expect(html).toContain("doc.vaults");
  });

  test("link mints a vault admin token from the hub's cookie-gated endpoint", () => {
    const html = renderAdminPage("");
    expect(html).toContain("/admin/vault-admin-token/");
    expect(html).toContain("mintVaultAdminToken");
    // The operator's hub session cookie is the approval.
    expect(html).toContain('credentials: "include"');
  });

  test("link PATCHes the chosen vault's config to enable auto_transcribe", () => {
    const html = renderAdminPage("");
    expect(html).toContain("/api/vault");
    expect(html).toContain('method: "PATCH"');
    // The exact body shape the vault PATCH /api/vault contract expects.
    expect(html).toContain("auto_transcribe");
    expect(html).toContain('JSON.stringify({ config: { auto_transcribe: { enabled: true } } })');
  });

  test("link reads back + only claims success when the vault confirms the toggle", () => {
    const html = renderAdminPage("");
    // Honest model: an older vault PATCHes 200 but won't echo the toggle —
    // the readback gate prevents a false success.
    expect(html).toContain("confirmed");
    expect(html).toContain("auto_transcribe");
    // Success copy AND the older-vault fallback copy are both present.
    expect(html).toContain("now auto-transcribes audio notes");
    expect(html).toContain("Couldn't confirm the toggle");
  });

  test("link surfaces a clear not-signed-in notice on a 401 mint", () => {
    const html = renderAdminPage("");
    expect(html).toContain("Not signed in to the hub");
  });
});
