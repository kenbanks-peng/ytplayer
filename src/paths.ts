import { homedir } from "node:os";
import { join } from "node:path";

const TMP_DIR = "/tmp";

export const SERVER_SOCK = `${TMP_DIR}/ytplayer.sock`;
export const MPV_SOCK = `${TMP_DIR}/ytplayer-mpv.sock`;
export const SERVER_LOG = `${TMP_DIR}/ytplayer-server.log`;

export const CACHE_DIR = join(homedir(), ".cache", "ytplayer");
export const STATE_FILE = join(CACHE_DIR, "state.json");
export const SEARCH_FILE = join(CACHE_DIR, "search.json");
export const ACTIVE_FILE = join(CACHE_DIR, "active.json");
export const PLAYLIST_DIR = join(CACHE_DIR, "playlists");
export const MPV_LOG = join(CACHE_DIR, "mpv.log");

export const RPC_TIMEOUT_MS = 2000;
export const PING_TIMEOUT_MS = 500;
