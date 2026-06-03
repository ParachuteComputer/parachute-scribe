/**
 * Typed transcription-backend errors — make a class of silent failures
 * legible to the HTTP layer + downstream callers (vault's transcription
 * worker).
 *
 * The motivating bug: parakeet-mlx (and whisper-ctranslate2) shell out to
 * `ffmpeg` internally to decode non-WAV audio. When ffmpeg is missing the
 * tool prints an error but **exits 0** and writes no `.txt` — so the
 * provider's `exitCode !== 0` gate never fires, and the only signal left was
 * the opaque `No .txt output found in <tmpDir>` throw, surfaced to the caller
 * as a generic 500. The operator had no way to know the real cause was a
 * missing system dependency they could `brew install`.
 *
 * `TranscribeBackendError` carries a stable `code` so `runTranscribePipeline`
 * can branch to a structured 503 `backend_unavailable` response (mirroring
 * the `missing_provider` 400 path) with an actionable fix message, instead of
 * the opaque generic-500.
 */

/** Stable, branch-able failure codes for transcription backends. */
export type TranscribeBackendErrorCode = "ffmpeg_unavailable";

export class TranscribeBackendError extends Error {
  readonly code: TranscribeBackendErrorCode;
  constructor(code: TranscribeBackendErrorCode, message: string) {
    super(message);
    this.name = "TranscribeBackendError";
    this.code = code;
  }
}

/**
 * Detect an ffmpeg-missing signature in a transcription tool's combined
 * stdout+stderr.
 *
 * Tolerant by design — the exact wording varies across ffmpeg shells,
 * parakeet-mlx / whisper-ctranslate2 versions, and OSes. We require the
 * co-occurrence of an `ffmpeg` mention with a "not installed / not found"
 * phrasing anywhere in the output (e.g. `ffmpeg: command not found`,
 * `[Errno 2] No such file or directory: 'ffmpeg'`, `ffmpeg is not installed`).
 * The two halves don't have to be adjacent — a multi-line traceback that
 * names ffmpeg in one line and "No such file" in another still matches.
 */
const FFMPEG_TOKEN = /ffmpeg/i;
const NOT_PRESENT = /not (?:installed|found)|no such file/i;

export function looksLikeFfmpegMissing(combinedOutput: string): boolean {
  if (!combinedOutput) return false;
  return FFMPEG_TOKEN.test(combinedOutput) && NOT_PRESENT.test(combinedOutput);
}

/** Shared, actionable message for the ffmpeg-missing case. */
export const FFMPEG_MISSING_MESSAGE =
  "The transcription backend needs `ffmpeg` to decode this audio, but ffmpeg isn't installed or isn't on scribe's PATH. Install it (e.g. `brew install ffmpeg` on macOS, `apt install ffmpeg` on Debian/Ubuntu) and restart scribe.";
