import { existsSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type Subprocess, spawn } from "bun";
import { useEffect, useRef, useState } from "react";

type Track = {
	id: string;
	title: string;
	url: string;
	uploader?: string;
	duration?: number;
	views?: number;
	page: number;
};

const PAGE_MARKERS = ["●", "○", "◆", "◇", "▲", "△", "■", "□"];
const pageMarker = (page: number): string =>
	PAGE_MARKERS[(page - 1) % PAGE_MARKERS.length] ?? "·";

function sortByViewsDesc(tracks: Track[]): Track[] {
	return [...tracks].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
}

function fmtCount(n?: number): string {
	if (n == null || !Number.isFinite(n)) return "";
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

type MpvCommandValue = string | number | boolean;

const MPV_SOCK = "/tmp/ytmusic-mpv.sock";

let mpvPid: number | null = null;
const setMpvPid = (pid: number | null) => {
	mpvPid = pid;
};

function fmtDur(s?: number) {
	if (!s || !Number.isFinite(s)) return "--:--";
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
}

function fitCol(s: string, width: number): string {
	if (width <= 0) return "";
	if (s.length === width) return s;
	if (s.length < width) return s.padEnd(width, " ");
	if (width <= 1) return s.slice(0, width);
	return `${s.slice(0, width - 1)}…`;
}

const PAGE_SIZE = 20;

async function searchYouTube(
	query: string,
	count: number,
	page: number,
	signal: AbortSignal,
): Promise<Track[]> {
	const proc = spawn(
		[
			"yt-dlp",
			`ytsearch${count}:${query}`,
			"--flat-playlist",
			"--dump-json",
			"--no-warnings",
		],
		{ stdout: "pipe", stderr: "ignore", signal },
	);
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	const tracks: Track[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const j = JSON.parse(line);
			tracks.push({
				id: j.id,
				title: j.title ?? "(untitled)",
				url: j.url ?? `https://www.youtube.com/watch?v=${j.id}`,
				uploader: j.uploader || j.channel,
				duration: j.duration,
				views: typeof j.view_count === "number" ? j.view_count : undefined,
				page,
			});
		} catch {}
	}
	return tracks;
}

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

