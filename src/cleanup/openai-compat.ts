import { buildCleanupPrompt } from "./prompt.ts";

type ProviderConfig = {
  baseUrl: string;
  apiKey: string | undefined;
  defaultModel: string;
};

function makeCleanup(config: ProviderConfig) {
  return async function cleanup(text: string, properNouns?: string): Promise<string> {
    const apiKey = config.apiKey;
    if (!apiKey) throw new Error(`API key not set for cleanup provider`);

    const model = process.env.CLEANUP_MODEL ?? config.defaultModel;

    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildCleanupPrompt(properNouns) },
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

export const openai = makeCleanup({
  baseUrl: "https://api.openai.com/v1",
  get apiKey() { return process.env.OPENAI_API_KEY; },
  defaultModel: "gpt-4o-mini",
});

export const gemini = makeCleanup({
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  get apiKey() { return process.env.GEMINI_API_KEY; },
  defaultModel: "gemini-2.0-flash",
});

export const groqCleanup = makeCleanup({
  baseUrl: "https://api.groq.com/openai/v1",
  get apiKey() { return process.env.GROQ_API_KEY; },
  defaultModel: "llama-3.1-8b-instant",
});

export const custom = makeCleanup({
  baseUrl: process.env.CLEANUP_URL ?? "http://localhost:8080/v1",
  get apiKey() { return process.env.CLEANUP_API_KEY; },
  defaultModel: process.env.CLEANUP_MODEL ?? "default",
});
