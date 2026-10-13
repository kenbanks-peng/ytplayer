import type { PlayMode } from "./protocol";

export function mpvModeArgs(mode: PlayMode): string[] {
  if (mode === "audio") return ["--ytdl-format=bestaudio", "--no-video"];
  return [
    "--ytdl-format=bestvideo*+bestaudio/best",
    "--force-window=immediate",
    ...(mode === "wallpaper" ? ["--wallpaper-mode"] : []),
  ];
}
