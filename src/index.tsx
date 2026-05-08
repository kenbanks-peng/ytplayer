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
	nextTrack,
	prevTrack,
	queueAdd,
	queueClear,
	queueJump,
	queueMove,
	queuePlay,
	queueRemove,
	queueShuffle,
	setMode as setModeOnServer,
	setRepeat,
	stopPlayback,
	togglePause,
} from "./client";
import type { PlayMode, Track } from "./protocol";
import { runServer } from "./server";
import { theme } from "./theme";

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

function charWidth(cp: number): number {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	// Combining marks, zero-width joiners, variation selectors.
	if (
		(cp >= 0x0300 && cp <= 0x036f) ||
		(cp >= 0x200b && cp <= 0x200f) ||
		cp === 0x200d ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		(cp >= 0xe0100 && cp <= 0xe01ef)
	) {
		return 0;
	}
	// Wide ranges: CJK, hangul, kana, fullwidth, most emoji.
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x2fffd) ||
		(cp >= 0x30000 && cp <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

function displayWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
}

function fitCol(s: string, width: number): string {
	if (width <= 0) return "";
	const w = displayWidth(s);
	if (w === width) return s;
	if (w < width) return s + " ".repeat(width - w);
	const reserve = width <= 1 ? 0 : 1;
	let acc = "";
	let aw = 0;
	for (const ch of s) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (aw + cw > width - reserve) break;
		acc += ch;
		aw += cw;
	}
	if (reserve) {
		acc += "…";
		aw += 1;
	}
	if (aw < width) acc += " ".repeat(width - aw);
	return acc;
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
			const title: string = j.title ?? "(untitled)";
			const uploader: string | undefined = j.uploader || j.channel;
			tracks.push({
				id: j.id,
				title: title.normalize("NFKC"),
				url: j.url ?? `https://www.youtube.com/watch?v=${j.id}`,
				uploader: uploader?.normalize("NFKC"),
				duration: j.duration,
				views: typeof j.view_count === "number" ? j.view_count : undefined,
				page,
			});
		} catch {}
	}
	return tracks;
}

type Focus = "search" | "results" | "playlist";

