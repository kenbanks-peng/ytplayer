import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createCliRenderer,
	type InputRenderable,
	type ScrollBoxRenderable,
} from "@opentui/core";
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
	queuePreview,
	queueRemove,
	queueShuffle,
	seekRelative,
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

function clip(s: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(s) <= width) return s;
	const reserve = width <= 1 ? 0 : 1;
	let acc = "";
	let aw = 0;
	for (const ch of s) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (aw + cw > width - reserve) break;
		acc += ch;
		aw += cw;
	}
	if (reserve) acc += "…";
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

function scrollCursorIntoView(
	sb: ScrollBoxRenderable | null,
	cursorIndex: number,
	padding = 2,
) {
	if (!sb || cursorIndex < 0) return;
	const viewH = sb.viewport.height;
	if (viewH <= 0) return;
	const top = sb.scrollTop;
	if (cursorIndex < top + padding) {
		sb.scrollTop = Math.max(0, cursorIndex - padding);
	} else if (cursorIndex > top + viewH - padding - 1) {
		sb.scrollTop = cursorIndex - viewH + padding + 1;
	}
}

const HELP_LEFT: [string, string][] = [
	["Tab", "toggle focus"],
	["Enter", "add to playlist"],
	["i", "instant play"],
	["g", "go play playlist"],
	["d", "delete from playlist"],
	["[ / ]", "move playlist item up/down"],
	["x", "shuffle queue"],
	["y", "yank to browser"],
	["c", "clear results / clear queue"],
];
const HELP_RIGHT: [string, string][] = [
	["Space", "pause / resume"],
	["p / n", "prev / next track"],
	["← / →", "seek -10s / +10s"],
	["s", "stop"],
	["m", "mode: audio / video"],
	["r", "repeat toggle"],
	["f", "fetch more results"],
	["q / Ctrl-C", "quit"],
];
const HELP_LEFT_KEY_W =
	Math.max(...HELP_LEFT.map(([k]) => displayWidth(k))) + 2;
const HELP_RIGHT_KEY_W =
	Math.max(...HELP_RIGHT.map(([k]) => displayWidth(k))) + 2;

