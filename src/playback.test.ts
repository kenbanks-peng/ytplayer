import { expect, test } from "bun:test";
import { mpvModeArgs } from "./playback";
import { isPlayMode, nextPlayMode } from "./protocol";

test("cycles audio, video, wallpaper, then audio", () => {
  expect(nextPlayMode("audio")).toBe("video");
  expect(nextPlayMode("video")).toBe("wallpaper");
  expect(nextPlayMode("wallpaper")).toBe("audio");
});

test("validates all supported modes and rejects invalid persisted or RPC values", () => {
  for (const mode of ["audio", "video", "wallpaper"]) {
    expect(isPlayMode(mode)).toBe(true);
  }
  for (const mode of [undefined, null, "", "invalid", 1]) {
    expect(isPlayMode(mode)).toBe(false);
  }
});

test("audio disables video and requests audio-only media", () => {
  expect(mpvModeArgs("audio")).toEqual(["--ytdl-format=bestaudio", "--no-video"]);
});

test("video requests video and audio without wallpaper mode", () => {
  expect(mpvModeArgs("video")).toEqual([
    "--ytdl-format=bestvideo*+bestaudio/best",
    "--force-window=immediate",
  ]);
});

test("wallpaper adds the mpv wallpaper flag to video playback", () => {
  expect(mpvModeArgs("wallpaper")).toEqual([
    ...mpvModeArgs("video"),
    "--wallpaper-mode",
  ]);
});
