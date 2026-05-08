# ytplayer

Terminal YouTube player. Search, queue, and play audio or video via `mpv`.

## Features

- **Search** YouTube via `yt-dlp`, sorted by view count, with paginated load-more.
- **Server-managed playback**: a background daemon owns `mpv` and the playlist, so playback survives TUI exits, crashes, and `SIGHUP`. Reattach by relaunching — the queue, current index, mode, and repeat flag are restored from disk.
- **Playlist**: append from search results, jump to any track, remove items, skip forward/back. Pressing play on a single video is just a playlist of one.
- **Repeat the playlist** (not the current track): when the last item ends with repeat on, playback wraps to the start.
- **Audio or video mode** toggled at any time; mode applies to the next track played.
- **Persistent caches** under `~/.cache/ytplayer/`: last search results, queue, index, repeat, and mode.

## Requirements

- [Bun](https://bun.sh)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
- [`mpv`](https://mpv.io)

## Install

```bash
bun install
```

## Run

```bash
bun dev
```

Or build a standalone binary:

```bash
bun run build
./bin/ytplayer
```

## Layout

Three panes: search input on top, search results on the left, playlist on the right, status bar at the bottom. `Tab` cycles focus across `search → results → playlist`.

## Keys

- `Tab` — cycle focus (search → results → playlist)
- `Enter` (results) — append the selected track to the playlist; auto-play if the queue was empty
- `Enter` (playlist) — jump to and play that item
- `d` (playlist) — remove the highlighted item
- `>` / `<` — next / previous track in the playlist
- `Space` — pause/resume
- `s` — stop (clears current playback; queue is preserved)
- `r` — toggle repeat (wraps the whole playlist)
- `m` — toggle audio/video mode
- `n` / `PageDown` — load more search results
- `c` (results) — clear search results and cache
- `q` / `Ctrl-C` — quit the TUI (server keeps running)

## Architecture

- **Server** (`src/server.ts`) — long-lived daemon listening on a Unix socket at `/tmp/ytplayer.sock`. Owns the `mpv` subprocess and the queue. Persists state to `~/.cache/ytplayer/state.json`.
- **Client** (`src/client.ts`) — thin RPC wrapper used by the TUI; auto-spawns the server if missing or stale (protocol-versioned ping).
- **TUI** (`src/index.tsx`) — React + OpenTUI; polls server state every second and dispatches commands.
- **Protocol** (`src/protocol.ts`) — shared types and the wire `PROTOCOL_VERSION`. Bump when the wire format changes; the client will then shut down and replace stale daemons automatically.
