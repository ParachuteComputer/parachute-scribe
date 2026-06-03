import { describe, expect, test } from "bun:test";
import { resolveBindHostname } from "./bind.ts";

describe("resolveBindHostname", () => {
  test("defaults to loopback when SCRIBE_BIND is unset", () => {
    expect(resolveBindHostname({})).toBe("127.0.0.1");
  });

  test("defaults to loopback when SCRIBE_BIND is empty / whitespace", () => {
    expect(resolveBindHostname({ SCRIBE_BIND: "" })).toBe("127.0.0.1");
    expect(resolveBindHostname({ SCRIBE_BIND: "   " })).toBe("127.0.0.1");
  });

  test("honors an explicit SCRIBE_BIND override (0.0.0.0 to expose)", () => {
    expect(resolveBindHostname({ SCRIBE_BIND: "0.0.0.0" })).toBe("0.0.0.0");
  });

  test("honors a specific interface IP and trims surrounding whitespace", () => {
    expect(resolveBindHostname({ SCRIBE_BIND: "  10.0.0.5 " })).toBe("10.0.0.5");
  });
});
