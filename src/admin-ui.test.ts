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
