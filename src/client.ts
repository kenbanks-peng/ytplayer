import { existsSync, openSync } from "node:fs";
import { connect } from "node:net";
import { spawn } from "bun";
import {
	type PlayMode,
	SERVER_SOCK,
	type ServerState,
	type Track,
} from "./protocol";
import { binaryVersion } from "./server";

const SERVER_LOG = "/tmp/ytplayer-server.log";

function send<T = unknown>(req: unknown, timeoutMs = 2000): Promise<T | null> {
	return new Promise((resolve) => {
		if (!existsSync(SERVER_SOCK)) return resolve(null);
		const sock = connect(SERVER_SOCK);
		let buf = "";
		let done = false;
		const finish = (v: T | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				sock.end();
			} catch {}
			resolve(v);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		sock.on("data", (d) => {
			buf += d.toString();
			const idx = buf.indexOf("\n");
			if (idx >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, idx)) as T);
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.write(`${JSON.stringify(req)}\n`);
	});
}

export async function ensureServer(): Promise<void> {
	const expected = binaryVersion();
	if (existsSync(SERVER_SOCK)) {
		const resp = await send<{ ok?: boolean; version?: string }>(
			{ cmd: "ping" },
			500,
		);
		if (resp?.ok) {
			if (resp.version === expected) return;
			await send({ cmd: "shutdown" }, 1000);
			for (let i = 0; i < 30 && existsSync(SERVER_SOCK); i++) {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
	}
	const exe = process.execPath;
	if (!exe) throw new Error("cannot determine executable to spawn server");
	const args = [
		...process.argv.slice(1).filter((a) => a !== "server"),
		"server",
	];
	const log = openSync(SERVER_LOG, "a");
	spawn([exe, ...args], {
		stdout: log,
		stderr: log,
		stdin: "ignore",
	});
	for (let i = 0; i < 50; i++) {
		await new Promise((r) => setTimeout(r, 100));
		if (!existsSync(SERVER_SOCK)) continue;
		const resp = await send<{ ok?: boolean }>({ cmd: "ping" }, 500);
		if (resp?.ok) return;
	}
	throw new Error(`ytplayer server failed to start (see ${SERVER_LOG})`);
}

export const getState = () => send<ServerState>({ cmd: "state" });
export const queueAdd = (track: Track, mode: PlayMode) =>
	send<{ ok: boolean }>({ cmd: "queue:add", track, mode });
export const queuePlay = (track: Track) =>
	send<{ ok: boolean }>({ cmd: "queue:play", track });
export const queuePreview = (track: Track) =>
	send<{ ok: boolean }>({ cmd: "play:preview", track });
export const queueRemove = (id: string) =>
	send<{ ok: boolean }>({ cmd: "queue:remove", id });
export const queueJump = (index: number) =>
	send<{ ok: boolean }>({ cmd: "queue:jump", index });
export const queueClear = () => send<{ ok: boolean }>({ cmd: "queue:clear" });
export const queueMove = (from: number, to: number) =>
	send<{ ok: boolean }>({ cmd: "queue:move", from, to });
export const queueShuffle = () =>
	send<{ ok: boolean }>({ cmd: "queue:shuffle" });
export const nextTrack = () => send<{ ok: boolean }>({ cmd: "next" });
export const prevTrack = () => send<{ ok: boolean }>({ cmd: "prev" });
export const stopPlayback = () => send<{ ok: boolean }>({ cmd: "stop" });
export const togglePause = () =>
	send<{ ok: boolean; paused: boolean }>({ cmd: "pause" });
export const setRepeat = (on: boolean) =>
	send<{ ok: boolean; repeat: boolean }>({ cmd: "repeat", on });
export const setMode = (mode: PlayMode) =>
	send<{ ok: boolean; mode: PlayMode }>({ cmd: "mode", mode });
export const seekRelative = (seconds: number) =>
	send<{ ok: boolean }>({ cmd: "seek", seconds });
