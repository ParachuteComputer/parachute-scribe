import { getTranscribeProviderConfig } from "../provider-config.ts";

export async function transcribe(audio: File): Promise<string> {
  const cfg = await getTranscribeProviderConfig("openai");
  const apiKey = cfg.apiKey;
  if (!apiKey) throw new Error("openai apiKey not configured (set via /.parachute/config or OPENAI_API_KEY env)");

  const form = new FormData();
  form.set("file", audio);
  form.set("model", cfg.model ?? "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { text: string };
  return json.text;
}
