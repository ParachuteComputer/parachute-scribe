import { describe, expect, test } from "bun:test";
import { cleaners, transcribers } from "./providers.ts";
import {
  SCOPES,
  buildConfigSchema,
  handleConfig,
  handleConfigSchema,
  type ResolvedConfig,
} from "./config-schema.ts";

const SAMPLE: ResolvedConfig = {
  transcribeProvider: "parakeet-mlx",
  cleanupProvider: "ollama",
  cleanupDefault: true,
  port: 1943,
  vault: {
    configured: true,
    url: "http://localhost:1940",
    cacheTtlSeconds: 300,
  },
};

describe("config-schema", () => {
  test("buildConfigSchema is a valid draft-07 JSON Schema shape", () => {
    const schema = buildConfigSchema();
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.type).toBe("object");
    expect(schema.title).toBeString();
    expect(schema.properties).toBeDefined();
    expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
  });

  test("schema exposes transcribeProvider + cleanupProvider enums sourced from runtime providers", () => {
    const schema = buildConfigSchema();
    const transcribe = schema.properties.transcribeProvider;
    const cleanup = schema.properties.cleanupProvider;
    expect(transcribe.enum).toEqual(Object.keys(transcribers).sort());
    expect(cleanup.enum).toEqual(Object.keys(cleaners).sort());
    expect(cleanup.enum).toContain("none");
  });

  test("schema exposes port, cleanupDefault, and vault object", () => {
    const schema = buildConfigSchema();
    expect(schema.properties.port.type).toBe("integer");
    expect(schema.properties.cleanupDefault.type).toBe("boolean");
    expect(schema.properties.vault.type).toBe("object");
    expect(schema.properties.vault.properties.url).toBeDefined();
    expect(schema.properties.vault.properties.cacheTtlSeconds).toBeDefined();
  });

  test("schema declares scribe:transcribe and scribe:admin scopes via x-scopes", () => {
    const schema = buildConfigSchema();
    expect(schema["x-scopes"]).toBeDefined();
    expect(schema["x-scopes"]).toHaveProperty("scribe:transcribe");
    expect(schema["x-scopes"]).toHaveProperty("scribe:admin");
    expect(SCOPES["scribe:transcribe"]).toBeString();
    expect(SCOPES["scribe:admin"]).toBeString();
  });

  test("handleConfigSchema returns the schema as JSON", async () => {
    const res = handleConfigSchema();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual(buildConfigSchema());
  });

  test("handleConfig returns the resolved runtime values", async () => {
    const res = handleConfig(SAMPLE);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual(SAMPLE);
  });

  test("handleConfig reflects an unconfigured vault with nulls", async () => {
    const res = handleConfig({
      ...SAMPLE,
      vault: { configured: false, url: null, cacheTtlSeconds: null },
    });
    const body = (await res.json()) as ResolvedConfig;
    expect(body.vault.configured).toBe(false);
    expect(body.vault.url).toBeNull();
    expect(body.vault.cacheTtlSeconds).toBeNull();
  });
});