function App() {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Track[]>([]);
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [focus, setFocus] = useState<"search" | "results">("search");
	const [now, setNow] = useState<Track | null>(null);
	const [paused, setPaused] = useState(false);
	const [mode, setMode] = useState<"audio" | "video">("audio");
	const [status, setStatus] = useState("");
	const mpvRef = useRef<Subprocess | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const { width: termWidth } = useTerminalDimensions();

	const stopMpv = () => {
		if (mpvRef.current) {
			try {
				mpvRef.current.kill();
			} catch {}
			mpvRef.current = null;
			setMpvPid(null);
		}
		if (existsSync(MPV_SOCK)) {
			try {
				unlinkSync(MPV_SOCK);
			} catch {}
		}
	};

	useEffect(() => {
		return () => {
			abortRef.current?.abort();
			if (mpvRef.current) {
				try {
					mpvRef.current.kill();
				} catch {}
				mpvRef.current = null;
				setMpvPid(null);
			}
			if (existsSync(MPV_SOCK)) {
				try {
					unlinkSync(MPV_SOCK);
				} catch {}
			}
		};
	}, []);

	const lastQueryRef = useRef("");

	const doSearch = async (q: string = query) => {
		if (!q.trim() || searching) return;
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setSearching(true);
		setError(null);
		setStatus(`Searching: ${q}`);
		try {
			const tracks = await searchYouTube(q, PAGE_SIZE, 1, ac.signal);
			lastQueryRef.current = q;
			setResults(sortByViewsDesc(tracks));
			setStatus("");
			if (tracks.length > 0) setFocus("results");
		} catch (e) {
			const err = e as { name?: string; message?: string };
			if (err.name !== "AbortError") setError(String(err.message ?? e));
		} finally {
			setSearching(false);
		}
	};

	const loadMore = async () => {
		const q = lastQueryRef.current;
		if (!q || searching) return;
		const have = results.length;
		const target = have + PAGE_SIZE;
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setSearching(true);
		try {
			const nextPage = results.reduce((m, r) => Math.max(m, r.page), 0) + 1;
			const all = await searchYouTube(q, target, nextPage, ac.signal);
			const seen = new Set(results.map((r) => r.id));
			const fresh = all.filter((t) => !seen.has(t.id));
			if (fresh.length === 0) {
				setStatus(`No more results for "${q}"`);
				return;
			}
			setResults((cur) => sortByViewsDesc([...cur, ...fresh]));
			setStatus("");
		} catch (e) {
			const err = e as { name?: string; message?: string };
			if (err.name !== "AbortError") setError(String(err.message ?? e));
		} finally {
			setSearching(false);
		}
	};

	const playTrack = (t: Track, playMode: "audio" | "video" = mode) => {
		stopMpv();
		setNow(t);
		setPaused(false);
		const args = [
			"mpv",
			"--no-terminal",
			`--input-ipc-server=${MPV_SOCK}`,
			playMode === "audio"
				? "--ytdl-format=bestaudio"
				: "--ytdl-format=bestvideo*+bestaudio/best",
			playMode === "audio" ? "--no-video" : "--force-window=yes",
			t.url,
		];
		const proc = spawn(args, { stdout: "ignore", stderr: "ignore" });
		mpvRef.current = proc;
		setMpvPid(proc.pid);
		proc.exited.then(() => {
			if (mpvRef.current === proc) {
				mpvRef.current = null;
				setMpvPid(null);
				setNow((cur) => (cur?.id === t.id ? null : cur));
			}
		});
	};

	useKeyboard((key) => {
		if (key.name === "tab") {
			setFocus((f) => (f === "search" ? "results" : "search"));
			return;
		}
		if (
			(key.ctrl && key.name === "c") ||
			(key.name === "q" && focus !== "search")
		) {
			stopMpv();
			process.nextTick(() => process.exit(0));
			return;
		}
		if (key.name === "space" && focus !== "search") {
			sendMpv(["cycle", "pause"]);
			setPaused((p) => !p);
			return;
		}
		if (key.name === "m" && focus !== "search") {
			setMode((cur) => (cur === "audio" ? "video" : "audio"));
			return;
		}
		if (key.name === "s" && focus !== "search") {
			stopMpv();
			setNow(null);
			setStatus("Stopped");
			return;
		}
		if ((key.name === "n" || key.name === "pagedown") && focus !== "search") {
			loadMore();
			return;
		}
	});

	// Layout: <pg> <title>  <uploader>  <views>  <duration>
	// The select renderable adds ~4 chars of selection chrome, plus border + padding.
	const inner = Math.max(52, termWidth - 8);
	const durW = 7;
	const viewsW = 7;
	const uploaderW = Math.max(12, Math.min(28, Math.floor(inner * 0.25)));
	const titleW = Math.max(10, inner - durW - viewsW - uploaderW - 8);

	const options = results.map((t) => {
		const marker = pageMarker(t.page);
		const title = fitCol(t.title, titleW);
		const uploader = fitCol(t.uploader ?? "", uploaderW);
		const views = fmtCount(t.views).padStart(viewsW, " ");
		const duration = fmtDur(t.duration).padStart(durW, " ");
		return {
			name: `${marker} ${title}  ${uploader}  ${views}  ${duration}`,
			description: "",
			value: t.id,
		};
	});

	return (
		<box flexDirection="column" flexGrow={1} padding={1}>
			<box
				flexDirection="row"
				border
				title=" YouTube Player "
				padding={1}
				alignItems="center"
			>
				<text>Search: </text>
				<input
					value={query}
					onInput={setQuery}
					onSubmit={(value) => {
						const v = typeof value === "string" ? value : query;
						setQuery(v);
						doSearch(v);
					}}
					placeholder="artist, song, album..."
					focused={focus === "search"}
					flexGrow={1}
				/>
			</box>

			<box
				flexGrow={1}
				flexDirection="column"
				border
				title={` Results ${searching ? "(searching...)" : ""} `}
			>
				{options.length > 0 ? (
					<>
						<text fg="gray" attributes={2}>
							{`    ${fitCol("Title", titleW)}  ${fitCol("Uploader", uploaderW)}  ${"Views".padStart(viewsW, " ")}  ${"Length".padStart(durW, " ")}`}
						</text>
						<select
							options={options}
							focused={focus === "results"}
							showDescription={false}
							onSelect={(i) => {
								const track = results[i];
								if (track) playTrack(track);
							}}
							flexGrow={1}
						/>
					</>
				) : (
					<box padding={1}>
						<text fg="gray">
							{error
								? `Error: ${error}`
								: searching
									? "Searching..."
									: "No results yet."}
						</text>
					</box>
				)}
			</box>

			<box
				flexDirection="column"
				border
				title={` ${mode.toUpperCase()} `}
				padding={1}
			>
				<box flexDirection="row" justifyContent="flex-end">
					<text fg="gray">
						{results.length > 0 ? `${results.length} results` : ""}
					</text>
				</box>
				{now ? (
					<>
						<text>
							<span fg={paused ? "yellow" : "green"}>
								{paused ? "❚❚" : "▶ "}
							</span>{" "}
							<strong>{now.title}</strong>
							{now.uploader ? <span fg="gray"> — {now.uploader}</span> : null}
						</text>
						<text fg="gray" attributes={2}>
							{now.url}
						</text>
					</>
				) : (
					<text fg="gray">Nothing playing</text>
				)}
				<text fg="gray">{status}</text>
				<text fg="gray" attributes={2}>
					Tab: switch focus • Enter: play • Space: pause • s: stop • m: toggle
					mode • n: load more • q: quit
				</text>
			</box>
		</box>
	);
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);

const killMpv = () => {
	if (mpvPid) {
		try {
			process.kill(mpvPid, "SIGKILL");
		} catch {}
		mpvPid = null;
	}
	if (existsSync(MPV_SOCK)) {
		try {
			unlinkSync(MPV_SOCK);
		} catch {}
	}
};

const shutdown = (code = 0) => {
	killMpv();
	try {
		renderer.destroy();
	} catch {}
	process.exit(code);
};

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("SIGHUP", () => shutdown(129));
process.on("exit", killMpv);
