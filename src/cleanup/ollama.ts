import { CLEANUP_PROMPT } from "./prompt.ts";

export async function cleanup(text: string): Promise<string> {
  const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.1";

  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: CLEANUP_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { message: { content: string } };
  return json.message.content;
}
