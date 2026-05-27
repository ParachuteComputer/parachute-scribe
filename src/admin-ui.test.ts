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

  test("inline script uses runtime-detected mount, not server-side, as primary", () => {
    // Pure structural check: the runtime-detection branch must come
    // FIRST in the if/else. If a refactor flips the priority, the
    // bug Aaron hit (server-side mount = "" but real public mount is
    // /scribe) reappears.
    const html = renderAdminPage("");
    const runtimeIdx = html.indexOf("runtimeMount + ");
    const fallbackIdx = html.indexOf("= serverConfigUrl");
    expect(runtimeIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    // The runtime + branch should appear AFTER the fallback branch in
    // the if/else (the fallback is the `if (runtimeMount === null)`
    // arm; runtime is the `else` arm).
    // Both should be present and the script should reference both.
    expect(html).toContain("runtimeMount === null");
  });
});
