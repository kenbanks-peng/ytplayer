import {
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { connect, createServer, type Socket } from "node:net";
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

type Request =
	| { cmd: "ping" }
	| { cmd: "state" }
	| { cmd: "queue:add"; track: Track; mode?: PlayMode }
	| { cmd: "queue:play"; track: Track }
	| { cmd: "play:preview"; track: Track }
	| { cmd: "queue:remove"; id: string }
	| { cmd: "queue:jump"; index: number }
	| { cmd: "queue:move"; from: number; to: number }
	| { cmd: "queue:shuffle" }
	| { cmd: "queue:clear" }
	| { cmd: "next" }
	| { cmd: "prev" }
	| { cmd: "stop" }
	| { cmd: "pause" }
	| { cmd: "repeat"; on: boolean }
	| { cmd: "mode"; mode: PlayMode }
	| { cmd: "seek"; seconds: number; absolute?: boolean }
	| { cmd: "shutdown" };

export async function runServer(): Promise<void> {
	let mpv: Subprocess | null = null;
	let mpvSock: Socket | null = null;
	let mpvReady = false;
	let queue: Track[] = [];
	let index = -1;
	let paused = false;
	let repeat = false;
	let mode: PlayMode = "audio";
	// Track currently playing as a one-off preview (not part of `queue`).
	// While set, mpv's playlist contains only this track.
	let preview: Track | null = null;
	let position = 0;
	let duration = 0;
	// Set to true right before we issue an intentional mpv shutdown (quit/kill).
	// Lets the proc.exited handler distinguish "we asked it to die" from "user
	// closed the window" — only the latter should forget the playback position.
	let intentionalExit = false;

	const persist = () => saveStateFile({ queue, index, repeat, mode });

	type MpvVal = string | number | boolean;
	const pending = new Map<number, (v: unknown) => void>();
	let reqId = 1;

	const mpvCmd = (cmd: MpvVal[]): Promise<unknown> => {
		const sock = mpvSock;
		if (!sock || !mpvReady) return Promise.resolve(null);
		const id = reqId++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (pending.delete(id)) resolve(null);
			}, 2000);
			pending.set(id, (v) => {
				clearTimeout(timer);
				resolve(v);
			});
			try {
				sock.write(`${JSON.stringify({ command: cmd, request_id: id })}\n`);
			} catch {
				if (pending.delete(id)) {
					clearTimeout(timer);
					resolve(null);
				}
			}
		});
	};

	const handleMpvMessage = (msg: {
		event?: string;
		name?: string;
		data?: unknown;
		request_id?: number;
		reason?: string;
	}) => {
		if (msg.request_id != null) {
			const cb = pending.get(msg.request_id);
			if (cb) {
				pending.delete(msg.request_id);
				cb(msg.data ?? null);
			}
			return;
		}
		if (msg.event === "property-change") {
			if (msg.name === "playlist-pos") {
				// While previewing, mpv's playlist holds only the preview track —
				// its playlist-pos is unrelated to the queue's index.
				if (preview) return;
				const v = typeof msg.data === "number" ? msg.data : -1;
				if (v !== index) {
					index = v;
					position = 0;
					duration = 0;
					persist();
				}
			} else if (msg.name === "pause") {
				paused = Boolean(msg.data);
			} else if (msg.name === "time-pos") {
				position = typeof msg.data === "number" ? msg.data : 0;
			} else if (msg.name === "duration") {
				duration = typeof msg.data === "number" ? msg.data : 0;
			}
		}
	};

	const connectMpv = async (): Promise<boolean> => {
		for (let i = 0; i < 80 && !existsSync(MPV_SOCK); i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		if (!existsSync(MPV_SOCK)) return false;
		const s = connect(MPV_SOCK);
		let buf = "";
		const opened = new Promise<boolean>((resolve) => {
			let settled = false;
			const settle = (v: boolean) => {
				if (settled) return;
				settled = true;
				resolve(v);
			};
			s.on("connect", () => settle(true));
			s.on("close", () => {
				if (mpvSock === s) {
					mpvSock = null;
					mpvReady = false;
					for (const cb of pending.values()) cb(null);
					pending.clear();
				}
				settle(false);
			});
			s.on("error", () => settle(false));
		});
		s.on("data", (d) => {
			buf += d.toString();
			while (true) {
				const nl = buf.indexOf("\n");
				if (nl < 0) break;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				try {
					handleMpvMessage(JSON.parse(line));
				} catch {}
			}
		});
		const ok = await opened;
		if (!ok) return false;
		mpvSock = s;
		mpvReady = true;
		await mpvCmd(["observe_property", 1, "playlist-pos"]);
		await mpvCmd(["observe_property", 2, "pause"]);
		await mpvCmd(["observe_property", 3, "time-pos"]);
		await mpvCmd(["observe_property", 4, "duration"]);
		await mpvCmd(["set_property", "loop-playlist", repeat ? "inf" : "no"]);
		return true;
	};

	const spawnMpv = async (): Promise<boolean> => {
		if (mpv && mpvReady) return true;
		// A previous spawn left a half-dead mpv (process up, IPC never connected).
		// Kill it before starting a new one so we don't end up with two mpvs.
		if (mpv && !mpvReady) await killMpv();
		if (existsSync(MPV_SOCK)) {
			try {
				unlinkSync(MPV_SOCK);
			} catch {}
		}
		const args = [
			"mpv",
			"--no-terminal",
			"--idle=once",
			"--keep-open=no",
			"--prefetch-playlist=yes",
			"--gapless-audio=yes",
			`--input-ipc-server=${MPV_SOCK}`,
			mode === "audio"
				? "--ytdl-format=bestaudio"
				: "--ytdl-format=bestvideo*+bestaudio/best",
			mode === "audio" ? "--no-video" : "--force-window=immediate",
		];
		let logFd: number;
		try {
			mkdirSync(CACHE_DIR, { recursive: true });
			logFd = openSync(join(CACHE_DIR, "mpv.log"), "a");
		} catch {
			logFd = 2;
		}
		const proc = spawn(args, { stdout: logFd, stderr: logFd });
		mpv = proc;
		proc.exited.then(() => {
			if (mpv === proc) {
				mpv = null;
				if (mpvSock) {
					try {
						mpvSock.destroy();
					} catch {}
				}
				mpvSock = null;
				mpvReady = false;
				// If the user closed the window (or mpv crashed), keep `index` so
				// the next play action can resume there. Only reset when we asked
				// mpv to quit (stop/clear/mode/shuffle/shutdown).
				if (intentionalExit) index = -1;
				intentionalExit = false;
				// Preview is single-shot: once mpv exits, the preview is over.
				preview = null;
				paused = false;
				position = 0;
				duration = 0;
				persist();
			}
		});
		return await connectMpv();
	};

	const killMpv = async () => {
		intentionalExit = true;
		if (mpvSock) {
			try {
				mpvSock.destroy();
			} catch {}
			mpvSock = null;
		}
		mpvReady = false;
		if (mpv) {
			try {
				mpv.kill();
			} catch {}
			mpv = null;
		}
		// Wait briefly for socket file to disappear.
		for (let i = 0; i < 20 && existsSync(MPV_SOCK); i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		if (existsSync(MPV_SOCK)) {
			try {
				unlinkSync(MPV_SOCK);
			} catch {}
		}
	};

	const loadQueueIntoMpv = async (jumpTo: number) => {
		const first = queue[0];
		if (!first) return;
		// `replace` clears any existing playlist AND starts playback of the new
		// file. This avoids the fragile "stop + set playlist-pos" sequence that
		// can leave mpv stuck on the idle screen after spawning fresh.
		await mpvCmd(["loadfile", first.url, "replace"]);
		for (let i = 1; i < queue.length; i++) {
			const t = queue[i];
			if (t) await mpvCmd(["loadfile", t.url, "append"]);
		}
		// `replace` lands us at index 0; jump if the caller asked for elsewhere.
		if (jumpTo >= 1 && jumpTo < queue.length) {
			await mpvCmd(["set_property", "playlist-pos", jumpTo]);
		}
	};

	// Adoption: if a previous mpv socket is hanging around, drop it. Keep the
	// queue from disk but reset index — playback will resume on next user action.
	const cached = loadStateFile();
	if (cached) {
		queue = Array.isArray(cached.queue) ? cached.queue : [];
		repeat = Boolean(cached.repeat);
		mode = cached.mode === "video" ? "video" : "audio";
	}
	if (existsSync(MPV_SOCK)) {
		// A previous mpv may still be alive bound to this socket. Best-effort:
		// connect and ask it to quit before unlinking, so we don't orphan it.
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				try {
					s.destroy();
				} catch {}
				resolve();
			};
			const timer = setTimeout(finish, 300);
			const s = connect(MPV_SOCK);
			s.on("connect", () => {
				try {
					s.write(`${JSON.stringify({ command: ["quit"] })}\n`);
				} catch {}
				setTimeout(finish, 100);
			});
			s.on("error", finish);
			s.on("close", finish);
		});
		try {
			unlinkSync(MPV_SOCK);
		} catch {}
	}
	index = -1;
	paused = false;
	persist();

	const handle = async (req: Request): Promise<unknown> => {
		switch (req.cmd) {
			case "ping":
				return { ok: true, version: binaryVersion() };
			case "state":
				return {
					queue,
					index,
					paused,
					playing: mpvReady && (index >= 0 || preview !== null),
					repeat,
					mode,
					preview,
					position,
					duration,
				};
			case "queue:add": {
				if (!req.track) return { ok: false, error: "missing track" };
				if (queue.some((t) => t.id === req.track.id)) return { ok: true };
				const modeChanged = req.mode && req.mode !== mode;
				if (req.mode) mode = req.mode;
				queue.push(req.track);
				persist();
				// While previewing, leave mpv alone — the queue is built up in the
				// background and gets loaded into mpv when the user transitions
				// away from the preview (next/prev/jump/play).
				if (preview) return { ok: true };
				if (mpvReady) {
					if (modeChanged) {
						// Mode flag flipped while mpv is running; restart with the
						// new --no-video / --ytdl-format args so the new track
						// actually plays in the requested mode.
						const wasIndex = index;
						await killMpv();
						const ok = await spawnMpv();
						if (!ok) return { ok: false, error: "mpv failed to start" };
						await loadQueueIntoMpv(wasIndex >= 0 ? wasIndex : 0);
					} else {
						await mpvCmd(["loadfile", req.track.url, "append"]);
					}
				}
				return { ok: true };
			}
			case "queue:play": {
				if (!req.track) return { ok: false, error: "missing track" };
				const wasPreview = preview !== null;
				if (wasPreview && mpvReady) await killMpv();
				preview = null;
				let i = queue.findIndex((t) => t.id === req.track.id);
				if (i < 0) {
					queue.push(req.track);
					i = queue.length - 1;
					if (mpvReady) {
						await mpvCmd(["loadfile", req.track.url, "append"]);
					}
				}
				if (!mpvReady) {
					const ok = await spawnMpv();
					if (!ok) return { ok: false, error: "mpv failed to start" };
					await loadQueueIntoMpv(i);
				} else {
					await mpvCmd(["set_property", "playlist-pos", i]);
				}
				index = i;
				paused = false;
				persist();
				return { ok: true };
			}
			case "play:preview": {
				if (!req.track) return { ok: false, error: "missing track" };
				if (mpvReady) await killMpv();
				preview = req.track;
				index = -1;
				paused = false;
				persist();
				const ok = await spawnMpv();
				if (!ok) {
					preview = null;
					return { ok: false, error: "mpv failed to start" };
				}
				await mpvCmd(["loadfile", req.track.url, "replace"]);
				return { ok: true };
			}
			case "queue:remove": {
				const i = queue.findIndex((t) => t.id === req.id);
				if (i < 0) return { ok: true };
				queue.splice(i, 1);
				if (i < index) {
					index--;
				} else if (i === index) {
					// Removing the current track: mpv advances to the next one,
					// which after the splice now occupies the same slot. If we
					// removed the tail, fall back to the new last track (or -1).
					if (index >= queue.length) index = queue.length - 1;
				}
				persist();
				if (mpvReady) {
					await mpvCmd(["playlist-remove", i]);
				}
				return { ok: true };
			}
			case "queue:jump": {
				if (req.index < 0 || req.index >= queue.length) return { ok: true };
				const wasPreview = preview !== null;
				if (wasPreview && mpvReady) await killMpv();
				preview = null;
				if (!mpvReady) {
					const ok = await spawnMpv();
					if (!ok) return { ok: false, error: "mpv failed to start" };
					await loadQueueIntoMpv(req.index);
				} else {
					await mpvCmd(["set_property", "playlist-pos", req.index]);
				}
				index = req.index;
				paused = false;
				persist();
				return { ok: true };
			}
			case "queue:move": {
				const { from, to } = req;
				if (
					from < 0 ||
					from >= queue.length ||
					to < 0 ||
					to >= queue.length ||
					from === to
				)
					return { ok: true };
				const [item] = queue.splice(from, 1);
				if (!item) return { ok: true };
				queue.splice(to, 0, item);
				if (index >= 0) {
					if (index === from) index = to;
					else if (from < index && to >= index) index--;
					else if (from > index && to <= index) index++;
				}
				persist();
				if (mpvReady) {
					const mpvTo = to > from ? to + 1 : to;
					await mpvCmd(["playlist-move", from, mpvTo]);
				}
				return { ok: true };
			}
			case "queue:shuffle": {
				if (queue.length < 2) return { ok: true };
				if (preview && mpvReady) await killMpv();
				preview = null;
				const currentId = index >= 0 ? (queue[index]?.id ?? null) : null;
				for (let i = queue.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					const a = queue[i];
					const b = queue[j];
					if (a && b) {
						queue[i] = b;
						queue[j] = a;
					}
				}
				if (currentId) {
					const newIdx = queue.findIndex((t) => t.id === currentId);
					if (newIdx >= 0) index = newIdx;
				}
				persist();
				if (mpvReady) {
					await killMpv();
					const ok = await spawnMpv();
					if (!ok) return { ok: false, error: "mpv failed to start" };
					await loadQueueIntoMpv(index >= 0 ? index : 0);
				}
				return { ok: true };
			}
			case "queue:clear": {
				queue = [];
				index = -1;
				preview = null;
				persist();
				if (mpvReady) {
					await mpvCmd(["quit"]);
				}
				return { ok: true };
			}
			case "next": {
				if (queue.length === 0) return { ok: true };
				if (preview) {
					if (mpvReady) await killMpv();
					preview = null;
					const ok = await spawnMpv();
					if (!ok) return { ok: false, error: "mpv failed to start" };
					await loadQueueIntoMpv(0);
					index = 0;
					paused = false;
					persist();
					return { ok: true };
				}
				if (!mpvReady) {
					const target = index < 0 ? 0 : Math.min(index + 1, queue.length - 1);
					const ok = await spawnMpv();
					if (!ok) return { ok: false, error: "mpv failed to start" };
					await loadQueueIntoMpv(target);
					return { ok: true };
				}
				// From idle (index < 0), playlist-next is a no-op because mpv's
				// playlist-pos is also -1. Use an absolute jump instead.
				if (index < 0) {
					await mpvCmd(["set_property", "playlist-pos", 0]);
					return { ok: true };
				}
				const target = index + 1;
				if (target >= queue.length) {
					if (!repeat) {
						await mpvCmd(["set_property", "playlist-pos", -1]);
						return { ok: true };
					}
					await mpvCmd(["set_property", "playlist-pos", 0]);
					return { ok: true };
				}
				await mpvCmd(["playlist-next"]);
				return { ok: true };
			}
			case "prev": {
				if (queue.length === 0) return { ok: true };
				if (preview) {
					if (mpvReady) await killMpv();
					preview = null;
					const target = queue.length - 1;
					const ok = await spawnMpv();
					if (!ok) return { ok: false, error: "mpv failed to start" };
					await loadQueueIntoMpv(target);
					index = target;
					paused = false;
					persist();
					return { ok: true };
				}
				if (!mpvReady) {
					const target = index < 0 ? queue.length - 1 : Math.max(0, index - 1);
					const ok = await spawnMpv();
					if (!ok) return { ok: false, error: "mpv failed to start" };
					await loadQueueIntoMpv(target);
					return { ok: true };
				}
				if (index < 0) {
					await mpvCmd(["set_property", "playlist-pos", queue.length - 1]);
					return { ok: true };
				}
				const target = index - 1;
				if (target < 0) {
					if (!repeat) {
						await mpvCmd(["set_property", "playlist-pos", 0]);
						return { ok: true };
					}
					await mpvCmd(["set_property", "playlist-pos", queue.length - 1]);
					return { ok: true };
				}
				await mpvCmd(["playlist-prev"]);
				return { ok: true };
			}
			case "stop":
				if (mpvReady) {
					await mpvCmd(["quit"]);
				}
				index = -1;
				preview = null;
				paused = false;
				persist();
				return { ok: true };
			case "pause": {
				if (!mpvReady || (index < 0 && !preview))
					return { ok: true, paused: false };
				await mpvCmd(["cycle", "pause"]);
				// Read back rather than guessing — mpv may have been paused for
				// reasons other than our toggle (buffering, etc.).
				const v = await mpvCmd(["get_property", "pause"]);
				if (typeof v === "boolean") paused = v;
				else paused = !paused;
				return { ok: true, paused };
			}
			case "repeat":
				repeat = Boolean(req.on);
				persist();
				if (mpvReady) {
					await mpvCmd([
						"set_property",
						"loop-playlist",
						repeat ? "inf" : "no",
					]);
				}
				return { ok: true, repeat };
			case "mode": {
				const next = req.mode;
				if (next !== "audio" && next !== "video") return { ok: true, mode };
				if (next === mode) return { ok: true, mode };
				const wasIndex = index;
				const wasPreview = preview;
				mode = next;
				persist();
				if (mpvReady) {
					await killMpv();
					const ok = await spawnMpv();
					if (!ok) return { ok: false, error: "mpv failed to start" };
					if (wasPreview) {
						await mpvCmd(["loadfile", wasPreview.url, "replace"]);
					} else {
						await loadQueueIntoMpv(wasIndex >= 0 ? wasIndex : 0);
					}
				}
				return { ok: true, mode };
			}
			case "seek": {
				if (!mpvReady) return { ok: true };
				const args: MpvVal[] = req.absolute
					? ["seek", req.seconds, "absolute"]
					: ["seek", req.seconds, "relative"];
				await mpvCmd(args);
				return { ok: true };
			}
			case "shutdown": {
				await killMpv();
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
		await killMpv();
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
