import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PORT,
  DISPLAY_NAME,
  MOUNT_PATH,
  SERVICE_NAME,
  TAGLINE,
  handleParachuteIcon,
  handleParachuteInfo,
} from "./parachute-info.ts";
import pkg from "../package.json" with { type: "json" };

describe("parachute-info", () => {
  test("DEFAULT_PORT is 1943 (canonical scribe port in the 1939–1949 band)", () => {
    expect(DEFAULT_PORT).toBe(1943);
  });

  test("handleParachuteInfo returns correct shape", async () => {
    const res = handleParachuteInfo();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({
      name: SERVICE_NAME,
      displayName: DISPLAY_NAME,
      tagline: TAGLINE,
      kind: "api",
      version: pkg.version,
      iconUrl: `${MOUNT_PATH}/.parachute/icon.svg`,
    });
  });

  test("handleParachuteIcon returns SVG with correct headers", async () => {
    const res = handleParachuteIcon();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toContain("max-age=3600");
    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).toContain("</svg>");
    expect(body).toContain(">S<");
  });
});
