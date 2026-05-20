import { displayWidth } from "../text";

export const HELP_LEFT: [string, string][] = [
  ["/", "open search"],
  ["Tab", "toggle focus"],
  ["Enter", "add to playlist"],
  ["i", "instant play"],
  ["g", "go play playlist"],
  ["d", "delete from playlist"],
  ["[ / ]", "move playlist item up/down"],
  ["x", "shuffle queue"],
  ["y", "yank to browser"],
  ["c", "clear results / clear playlist"],
  ["P", "playlists: save / load / delete"],
];

export const HELP_RIGHT: [string, string][] = [
  ["Space", "pause"],
  ["p / n", "prev / next track"],
  ["← / →", "seek -10s / +10s"],
  ["s", "stop"],
  ["m", "mode: audio / video"],
  ["r", "repeat toggle"],
  ["f", "fetch more results"],
  ["q / Ctrl-C", "quit"],
];

export const HELP_LEFT_KEY_W =
  Math.max(...HELP_LEFT.map(([k]) => displayWidth(k))) + 2;
export const HELP_RIGHT_KEY_W =
  Math.max(...HELP_RIGHT.map(([k]) => displayWidth(k))) + 2;
