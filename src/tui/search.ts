import { type Subprocess, spawn } from "bun";
import type { Track } from "../protocol";

const PAGE_MARKERS = ["●", "○", "◆", "◇", "▲", "△", "■", "□"];

export const pageMarker = (page: number): string =>
  PAGE_MARKERS[(page - 1) % PAGE_MARKERS.length] ?? "·";

export function sortByViewsDesc(tracks: Track[]): Track[] {
  return [...tracks].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
}

export async function searchYouTube(
  query: string,
  count: number,
  page: number,
  signal: AbortSignal,
): Promise<Track[]> {
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = spawn({
      cmd: [
        "yt-dlp",
        `ytsearch${count}:${query}`,
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
      ],
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
  } catch (e) {
    throw new Error(
      `failed to launch yt-dlp (is it installed?): ${(e as Error).message}`,
    );
  }
  const [text, errText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !signal.aborted) {
    const msg = errText.trim().split("\n").pop() ?? `exit ${exitCode}`;
    throw new Error(`yt-dlp: ${msg}`);
  }
  const tracks: Track[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const title: string = j.title ?? "(untitled)";
      const uploader: string | undefined = j.uploader || j.channel;
      tracks.push({
        id: j.id,
        title: title.normalize("NFKC"),
        url: j.url ?? `https://www.youtube.com/watch?v=${j.id}`,
        uploader: uploader?.normalize("NFKC"),
        duration: j.duration,
        views: typeof j.view_count === "number" ? j.view_count : undefined,
        page,
      });
    } catch {
      // yt-dlp can emit occasional non-JSON progress/status lines; ignore them.
    }
  }
  return tracks;
}
