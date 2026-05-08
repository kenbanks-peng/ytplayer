import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import {
	type PlayMode,
	PROTOCOL_VERSION,
	SERVER_SOCK,
	type Track,
} from "./protocol";

const MPV_SOCK = "/tmp/ytplayer-mpv.sock";

export function binaryVersion(): string {
	let mtime = "0";
	try {
		mtime = String(statSync(process.execPath).mtimeMs);
	} catch {}
	return `${PROTOCOL_VERSION}:${mtime}`;
}
const CACHE_DIR = join(homedir(), ".cache", "ytplayer");
const STATE_FILE = join(CACHE_DIR, "state.json");

type PersistedState = {
	queue: Track[];
	index: number;
	repeat: boolean;
	mode: PlayMode;
};

function saveStateFile(s: PersistedState) {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		if (s.queue.length === 0 && !s.repeat) {
			if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
		} else {
			writeFileSync(STATE_FILE, JSON.stringify(s));
		}
	} catch {}
}

function loadStateFile(): PersistedState | null {
	try {
		if (!existsSync(STATE_FILE)) return null;
		return JSON.parse(readFileSync(STATE_FILE, "utf8")) as PersistedState;
	} catch {
		return null;
	}
}

type MpvCommandValue = string | number | boolean;

function sendMpv(cmd: MpvCommandValue[]): Promise<unknown> {
	return new Promise((resolve) => {
		if (!existsSync(MPV_SOCK)) return resolve(null);
		const sock = connect(MPV_SOCK);
		let buf = "";
		sock.on("data", (d) => {
			buf += d.toString();
			sock.end();
		});
		sock.on("end", () => {
			try {
				resolve(JSON.parse(buf.split("\n")[0] || "null"));
			} catch {
				resolve(null);
			}
		});
		sock.on("error", () => resolve(null));
		sock.write(`${JSON.stringify({ command: cmd })}\n`);
	});
}

type Request =
	| { cmd: "ping" }
	| { cmd: "state" }
	| { cmd: "queue:add"; track: Track; mode?: PlayMode }
	| { cmd: "queue:remove"; id: string }
	| { cmd: "queue:jump"; index: number }
	| { cmd: "queue:clear" }
	| { cmd: "next" }
	| { cmd: "prev" }
	| { cmd: "stop" }
	| { cmd: "pause" }
	| { cmd: "repeat"; on: boolean }
	| { cmd: "mode"; mode: PlayMode }
	| { cmd: "shutdown" };

