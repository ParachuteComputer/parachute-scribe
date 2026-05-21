/**
 * Streamable HTTP MCP transport for scribe.
 *
 * Stateless mode (no session ID generator) — every request creates a
 * fresh transport+server pair. Same pattern vault uses (see
 * `parachute-vault/src/mcp-http.ts`). Server restarts never invalidate
 * client sessions, and `tools/list` / `tools/call` can be sent without
 * an initialize handshake.
 *
 * The transport is mounted at `/scribe/mcp`. Per-tool scope enforcement
 * lives here so a `scribe:transcribe`-only caller can list + call both
 * tools (today they're both `scribe:transcribe` — admin tools would
 * appear here when added).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SCOPE_TRANSCRIBE, hasScope } from "../auth.ts";
import { McpToolError, SCRIBE_MCP_TOOLS } from "./tools.ts";
import type { ServerDeps } from "../server.ts";
import pkg from "../../package.json" with { type: "json" };

/**
 * Required scope per tool. Both current tools wrap the transcription
 * pipeline → `scribe:transcribe`. Default to admin so an accidentally
 * unregistered new tool can't be reached without explicit registration.
 */
const TOOL_REQUIRED_SCOPE: Record<string, string> = {
  transcribe: SCOPE_TRANSCRIBE,
  "transcribe-url": SCOPE_TRANSCRIBE,
};

function requiredScopeForTool(name: string): string {
  return TOOL_REQUIRED_SCOPE[name] ?? "scribe:admin";
}

export async function handleScribeMcp(
  req: Request,
  callerScopes: readonly string[],
  deps: ServerDeps,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = new Server(
    { name: "parachute-scribe", version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions:
        "Scribe — audio transcription. Use `transcribe` for audio bytes you already have, " +
        "`transcribe-url` for a direct audio URL. YouTube / video-site URLs are NOT supported " +
        "(extract audio with yt-dlp first). Optional `cleanup` arg runs an LLM cleanup pass " +
        "over the raw transcript; pass a `context` block of proper nouns to improve cleanup quality.",
    },
  );

  // Tool visibility mirrors scope: hide tools the caller can't invoke,
  // so `tools/list` for a `scribe:transcribe`-only caller doesn't
  // advertise admin tools (when those eventually land).
  const visibleTools = SCRIBE_MCP_TOOLS.filter((t) =>
    hasScope(callerScopes, requiredScopeForTool(t.name)),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const required = requiredScopeForTool(name);
    if (!hasScope(callerScopes, required)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Forbidden: tool '${name}' requires the '${required}' scope. Granted scopes: ${callerScopes.join(" ") || "(none)"}.`,
          },
        ],
        isError: true,
      };
    }
    const tool = SCRIBE_MCP_TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.execute((args ?? {}) as Record<string, unknown>, deps);
      // Return both a human-readable text part AND a structured result
      // block — MCP clients that understand JSON inputs can pick up
      // `source.url` etc. without re-parsing the text payload.
      return {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: result.source ? { source: result.source } : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "tool execution failed";
      const code = err instanceof McpToolError ? err.code : "internal_error";
      return {
        content: [{ type: "text" as const, text: `Error (${code}): ${message}` }],
        isError: true,
      };
    }
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}
