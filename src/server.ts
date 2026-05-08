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
import { type PlayMode, SERVER_SOCK, type Track } from "./protocol";

const MPV_SOCK = "/tmp/ytplayer-mpv.sock";

export function binaryVersion(): string {
	try {
		return String(statSync(process.execPath).mtimeMs);
	} catch {
		return "0";
	}
}
const CACHE_DIR = join(homedir(), ".cache", "ytplayer");
const STATE_FILE = join(CACHE_DIR, "state.json");

function saveState(track: Track | null) {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		if (track) writeFileSync(STATE_FILE, JSON.stringify(track));
		else if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
	} catch {}
}

function loadState(): Track | null {
	try {
		if (!existsSync(STATE_FILE)) return null;
		return JSON.parse(readFileSync(STATE_FILE, "utf8")) as Track;
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
	| { cmd: "play"; track: Track; mode?: PlayMode }
	| { cmd: "stop" }
	| { cmd: "pause" }
	| { cmd: "repeat"; on: boolean }
	| { cmd: "shutdown" };

export async function runServer(): Promise<void> {
	let mpv: Subprocess | null = null;
	let now: Track | null = null;
	let paused = false;
	let repeat = false;

	// Adopt an existing mpv if its socket is still alive.
	const cached = loadState();
	if (cached && existsSync(MPV_SOCK)) {
		const resp = (await sendMpv(["get_property", "pause"])) as {
			error?: string;
			data?: boolean;
		} | null;
		if (resp && resp.error === "success") {
			now = cached;
			paused = Boolean(resp.data);
		} else {
			saveState(null);
			try {
				unlinkSync(MPV_SOCK);
			} catch {}
		}
	} else if (cached) {
		saveState(null);
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
		now = null;
		paused = false;
		saveState(null);
	};

	const play = async (track: Track, mode: PlayMode) => {
		await stopPlayback();
		now = track;
		paused = false;
		saveState(track);
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
			if (mpv !== proc) return;
			mpv = null;
			if (now?.id !== track.id) return;
			if (repeat) {
				play(track, mode);
				return;
			}
			now = null;
			paused = false;
			saveState(null);
		});
	};

	const handle = async (req: Request): Promise<unknown> => {
		switch (req.cmd) {
			case "ping":
				return { ok: true, version: binaryVersion() };
			case "state":
				return { now, paused, repeat };
			case "play":
				if (!req.track) return { ok: false, error: "missing track" };
				await play(req.track, req.mode ?? "audio");
				return { ok: true };
			case "stop":
				await stopPlayback();
				return { ok: true };
			case "pause":
				if (!now) return { ok: true, paused: false };
				await sendMpv(["cycle", "pause"]);
				paused = !paused;
				return { ok: true, paused };
			case "repeat":
				repeat = Boolean(req.on);
				return { ok: true, repeat };
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
