/**
 * OpenAI-compatible cleanup providers (OpenAI, Gemini, Groq, custom).
 *
 * Each export reads its apiKey + model + url at call time via
 * `getCleanupProviderConfig(<name>)`, so config.json edits via the SPA take
 * effect on the next request without a restart.
 */

import { buildCleanupPrompt, type CleanupPromptOpts } from "./prompt.ts";
import { getCleanupProviderConfig } from "../provider-config.ts";

type ProviderShape = {
  /** Provider name as keyed in `cleaners` registry + `cleanupProviders` config block. */
  name: string;
  /** Base URL fallback — when neither config.json `url` nor the implicit per-provider default is set. */
  fallbackBaseUrl: string;
};

function makeCleanup(shape: ProviderShape) {
  return async function cleanup(
    text: string,
    properNouns?: string,
    opts?: CleanupPromptOpts,
  ): Promise<string> {
    const cfg = await getCleanupProviderConfig(shape.name);
    const apiKey = cfg.apiKey;
    if (!apiKey) {
      throw new Error(
        `${shape.name} apiKey not configured (set via /.parachute/config or the provider's API_KEY env)`,
      );
    }

    const baseUrl = cfg.url ?? shape.fallbackBaseUrl;
    const model = cfg.model ?? "default";

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildCleanupPrompt(properNouns, opts) },
          { role: "user", content: text },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Cleanup API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return json.choices[0]!.message.content;
  };
}

export const openai = makeCleanup({ name: "openai", fallbackBaseUrl: "https://api.openai.com/v1" });
export const gemini = makeCleanup({ name: "gemini", fallbackBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });
export const groqCleanup = makeCleanup({ name: "groq", fallbackBaseUrl: "https://api.groq.com/openai/v1" });
export const custom = makeCleanup({ name: "custom", fallbackBaseUrl: "http://localhost:8080/v1" });
