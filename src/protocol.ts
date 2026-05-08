export type Track = {
	id: string;
	title: string;
	url: string;
	uploader?: string;
	duration?: number;
	views?: number;
	page: number;
};

export type PlayMode = "audio" | "video";

export type ServerState = {
	queue: Track[];
	index: number;
	paused: boolean;
	repeat: boolean;
	mode: PlayMode;
};

export const SERVER_SOCK = "/tmp/ytplayer.sock";

// Bump this whenever the wire protocol changes incompatibly. ensureServer()
// compares it against the running server's reply to detect stale daemons.
export const PROTOCOL_VERSION = "6";
