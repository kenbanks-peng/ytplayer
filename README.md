# ytplayer

Terminal YouTube player. Search, then play audio or video via `mpv`.

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

## Keys

- `Tab` — switch focus between search and results
- `Enter` — play selected track
- `Space` — pause/resume
- `s` — stop
- `m` — toggle audio/video mode
- `n` — load more results
- `q` — quit
