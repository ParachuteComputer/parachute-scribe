/**
 * Tests for the ffmpeg-missing signature detector + the typed backend error.
 * The detector has to be tolerant — ffmpeg's "not found" phrasing varies
 * across shells, tool versions, and OSes — without false-positiving on
 * ordinary output that merely mentions ffmpeg.
 */
import { describe, expect, test } from "bun:test";
import {
  FFMPEG_MISSING_MESSAGE,
  TranscribeBackendError,
  looksLikeFfmpegMissing,
} from "./backend-error.ts";

describe("looksLikeFfmpegMissing", () => {
  test("matches `ffmpeg: command not found`", () => {
    expect(looksLikeFfmpegMissing("/bin/sh: ffmpeg: command not found")).toBe(true);
  });

  test("matches a Python traceback: No such file or directory: 'ffmpeg'", () => {
    const out = [
      "Traceback (most recent call last):",
      "  ...",
      "FileNotFoundError: [Errno 2] No such file or directory: 'ffmpeg'",
    ].join("\n");
    expect(looksLikeFfmpegMissing(out)).toBe(true);
  });

  test("matches `ffmpeg is not installed`", () => {
    expect(looksLikeFfmpegMissing("error: ffmpeg is not installed on this system")).toBe(true);
  });

  test("matches across non-adjacent lines (ffmpeg named on one line, not-found on another)", () => {
    const out = "Running ffmpeg to decode audio...\n... later ...\nerror: command not found";
    expect(looksLikeFfmpegMissing(out)).toBe(true);
  });

  test("case-insensitive on the ffmpeg token", () => {
    expect(looksLikeFfmpegMissing("FFMPEG not found")).toBe(true);
  });

  test("does NOT match ordinary ffmpeg output with no not-found signature", () => {
    expect(looksLikeFfmpegMissing("ffmpeg version 6.0 Copyright (c) 2000-2023")).toBe(false);
  });

  test("does NOT match a not-found message that has nothing to do with ffmpeg", () => {
    expect(looksLikeFfmpegMissing("model checkpoint not found")).toBe(false);
  });

  test("empty / whitespace output → false", () => {
    expect(looksLikeFfmpegMissing("")).toBe(false);
  });
});

describe("TranscribeBackendError", () => {
  test("carries the stable code + is an Error", () => {
    const err = new TranscribeBackendError("ffmpeg_unavailable", FFMPEG_MISSING_MESSAGE);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TranscribeBackendError);
    expect(err.code).toBe("ffmpeg_unavailable");
    expect(err.message).toContain("ffmpeg");
    expect(err.name).toBe("TranscribeBackendError");
  });
});