export async function runServer(): Promise<void> {
	let mpv: Subprocess | null = null;
	let queue: Track[] = [];
	let index = -1;
	let paused = false;
	let repeat = false;
	let mode: PlayMode = "audio";

	const persist = () => saveStateFile({ queue, index, repeat, mode });

	// Adopt an existing mpv if its socket is still alive.
	const cached = loadStateFile();
	if (cached) {
		queue = cached.queue ?? [];
		index = cached.index ?? -1;
		repeat = Boolean(cached.repeat);
		mode = cached.mode ?? "audio";
		if (queue.length > 0 && index >= 0 && existsSync(MPV_SOCK)) {
			const resp = (await sendMpv(["get_property", "pause"])) as {
				error?: string;
				data?: boolean;
			} | null;
			if (resp && resp.error === "success") {
				paused = Boolean(resp.data);
			} else {
				index = -1;
				try {
					unlinkSync(MPV_SOCK);
				} catch {}
				persist();
			}
		} else {
			// No live mpv. Keep queue, but nothing is playing right now.
			index = -1;
			persist();
		}
	}

	const stopPlayback = async () => {
		if (mpv) {
			try {
				mpv.kill();
			} catch {}
			mpv = null;
		} else if (existsSync(MPV_SOCK)) {
			await sendMpv(["quit"]);
		}
		if (existsSync(MPV_SOCK)) {
			try {
				unlinkSync(MPV_SOCK);
			} catch {}
		}
		paused = false;
	};

	const playIndex = async (i: number): Promise<void> => {
		await stopPlayback();
		if (i < 0 || i >= queue.length) {
			index = -1;
			persist();
			return;
		}
		index = i;
		paused = false;
		const track = queue[i];
		if (!track) {
			index = -1;
			persist();
			return;
		}
		persist();
		const args = [
			"mpv",
			"--no-terminal",
			`--input-ipc-server=${MPV_SOCK}`,
			mode === "audio"
				? "--ytdl-format=bestaudio"
				: "--ytdl-format=bestvideo*+bestaudio/best",
			mode === "audio" ? "--no-video" : "--force-window=yes",
			track.url,
		];
		const proc = spawn(args, { stdout: "ignore", stderr: "ignore" });
		mpv = proc;
		proc.exited.then(() => {
			if (mpv !== proc) return; // superseded by jump/next/prev/remove/stop
			mpv = null;
			// Natural end of current track: advance.
			const nextI = index + 1;
			if (nextI < queue.length) {
				playIndex(nextI);
				return;
			}
			if (repeat && queue.length > 0) {
				playIndex(0);
				return;
			}
			index = -1;
			paused = false;
			persist();
		});
	};

	const handle = async (req: Request): Promise<unknown> => {
		switch (req.cmd) {
			case "ping":
				return { ok: true, version: binaryVersion() };
			case "state":
				return { queue, index, paused, repeat, mode };
			case "queue:add": {
				if (!req.track) return { ok: false, error: "missing track" };
				if (req.mode) mode = req.mode;
				queue.push(req.track);
				if (index < 0 || !mpv) {
					await playIndex(queue.length - 1);
				} else {
					persist();
				}
				return { ok: true };
			}
			case "queue:remove": {
				const i = queue.findIndex((t) => t.id === req.id);
				if (i < 0) return { ok: true };
				const wasCurrent = i === index;
				queue.splice(i, 1);
				if (wasCurrent) {
					// The next track shifted into position i. Play it; if past end, wrap or stop.
					if (i < queue.length) {
						await playIndex(i);
					} else if (repeat && queue.length > 0) {
						await playIndex(0);
					} else {
						await stopPlayback();
						index = -1;
						persist();
					}
				} else if (i < index) {
					index -= 1;
					persist();
				} else {
					persist();
				}
				return { ok: true };
			}
			case "queue:jump": {
				await playIndex(req.index);
				return { ok: true };
			}
			case "queue:clear": {
				await stopPlayback();
				queue = [];
				index = -1;
				persist();
				return { ok: true };
			}
			case "next": {
				if (queue.length === 0) return { ok: true };
				const cur = index < 0 ? -1 : index;
				let target = cur + 1;
				if (target >= queue.length) {
					if (!repeat) {
						await stopPlayback();
						index = -1;
						persist();
						return { ok: true };
					}
					target = 0;
				}
				await playIndex(target);
				return { ok: true };
			}
			case "prev": {
				if (queue.length === 0) return { ok: true };
				const cur = index < 0 ? queue.length : index;
				let target = cur - 1;
				if (target < 0) {
					if (!repeat) {
						await playIndex(0);
						return { ok: true };
					}
					target = queue.length - 1;
				}
				await playIndex(target);
				return { ok: true };
			}
			case "stop":
				await stopPlayback();
				index = -1;
				persist();
				return { ok: true };
			case "pause":
				if (index < 0 || !mpv) return { ok: true, paused: false };
				await sendMpv(["cycle", "pause"]);
				paused = !paused;
				return { ok: true, paused };
			case "repeat":
				repeat = Boolean(req.on);
				persist();
				return { ok: true, repeat };
			case "mode":
				if (req.mode === "audio" || req.mode === "video") {
					mode = req.mode;
					persist();
				}
				return { ok: true, mode };
			case "shutdown": {
				await stopPlayback();
				setTimeout(() => process.exit(0), 10);
				return { ok: true };
			}
			default:
				return { ok: false, error: "unknown cmd" };
		}
	};

	if (existsSync(SERVER_SOCK)) {
		try {
			unlinkSync(SERVER_SOCK);
		} catch {}
	}

	const server = createServer((sock) => {
		let buf = "";
		sock.on("data", async (d) => {
			buf += d.toString();
			while (true) {
				const idx = buf.indexOf("\n");
				if (idx < 0) break;
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				if (!line.trim()) continue;
				let req: Request;
				try {
					req = JSON.parse(line) as Request;
				} catch {
					continue;
				}
				const reply = await handle(req);
				sock.write(`${JSON.stringify(reply)}\n`);
			}
		});
		sock.on("error", () => {});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(SERVER_SOCK, () => {
			server.off("error", reject);
			resolve();
		});
	});

	// Survive terminal hangup so we outlive the TUI.
	process.on("SIGHUP", () => {});
	const shutdown = async () => {
		await stopPlayback();
		try {
			server.close();
		} catch {}
		if (existsSync(SERVER_SOCK)) {
			try {
				unlinkSync(SERVER_SOCK);
			} catch {}
		}
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Hold the event loop open forever; net server keeps it alive but be explicit.
	await new Promise<never>(() => {});
}