function App() {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Track[]>([]);
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [focus, setFocus] = useState<Focus>("search");
	const [queue, setQueue] = useState<Track[]>([]);
	const [queueIndex, setQueueIndex] = useState(-1);
	const [preview, setPreview] = useState<Track | null>(null);
	const [paused, setPaused] = useState(false);
	const [playing, setPlaying] = useState(false);
	const [repeat, setRepeatState] = useState(false);
	const [mode, setMode] = useState<PlayMode>("audio");
	const [position, setPosition] = useState(0);
	const [trackDuration, setTrackDuration] = useState(0);
	const [status, setStatus] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [playlistSelected, setPlaylistSelected] = useState(0);
	const [showHelp, setShowHelp] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const inputRef = useRef<InputRenderable | null>(null);
	const resultsScrollRef = useRef<ScrollBoxRenderable | null>(null);
	const playlistScrollRef = useRef<ScrollBoxRenderable | null>(null);
	const { width: termWidth } = useTerminalDimensions();

	useEffect(() => {
		if (focus === "search") inputRef.current?.focus();
		else inputRef.current?.blur();
	}, [focus]);

	const lastQueryRef = useRef("");
	const now = preview ?? (queueIndex >= 0 ? (queue[queueIndex] ?? null) : null);

	useEffect(() => {
		(async () => {
			const state = await getState();
			const q = Array.isArray(state?.queue) ? state.queue : [];
			const idx = typeof state?.index === "number" ? state.index : -1;
			if (state) {
				setQueue(q);
				setQueueIndex(idx);
				setPreview(state.preview ?? null);
				setPaused(Boolean(state.paused));
				setPlaying(Boolean(state.playing));
				setRepeatState(Boolean(state.repeat));
				setPosition(typeof state.position === "number" ? state.position : 0);
				setTrackDuration(
					typeof state.duration === "number" ? state.duration : 0,
				);
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
			setPreview(state.preview ?? null);
			setPaused(Boolean(state.paused));
			setPlaying(Boolean(state.playing));
			setRepeatState(Boolean(state.repeat));
			setPosition(typeof state.position === "number" ? state.position : 0);
			setTrackDuration(typeof state.duration === "number" ? state.duration : 0);
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

	useEffect(() => {
		scrollCursorIntoView(resultsScrollRef.current, selectedIndex);
	}, [selectedIndex]);

	useEffect(() => {
		scrollCursorIntoView(playlistScrollRef.current, playlistSelected);
	}, [playlistSelected]);

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

	const previewFromResults = async (t: Track) => {
		setStatus("");
		setPreview(t);
		setQueueIndex(-1);
		setPaused(false);
		await queuePreview(t);
	};

	const jumpInQueue = async (i: number) => {
		if (i < 0 || i >= queue.length) return;
		setQueueIndex(i);
		setPaused(false);
		await queueJump(i);
	};

	const removeFromQueue = async (id: string) => {
		await queueRemove(id);
		setQueue((cur) => {
			const i = cur.findIndex((t) => t.id === id);
			if (i < 0) return cur;
			const next = cur.filter((t) => t.id !== id);
			setQueueIndex((idx) => {
				if (idx < 0) return idx;
				if (i < idx) return idx - 1;
				if (i === idx && idx >= next.length) return next.length - 1;
				return idx;
			});
			return next;
		});
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
		if (focus === "playlist" && queue.length > 0) {
			if (key.name === "up") {
				setPlaylistSelected((c) => Math.max(0, c - 1));
				return;
			}
			if (key.name === "down") {
				setPlaylistSelected((c) => Math.min(queue.length - 1, c + 1));
				return;
			}
			if (key.name === "return") {
				jumpInQueue(playlistSelected);
				return;
			}
		}
		if (focus === "results" && results.length > 0) {
			if (key.name === "up") {
				setSelectedIndex((c) => Math.max(0, c - 1));
				return;
			}
			if (key.name === "down") {
				setSelectedIndex((c) => Math.min(results.length - 1, c + 1));
				return;
			}
			if (key.name === "return") {
				const t = results[selectedIndex];
				if (t) addToQueue(t);
				return;
			}
		}
		if (
			(key.ctrl && key.name === "c") ||
			((key.name === "q" || key.name === "escape") && focus !== "search")
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
			setPreview(null);
			setPlaying(false);
			setPaused(false);
			return;
		}
		if (key.name === "f" && focus !== "search") {
			const q = query.trim();
			if (q && q !== lastQueryRef.current) {
				doSearch(q);
			} else {
				loadMore();
			}
			return;
		}
		if (key.name === "n" && focus !== "search") {
			nextTrack();
			return;
		}
		if (key.name === "right" && focus !== "search") {
			seekRelative(10);
			setPosition((p) => Math.min(trackDuration || p + 10, p + 10));
			return;
		}
		if (key.name === "left" && focus !== "search") {
			seekRelative(-10);
			setPosition((p) => Math.max(0, p - 10));
			return;
		}
		if (key.name === "p" && focus !== "search") {
			prevTrack();
			return;
		}
		if (key.name === "d" && focus === "playlist") {
			const t = queue[playlistSelected];
			if (t) removeFromQueue(t.id);
			return;
		}
		if (key.name === "d" && focus === "results") {
			const t = results[selectedIndex];
			if (t && queue.some((q) => q.id === t.id)) removeFromQueue(t.id);
			return;
		}
		if (key.name === "x" && focus !== "search") {
			queueShuffle();
			return;
		}
		if (key.name === "y" && focus !== "search") {
			const t =
				focus === "results"
					? results[selectedIndex]
					: focus === "playlist"
						? queue[playlistSelected]
						: now;
			if (t) spawn(["open", t.url], { stdout: "ignore", stderr: "ignore" });
			return;
		}
		if (key.name === "i" && focus === "results") {
			const t = results[selectedIndex];
			if (t) previewFromResults(t);
			return;
		}
		if (key.name === "g" && focus !== "search" && queue.length > 0) {
			const i = focus === "playlist" ? playlistSelected : 0;
			jumpInQueue(i);
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

	const modeLabel = ` ${mode.toUpperCase()}${repeat ? " • REPEAT" : ""} • ? `;
	const searchW = playlistW;
	const topPanelInner = Math.max(0, termWidth - searchW - 6);
	const leftLabel = " YouTube Player ";
	const gap = Math.max(
		1,
		topPanelInner - leftLabel.length - modeLabel.length - 4,
	);
	const topTitle = `${leftLabel}${"─".repeat(gap)}${modeLabel}`;

	const queueLabel = now ? ` [${queueIndex + 1}/${queue.length}]` : "";
	const progressW = Math.max(10, topPanelInner - 14 - queueLabel.length);
	const totalSec = trackDuration > 0 ? trackDuration : (now?.duration ?? 0);
	const ratio =
		totalSec > 0 ? Math.min(1, Math.max(0, position / totalSec)) : 0;
	const filled = Math.round(progressW * ratio);
	const progressBar = `${"█".repeat(filled)}${"░".repeat(progressW - filled)}`;

	const titleLineW = Math.max(10, topPanelInner - 3);
	let nowTitleStr = "";
	let nowUploaderStr = "";
	if (now) {
		const fullTitle = now.title.normalize("NFKC");
		const fullUploader = now.uploader ? now.uploader.normalize("NFKC") : "";
		if (fullUploader) {
			const desiredUpW = Math.min(displayWidth(fullUploader), 24);
			const titleBudget = titleLineW - 3 - desiredUpW;
			if (titleBudget >= 10) {
				nowTitleStr = clip(fullTitle, titleBudget);
				nowUploaderStr = clip(fullUploader, desiredUpW);
			} else {
				nowTitleStr = clip(fullTitle, titleLineW);
			}
		} else {
			nowTitleStr = clip(fullTitle, titleLineW);
		}
	}

	const durW = 7;
	const viewsW = 7;
	const uploaderW = Math.max(8, Math.min(20, Math.floor(resultsW * 0.22)));
	const titleW = Math.max(10, resultsW - durW - viewsW - uploaderW - 8);

	const plDurW = 6;
	const plTitleW = Math.max(10, playlistW - plDurW - 6);

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			padding={1}
			backgroundColor={theme.bg}
		>
			<box flexDirection="row" minHeight={7} flexShrink={0}>
				<box
					flexGrow={1}
					flexBasis={resultsW}
					flexDirection="column"
					border
					borderColor={theme.border}
					title={topTitle}
					padding={1}
				>
					{now ? (
						<>
							<text>
								<span fg={paused ? theme.paused : theme.playing}>
									{paused ? "❚❚" : "▶ "}
								</span>{" "}
								{nowTitleStr}
								{nowUploaderStr ? (
									<span fg={theme.textMuted}> — {nowUploaderStr}</span>
								) : null}
							</text>
							<text>
								<span fg={theme.textMuted}>{fmtDur(position)} </span>
								<span fg={theme.accent}>{progressBar}</span>
								<span fg={theme.textMuted}> {fmtDur(totalSec)}</span>
								<span fg={theme.textMuted}>{queueLabel}</span>
							</text>
						</>
					) : (
						<text fg={theme.textMuted}>Nothing playing</text>
					)}
					<text fg={theme.textMuted}>{status}</text>
					{now ? null : <text fg={theme.textMuted}>? for keys</text>}
				</box>
				<box
					flexBasis={searchW}
					flexDirection="row"
					border
					borderColor={focus === "search" ? theme.borderFocus : theme.border}
					backgroundColor={focus === "search" ? theme.bgFocus : undefined}
					title=" Search "
					padding={1}
					alignItems="center"
					onMouseDown={() => setFocus("search")}
				>
					<input
						ref={inputRef}
						value={query}
						onInput={setQuery}
						onSubmit={(value) => {
							const v = typeof value === "string" ? value : query;
							setQuery(v);
							const q = v.trim();
							if (!q) return;
							setFocus("results");
							if (q === lastQueryRef.current) {
								loadMore();
							} else {
								doSearch(v);
							}
						}}
						placeholder="artist, song, album..."
						placeholderColor={theme.textMuted}
						flexGrow={1}
					/>
				</box>
			</box>

			<box flexDirection="row" flexGrow={1}>
				<box
					flexGrow={1}
					flexBasis={resultsW}
					flexDirection="column"
					border
					borderColor={focus === "results" ? theme.borderFocus : theme.border}
					backgroundColor={focus === "results" ? theme.bgFocus : undefined}
					title={` Results${results.length > 0 ? ` (${results.length})` : ""}${searching ? " (searching...)" : ""} `}
					onMouseDown={() => setFocus("results")}
				>
					{results.length > 0 ? (
						<>
							<text fg={theme.textMuted}>
								{`    ${fitCol("Title", titleW)}  ${fitCol("Uploader", uploaderW)}  ${"Views".padStart(viewsW, " ")}  ${"Length".padStart(durW, " ")}`}
							</text>
							<scrollbox
								ref={resultsScrollRef}
								flexGrow={1}
								rootOptions={{ backgroundColor: "transparent" }}
								wrapperOptions={{ backgroundColor: "transparent" }}
								viewportOptions={{ backgroundColor: "transparent" }}
								contentOptions={{ backgroundColor: "transparent" }}
							>
								{results.map((t, i) => {
									const isCursor = i === selectedIndex && focus === "results";
									const marker = pageMarker(t.page);
									const title = fitCol(t.title.normalize("NFKC"), titleW);
									const uploader = fitCol(
										(t.uploader ?? "").normalize("NFKC"),
										uploaderW,
									);
									const views = fmtCount(t.views).padStart(viewsW, " ");
									const duration = fmtDur(t.duration).padStart(durW, " ");
									return (
										<text
											key={t.id}
											id={`results-row-${t.id}`}
											bg={isCursor ? theme.bgRowSelected : undefined}
											fg={isCursor ? theme.textRowSelected : undefined}
											onMouseDown={() => {
												setFocus("results");
												setSelectedIndex(i);
												previewFromResults(t);
											}}
										>
											{`${isCursor ? "▶ " : "  "}${marker} ${title}  ${uploader}  ${views}  ${duration}`}
										</text>
									);
								})}
							</scrollbox>
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
					borderColor={focus === "playlist" ? theme.borderFocus : theme.border}
					backgroundColor={focus === "playlist" ? theme.bgFocus : undefined}
					title={` Playlist (${queue.length}) `}
					onMouseDown={() => setFocus("playlist")}
				>
					{queue.length > 0 ? (
						<scrollbox
							ref={playlistScrollRef}
							flexGrow={1}
							rootOptions={{ backgroundColor: "transparent" }}
							wrapperOptions={{ backgroundColor: "transparent" }}
							viewportOptions={{ backgroundColor: "transparent" }}
							contentOptions={{ backgroundColor: "transparent" }}
						>
							{queue.map((t, i) => {
								const isPlaying = i === queueIndex && playing;
								const isCursor = i === playlistSelected && focus === "playlist";
								const title = fitCol(t.title.normalize("NFKC"), plTitleW);
								const duration = fmtDur(t.duration).padStart(plDurW, " ");
								return (
									<text
										key={t.id}
										id={`playlist-row-${t.id}`}
										bg={
											isPlaying
												? theme.bgPlaying
												: isCursor
													? theme.bgRowSelected
													: undefined
										}
										fg={
											isPlaying || isCursor ? theme.textRowSelected : undefined
										}
										onMouseDown={() => {
											setFocus("playlist");
											setPlaylistSelected(i);
											jumpInQueue(i);
										}}
									>
										{`${isCursor ? "▶ " : "  "}${title}  ${duration}`}
									</text>
								);
							})}
						</scrollbox>
					) : (
						<box padding={1}>
							<text fg={theme.textMuted}>Empty. Enter on a result to add.</text>
						</box>
					)}
				</box>
			</box>

			{showHelp ? (
				<box
					position="absolute"
					top={6}
					left={4}
					right={4}
					border
					backgroundColor={theme.bg}
					title=" Keys "
					padding={1}
					flexDirection="column"
				>
					<box flexDirection="row">
						<box flexDirection="column" flexGrow={1}>
							{HELP_LEFT.map(([k, h]) => (
								<text key={k}>
									<span fg={theme.keyHint}>{fitCol(k, HELP_LEFT_KEY_W)}</span>
									<span fg={theme.textMuted}>{h}</span>
								</text>
							))}
						</box>
						<box flexDirection="column" flexGrow={1}>
							{HELP_RIGHT.map(([k, h]) => (
								<text key={k}>
									<span fg={theme.keyHint}>{fitCol(k, HELP_RIGHT_KEY_W)}</span>
									<span fg={theme.textMuted}>{h}</span>
								</text>
							))}
						</box>
					</box>
					<text> </text>
					<text fg={theme.textMuted}>? or Esc to close</text>
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
