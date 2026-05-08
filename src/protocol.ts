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
	now: Track | null;
	paused: boolean;
	repeat: boolean;
};

export const SERVER_SOCK = "/tmp/ytplayer.sock";
