import pkg from "../package.json" with { type: "json" };

export const SERVICE_NAME = "parachute-scribe";
export const DISPLAY_NAME = "Scribe";
export const TAGLINE = "Audio transcription (Whisper-compatible API + LLM cleanup)";
export const MOUNT_PATH = "/scribe";
export const DEFAULT_PORT = 1943;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#6A9B77"/><text x="32" y="43" text-anchor="middle" font-family="system-ui,sans-serif" font-size="32" font-weight="600" fill="#FAFAF7">S</text></svg>`;

export function handleParachuteInfo(): Response {
  return Response.json({
    name: SERVICE_NAME,
    displayName: DISPLAY_NAME,
    tagline: TAGLINE,
    kind: "api",
    version: pkg.version,
    iconUrl: `${MOUNT_PATH}/.parachute/icon.svg`,
  });
}

export function handleParachuteIcon(): Response {
  return new Response(ICON_SVG, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
