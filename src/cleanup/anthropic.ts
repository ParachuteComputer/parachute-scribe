/**
 * Anthropic API cleanup provider (renamed from `claude` in 0.4.4-rc.1).
 *
 * Uses an Anthropic API key — distinct from `claude-code`, which shells to
 * the `claude` CLI and uses the subscription-funded setup-token.
 *
 * Reads apiKey + model at call time via `getCleanupProviderConfig("anthropic")`,
 * so a PUT-driven config write takes effect on the next request without a
 * scribe restart.
 */

import { buildCleanupPrompt, type CleanupPromptOpts } from "./prompt.ts";
import { getCleanupProviderConfig } from "../provider-config.ts";

export async function cleanup(
  text: string,
  properNouns?: string,
  opts?: CleanupPromptOpts,
): Promise<string> {
  const cfg = await getCleanupProviderConfig("anthropic");
  const apiKey = cfg.apiKey;
  if (!apiKey) throw new Error("anthropic apiKey not configured (set via /.parachute/config or ANTHROPIC_API_KEY env)");

  const model = cfg.model ?? "claude-3-5-haiku-20241022";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: buildCleanupPrompt(properNouns, opts),
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { content: Array<{ text: string }> };
  return json.content[0]!.text;
}
