import { describe, expect, test } from "bun:test";
import { preflight, withCors } from "./cors.ts";

describe("cors", () => {
  test("preflight returns 204 with CORS headers", () => {
    const res = preflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  test("withCors adds CORS headers to a JSON response", () => {
    const res = withCors(Response.json({ text: "hello" }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("withCors preserves non-200 status codes and bodies", async () => {
    const res = withCors(new Response("not found", { status: 404 }));
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.text()).toBe("not found");
  });
});
