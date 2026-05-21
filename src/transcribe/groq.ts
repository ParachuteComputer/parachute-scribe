import { getTranscribeProviderConfig } from "../provider-config.ts";

export async function transcribe(audio: File): Promise<string> {
  const cfg = await getTranscribeProviderConfig("groq");
  const apiKey = cfg.apiKey;
  if (!apiKey) throw new Error("groq apiKey not configured (set via /.parachute/config or GROQ_API_KEY env)");

  const form = new FormData();
  form.set("file", audio);
  form.set("model", cfg.model ?? "whisper-large-v3");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { text: string };
  return json.text;
}