function App() {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Track[]>([]);
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [focus, setFocus] = useState<Focus>("search");
	const [queue, setQueue] = useState<Track[]>([]);
	const [queueIndex, setQueueIndex] = useState(-1);
	const [paused, setPaused] = useState(false);
	const [repeat, setRepeatState] = useState(false);
	const [mode, setMode] = useState<PlayMode>("audio");
	const [status, setStatus] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [playlistSelected, setPlaylistSelected] = useState(0);
	const [showHelp, setShowHelp] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const { width: termWidth } = useTerminalDimensions();

	const lastQueryRef = useRef("");
	const now = queueIndex >= 0 ? (queue[queueIndex] ?? null) : null;

	useEffect(() => {
		(async () => {
			const state = await getState();
			const q = Array.isArray(state?.queue) ? state.queue : [];
			const idx = typeof state?.index === "number" ? state.index : -1;
			if (state) {
				setQueue(q);
				setQueueIndex(idx);
				setPaused(Boolean(state.paused));
				setRepeatState(Boolean(state.repeat));
				if (state.mode === "audio" || state.mode === "video")
					setMode(state.mode);
			}
			const cachedSearch = loadSearch();
			if (cachedSearch && cachedSearch.results.length > 0) {
				setResults(cachedSearch.results);
				lastQueryRef.current = cachedSearch.query;
				setFocus("results");
				const nowId = idx >= 0 ? q[idx]?.id : null;
				if (nowId) {
					const i = cachedSearch.results.findIndex((r) => r.id === nowId);
					if (i >= 0) setSelectedIndex(i);
				}
			}
		})();

		const interval = setInterval(async () => {
			const state = await getState();
			if (!state) return;
			const q = Array.isArray(state.queue) ? state.queue : [];
			const idx = typeof state.index === "number" ? state.index : -1;
			setQueue((cur) => {
				if (cur.length !== q.length || cur.some((t, i) => t.id !== q[i]?.id)) {
					return q;
				}
				return cur;
			});
			setQueueIndex(idx);
			setPaused(Boolean(state.paused));
			setRepeatState(Boolean(state.repeat));
			if (state.mode === "audio" || state.mode === "video") setMode(state.mode);
		}, 1000);

		return () => {
			abortRef.current?.abort();
			clearInterval(interval);
		};
	}, []);

	// Keep playlist selection in range as queue mutates.
	useEffect(() => {
		if (queue.length === 0) {
			if (playlistSelected !== 0) setPlaylistSelected(0);
			return;
		}
		if (playlistSelected >= queue.length) {
			setPlaylistSelected(queue.length - 1);
		}
	}, [queue.length, playlistSelected]);

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

	const addToQueue = async (t: Track) => {
		setStatus("");
		setQueue((cur) => (cur.some((q) => q.id === t.id) ? cur : [...cur, t]));
		await queueAdd(t, mode);
	};

	const playFromResults = async (t: Track) => {
		setStatus("");
		setQueue((cur) => {
			const i = cur.findIndex((q) => q.id === t.id);
			if (i >= 0) {
				setQueueIndex(i);
				return cur;
			}
			setQueueIndex(cur.length);
			return [...cur, t];
		});
		setPaused(false);
		await queuePlay(t);
	};

	const jumpInQueue = async (i: number) => {
		if (i < 0 || i >= queue.length) return;
		setQueueIndex(i);
		setPaused(false);
		await queueJump(i);
	};

	const removeFromQueue = async (id: string) => {
		await queueRemove(id);
		// Optimistic local update — server poll will reconcile.
		setQueue((cur) => cur.filter((t) => t.id !== id));
	};

	useKeyboard((key) => {
		if (
			(key.name === "?" || (key.shift && key.name === "/")) &&
			focus !== "search"
		) {
			setShowHelp((s) => !s);
			return;
		}
		if (key.name === "escape" && showHelp) {
			setShowHelp(false);
			return;
		}
		if (key.name === "tab") {
			setFocus((f) =>
				f === "search" ? "results" : f === "results" ? "playlist" : "search",
			);
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
			const next: PlayMode = mode === "audio" ? "video" : "audio";
			setMode(next);
			setModeOnServer(next);
			return;
		}
		if (key.name === "r" && focus !== "search") {
			const next = !repeat;
			setRepeatState(next);
			setRepeat(next);
			return;
		}
		if (key.name === "s" && focus !== "search") {
			stopPlayback();
			setQueueIndex(-1);
			setStatus("Stopped");
			return;
		}
		if ((key.name === "n" || key.name === "pagedown") && focus !== "search") {
			loadMore();
			return;
		}
		if (
			(key.name === ">" || (key.shift && key.name === "period")) &&
			focus !== "search"
		) {
			nextTrack();
			return;
		}
		if (
			(key.name === "<" || (key.shift && key.name === "comma")) &&
			focus !== "search"
		) {
			prevTrack();
			return;
		}
		if (key.name === "d" && focus === "playlist") {
			const t = queue[playlistSelected];
			if (t) removeFromQueue(t.id);
			return;
		}
		if (key.name === "x" && focus !== "search") {
			queueShuffle();
			return;
		}
		if (key.name === "p" && focus === "results") {
			const t = results[selectedIndex];
			if (t) playFromResults(t);
			return;
		}
		if (key.name === "c" && focus === "playlist") {
			queueClear();
			setQueue([]);
			setQueueIndex(-1);
			setPlaylistSelected(0);
			return;
		}
		if (
			(key.name === "[" || key.name === "bracketleft") &&
			focus === "playlist"
		) {
			const from = playlistSelected;
			const to = from - 1;
			if (from > 0 && to >= 0) {
				setQueue((cur) => {
					const next = [...cur];
					const [item] = next.splice(from, 1);
					if (item) next.splice(to, 0, item);
					return next;
				});
				setQueueIndex((idx) => {
					if (idx < 0) return idx;
					if (idx === from) return to;
					if (from < idx && to >= idx) return idx - 1;
					if (from > idx && to <= idx) return idx + 1;
					return idx;
				});
				setPlaylistSelected(to);
				queueMove(from, to);
			}
			return;
		}
		if (
			(key.name === "]" || key.name === "bracketright") &&
			focus === "playlist"
		) {
			const from = playlistSelected;
			const to = from + 1;
			if (from >= 0 && to < queue.length) {
				setQueue((cur) => {
					const next = [...cur];
					const [item] = next.splice(from, 1);
					if (item) next.splice(to, 0, item);
					return next;
				});
				setQueueIndex((idx) => {
					if (idx < 0) return idx;
					if (idx === from) return to;
					if (from < idx && to >= idx) return idx - 1;
					if (from > idx && to <= idx) return idx + 1;
					return idx;
				});
				setPlaylistSelected(to);
				queueMove(from, to);
			}
			return;
		}
		if (key.name === "c" && focus === "results") {
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

	// Layout: results pane gets ~60%, playlist pane ~40%.
	const inner = Math.max(52, termWidth - 8);
	const resultsW = Math.floor(inner * 0.6);
	const playlistW = inner - resultsW;

	const durW = 7;
	const viewsW = 7;
	const uploaderW = Math.max(8, Math.min(20, Math.floor(resultsW * 0.22)));
	const titleW = Math.max(10, resultsW - durW - viewsW - uploaderW - 8);

	const nowId = now?.id ?? null;
	const options = results.map((t) => {
		const marker = t.id === nowId ? "▶" : pageMarker(t.page);
		const title = fitCol(t.title.normalize("NFKC"), titleW);
		const uploader = fitCol((t.uploader ?? "").normalize("NFKC"), uploaderW);
		const views = fmtCount(t.views).padStart(viewsW, " ");
		const duration = fmtDur(t.duration).padStart(durW, " ");
		return {
			name: `${marker} ${title}  ${uploader}  ${views}  ${duration}`,
			description: "",
			value: t.id,
		};
	});

	const plDurW = 6;
	const plTitleW = Math.max(10, playlistW - plDurW - 6);
	const playlistOptions = queue.map((t, i) => {
		const marker = i === queueIndex ? "▶" : " ";
		const title = fitCol(t.title.normalize("NFKC"), plTitleW);
		const duration = fmtDur(t.duration).padStart(plDurW, " ");
		return {
			name: `${marker} ${title}  ${duration}`,
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

			<box flexDirection="row" flexGrow={1}>
				<box
					flexGrow={1}
					flexBasis={resultsW}
					flexDirection="column"
					border
					title={` Results ${searching ? "(searching...)" : ""} `}
				>
					{options.length > 0 ? (
						<>
							<text fg={theme.textSubtle} attributes={2}>
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
									if (track) addToQueue(track);
								}}
								flexGrow={1}
							/>
						</>
					) : (
						<box padding={1}>
							<text fg={theme.textMuted}>
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
					flexBasis={playlistW}
					flexDirection="column"
					border
					title={` Playlist (${queue.length}) `}
				>
					{playlistOptions.length > 0 ? (
						<select
							options={playlistOptions}
							focused={focus === "playlist"}
							showDescription={false}
							selectedIndex={Math.min(
								playlistSelected,
								Math.max(0, playlistOptions.length - 1),
							)}
							onChange={(i: number) => setPlaylistSelected(i)}
							onSelect={(i: number) => jumpInQueue(i)}
							flexGrow={1}
						/>
					) : (
						<box padding={1}>
							<text fg={theme.textMuted}>Empty. Enter on a result to add.</text>
						</box>
					)}
				</box>
			</box>

			<box
				flexDirection="column"
				border
				title={` ${mode.toUpperCase()}${repeat ? " • REPEAT" : ""} `}
				padding={1}
			>
				<box flexDirection="row" justifyContent="flex-end">
					<text fg={theme.textMuted}>
						{results.length > 0 ? `${results.length} results` : ""}
					</text>
				</box>
				{now ? (
					<>
						<text>
							<span fg={paused ? theme.paused : theme.playing}>
								{paused ? "❚❚" : "▶ "}
							</span>{" "}
							{now.title.normalize("NFKC")}
							{now.uploader ? (
								<span fg={theme.textMuted}>
									{" "}
									— {now.uploader.normalize("NFKC")}
								</span>
							) : null}
							<span fg={theme.textMuted}>
								{" "}
								[{queueIndex + 1}/{queue.length}]
							</span>
						</text>
						<text fg={theme.textSubtle} attributes={2}>
							{now.url}
						</text>
					</>
				) : (
					<text fg={theme.textMuted}>Nothing playing</text>
				)}
				<text fg={theme.textMuted}>{status}</text>
				<text fg={theme.textSubtle} attributes={2}>
					? for keys
				</text>
			</box>
			{showHelp ? (
				<box
					position="absolute"
					top={6}
					left={4}
					right={4}
					border
					title=" Keys "
					padding={1}
					backgroundColor={theme.surfaceOverlay}
					flexDirection="column"
				>
					<box flexDirection="row">
						<box flexDirection="column" flexGrow={1}>
							<text>
								<span fg={theme.keyHint}>Tab </span>
								<span fg={theme.textMuted}>cycle focus</span>
							</text>
							<text>
								<span fg={theme.keyHint}>Enter </span>
								<span fg={theme.textMuted}>
									add (results) / jump (playlist)
								</span>
							</text>
							<text>
								<span fg={theme.keyHint}>p </span>
								<span fg={theme.textMuted}>play selected result now</span>
							</text>
							<text>
								<span fg={theme.keyHint}>d </span>
								<span fg={theme.textMuted}>remove from playlist</span>
							</text>
							<text>
								<span fg={theme.keyHint}>[ / ] </span>
								<span fg={theme.textMuted}>move playlist item up/down</span>
							</text>
							<text>
								<span fg={theme.keyHint}>x </span>
								<span fg={theme.textMuted}>shuffle queue</span>
							</text>
							<text>
								<span fg={theme.keyHint}>c </span>
								<span fg={theme.textMuted}>clear results / clear queue</span>
							</text>
						</box>
						<box flexDirection="column" flexGrow={1}>
							<text>
								<span fg={theme.keyHint}>Space </span>
								<span fg={theme.textMuted}>pause / resume</span>
							</text>
							<text>
								<span fg={theme.keyHint}>&lt; / &gt; </span>
								<span fg={theme.textMuted}>prev / next track</span>
							</text>
							<text>
								<span fg={theme.keyHint}>s </span>
								<span fg={theme.textMuted}>stop</span>
							</text>
							<text>
								<span fg={theme.keyHint}>m </span>
								<span fg={theme.textMuted}>audio / video mode</span>
							</text>
							<text>
								<span fg={theme.keyHint}>r </span>
								<span fg={theme.textMuted}>toggle repeat</span>
							</text>
							<text>
								<span fg={theme.keyHint}>n / PgDn </span>
								<span fg={theme.textMuted}>load more results</span>
							</text>
							<text>
								<span fg={theme.keyHint}>q / Ctrl-C </span>
								<span fg={theme.textMuted}>quit (server stays)</span>
							</text>
						</box>
					</box>
					<text> </text>
					<text fg={theme.textSubtle} attributes={2}>
						? or Esc to close
					</text>
				</box>
			) : null}
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
