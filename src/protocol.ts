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
