import { statSync } from "node:fs";

export type Track = {
  id: string;
  title: string;
  url: string;
  uploader?: string;
  duration?: number;
  views?: number;
  page: number;
};

export type PlayMode = "audio" | "video" | "wallpaper";

export function isPlayMode(value: unknown): value is PlayMode {
  return value === "audio" || value === "video" || value === "wallpaper";
}

export function nextPlayMode(mode: PlayMode): PlayMode {
  return mode === "audio" ? "video" : mode === "video" ? "wallpaper" : "audio";
}

export type ServerState = {
  queue: Track[];
  index: number;
  paused: boolean;
  playing: boolean;
  repeat: boolean;
  mode: PlayMode;
  preview: Track | null;
  position: number;
  duration: number;
};

// Bump this whenever the wire protocol changes incompatibly. ensureServer()
// compares it against the running server's reply to detect stale daemons.
export const PROTOCOL_VERSION = "16";

// Combines the wire protocol version with the executable's mtime so a fresh
// build supersedes a running daemon even when the protocol is unchanged.
export function binaryVersion(): string {
  let mtime = "0";
  try {
    mtime = String(statSync(process.execPath).mtimeMs);
  } catch {}
  return `${PROTOCOL_VERSION}:${mtime}`;
}
