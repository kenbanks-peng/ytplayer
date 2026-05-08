import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { spawn } from "bun";
import { useEffect, useRef, useState } from "react";
import {
	ensureServer,
	getState,
	playTrack as playOnServer,
	stopPlayback,
	togglePause,
} from "./client";
import type { PlayMode, Track } from "./protocol";
import { runServer } from "./server";

if (process.argv.includes("server")) {
	await runServer();
	process.exit(0);
}

await ensureServer();

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

const CACHE_DIR = join(homedir(), ".cache", "ytplayer");
const SEARCH_FILE = join(CACHE_DIR, "search.json");

type SearchCache = { query: string; results: Track[] };

function saveSearch(cache: SearchCache | null) {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		if (cache && cache.results.length > 0) {
			writeFileSync(SEARCH_FILE, JSON.stringify(cache));
		} else if (existsSync(SEARCH_FILE)) {
			unlinkSync(SEARCH_FILE);
		}
	} catch {}
}

function loadSearch(): SearchCache | null {
	try {
		if (!existsSync(SEARCH_FILE)) return null;
		return JSON.parse(readFileSync(SEARCH_FILE, "utf8")) as SearchCache;
	} catch {
		return null;
	}
}

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

function App() {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Track[]>([]);
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [focus, setFocus] = useState<"search" | "results">("search");
	const [now, setNow] = useState<Track | null>(null);
	const [paused, setPaused] = useState(false);
	const [mode, setMode] = useState<PlayMode>("audio");
	const [status, setStatus] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const abortRef = useRef<AbortController | null>(null);
	const { width: termWidth } = useTerminalDimensions();

	const lastQueryRef = useRef("");

	useEffect(() => {
		(async () => {
			const state = await getState();
			if (state?.now) {
				setNow(state.now);
				setPaused(state.paused);
			}
			const cachedSearch = loadSearch();
			if (cachedSearch && cachedSearch.results.length > 0) {
				setResults(cachedSearch.results);
				lastQueryRef.current = cachedSearch.query;
				setFocus("results");
				if (state?.now) {
					const nowId = state.now.id;
					const i = cachedSearch.results.findIndex((r) => r.id === nowId);
					if (i >= 0) setSelectedIndex(i);
				}
			}
		})();

		const interval = setInterval(async () => {
			const state = await getState();
			if (!state) return;
			setNow((cur) => {
				if (cur?.id !== state.now?.id) return state.now;
				return cur;
			});
			setPaused(state.paused);
		}, 1000);

		return () => {
			abortRef.current?.abort();
			clearInterval(interval);
		};
	}, []);

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
			const sorted = sortByViewsDesc(tracks);
			setResults(sorted);
			saveSearch({ query: q, results: sorted });
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
			setResults((cur) => {
				const merged = sortByViewsDesc([...cur, ...fresh]);
				saveSearch({ query: q, results: merged });
				return merged;
			});
			setStatus("");
		} catch (e) {
			const err = e as { name?: string; message?: string };
			if (err.name !== "AbortError") setError(String(err.message ?? e));
		} finally {
			setSearching(false);
		}
	};

	const playTrack = async (t: Track, playMode: PlayMode = mode) => {
		setNow(t);
		setPaused(false);
		setStatus("");
		const i = results.findIndex((r) => r.id === t.id);
		if (i >= 0) setSelectedIndex(i);
		await playOnServer(t, playMode);
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
			process.nextTick(() => shutdown(0));
			return;
		}
		if (key.name === "space" && focus !== "search") {
			(async () => {
				const resp = await togglePause();
				if (resp) setPaused(resp.paused);
			})();
			return;
		}
		if (key.name === "m" && focus !== "search") {
			setMode((cur) => (cur === "audio" ? "video" : "audio"));
			return;
		}
		if (key.name === "s" && focus !== "search") {
			stopPlayback();
			setNow(null);
			setStatus("Stopped");
			return;
		}
		if ((key.name === "n" || key.name === "pagedown") && focus !== "search") {
			loadMore();
			return;
		}
		if (key.name === "c" && focus !== "search") {
			setResults([]);
			setSelectedIndex(0);
			setError(null);
			setStatus("");
			lastQueryRef.current = "";
			saveSearch(null);
			setFocus("search");
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
							selectedIndex={selectedIndex}
							onChange={(i: number) => setSelectedIndex(i)}
							onSelect={(i: number) => {
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
					mode • n: load more • c: clear • q/ctrl-c: quit
				</text>
			</box>
		</box>
	);
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);

const shutdown = (code = 0) => {
	try {
		renderer.destroy();
	} catch {}
	process.exit(code);
};

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("SIGHUP", () => shutdown(129));
