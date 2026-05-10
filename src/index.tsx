import {
	existsSync,
	mkdirSync,
	readdirSync,
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
import { type Subprocess, spawn } from "bun";
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
	queueSet,
	queueShuffle,
	seekAbsolute,
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
const PLAYLIST_DIR = join(CACHE_DIR, "playlists");
const ACTIVE_FILE = join(CACHE_DIR, "active.json");

type ActiveAssoc = { name: string; trackIds: string[] };

function saveActiveAssoc(assoc: ActiveAssoc | null) {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		if (assoc) {
			writeFileSync(ACTIVE_FILE, JSON.stringify(assoc));
		} else if (existsSync(ACTIVE_FILE)) {
			unlinkSync(ACTIVE_FILE);
		}
	} catch {}
}

function loadActiveAssoc(): ActiveAssoc | null {
	try {
		if (!existsSync(ACTIVE_FILE)) return null;
		const j = JSON.parse(readFileSync(ACTIVE_FILE, "utf8")) as ActiveAssoc;
		if (typeof j.name !== "string" || !Array.isArray(j.trackIds)) return null;
		return j;
	} catch {
		return null;
	}
}

type SearchCache = { query: string; results: Track[] };

type PlaylistEntry = { name: string; slug: string; count: number };

function slugify(name: string): string {
	const s = name
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "untitled";
}

function listPlaylists(): PlaylistEntry[] {
	try {
		if (!existsSync(PLAYLIST_DIR)) return [];
		const files = readdirSync(PLAYLIST_DIR).filter((f) => f.endsWith(".json"));
		const entries: PlaylistEntry[] = [];
		for (const file of files) {
			try {
				const raw = readFileSync(join(PLAYLIST_DIR, file), "utf8");
				const j = JSON.parse(raw) as { name?: string; tracks?: Track[] };
				const name = typeof j.name === "string" ? j.name : file.slice(0, -5);
				const tracks = Array.isArray(j.tracks) ? j.tracks : [];
				entries.push({ name, slug: file.slice(0, -5), count: tracks.length });
			} catch {}
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		return entries;
	} catch {
		return [];
	}
}

function savePlaylist(name: string, tracks: Track[]): string | null {
	const trimmed = name.trim();
	if (!trimmed) return null;
	try {
		mkdirSync(PLAYLIST_DIR, { recursive: true });
		const slug = slugify(trimmed);
		writeFileSync(
			join(PLAYLIST_DIR, `${slug}.json`),
			JSON.stringify({ name: trimmed, tracks }),
		);
		return slug;
	} catch {
		return null;
	}
}

function loadPlaylist(slug: string): { name: string; tracks: Track[] } | null {
	try {
		const raw = readFileSync(join(PLAYLIST_DIR, `${slug}.json`), "utf8");
		const j = JSON.parse(raw) as { name?: string; tracks?: Track[] };
		const tracks = Array.isArray(j.tracks) ? j.tracks : [];
		const name = typeof j.name === "string" ? j.name : slug;
		return { name, tracks };
	} catch {
		return null;
	}
}

function findPlaylistMatchingTrackIds(
	trackIds: string[],
): { name: string; slug: string } | null {
	try {
		if (!existsSync(PLAYLIST_DIR)) return null;
		const files = readdirSync(PLAYLIST_DIR).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			try {
				const raw = readFileSync(join(PLAYLIST_DIR, file), "utf8");
				const j = JSON.parse(raw) as { name?: string; tracks?: Track[] };
				const tracks = Array.isArray(j.tracks) ? j.tracks : [];
				if (
					tracks.length === trackIds.length &&
					tracks.every((t, i) => t.id === trackIds[i])
				) {
					const slug = file.slice(0, -5);
					const name = typeof j.name === "string" ? j.name : slug;
					return { name, slug };
				}
			} catch {}
		}
		return null;
	} catch {
		return null;
	}
}

function deletePlaylist(slug: string): boolean {
	try {
		const path = join(PLAYLIST_DIR, `${slug}.json`);
		if (existsSync(path)) unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

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

const MIN_PAGE_SIZE = 20;
// Vertical chrome above the results scrollbox: outer padding(2) + top row(4)
// + results border(2) + header(1) ≈ 9 rows.
const RESULTS_VERTICAL_CHROME = 9;

async function searchYouTube(
	query: string,
	count: number,
	page: number,
	signal: AbortSignal,
): Promise<Track[]> {
	let proc: Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = spawn({
			cmd: [
				"yt-dlp",
				`ytsearch${count}:${query}`,
				"--flat-playlist",
				"--dump-json",
				"--no-warnings",
			],
			stdout: "pipe",
			stderr: "pipe",
			signal,
		});
	} catch (e) {
		throw new Error(
			`failed to launch yt-dlp (is it installed?): ${(e as Error).message}`,
		);
	}
	const [text, errText, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0 && !signal.aborted) {
		const msg = errText.trim().split("\n").pop() ?? `exit ${exitCode}`;
		throw new Error(`yt-dlp: ${msg}`);
	}
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
	["c", "clear results / clear playlist"],
	["P", "playlists: save / load / delete"],
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
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [playlistSelected, setPlaylistSelected] = useState(0);
	const [showHelp, setShowHelp] = useState(false);
	const [playlistName, setPlaylistName] = useState<string | null>(null);
	const [playlistDirty, setPlaylistDirty] = useState(false);
	const [showPlaylists, setShowPlaylists] = useState(false);
	const [plEntries, setPlEntries] = useState<PlaylistEntry[]>([]);
	const [plModalFocus, setPlModalFocus] = useState<"input" | "list">("list");
	const [plName, setPlName] = useState("");
	const [plSelected, setPlSelected] = useState(0);
	const [plDeleteArmedSlug, setPlDeleteArmedSlug] = useState<string | null>(
		null,
	);
	const abortRef = useRef<AbortController | null>(null);
	const inputRef = useRef<InputRenderable | null>(null);
	const plInputRef = useRef<InputRenderable | null>(null);
	const resultsScrollRef = useRef<ScrollBoxRenderable | null>(null);
	const playlistScrollRef = useRef<ScrollBoxRenderable | null>(null);
	const { width: termWidth, height: termHeight } = useTerminalDimensions();
	const pageSize = Math.max(
		MIN_PAGE_SIZE,
		termHeight - RESULTS_VERTICAL_CHROME,
	);
	const pageSizeRef = useRef(pageSize);
	pageSizeRef.current = pageSize;

	useEffect(() => {
		if (focus === "search") inputRef.current?.focus();
		else inputRef.current?.blur();
	}, [focus]);

	useEffect(() => {
		if (showPlaylists && plModalFocus === "input") {
			plInputRef.current?.focus();
		} else {
			plInputRef.current?.blur();
		}
	}, [showPlaylists, plModalFocus]);

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
				if (q.length === 0) {
					saveActiveAssoc(null);
				} else {
					const assoc = loadActiveAssoc();
					if (assoc) {
						setPlaylistName(assoc.name);
						const same =
							q.length === assoc.trackIds.length &&
							q.every((t, i) => t.id === assoc.trackIds[i]);
						setPlaylistDirty(!same);
					} else {
						const match = findPlaylistMatchingTrackIds(q.map((t) => t.id));
						if (match) {
							setPlaylistName(match.name);
							setPlaylistDirty(false);
							saveActiveAssoc({
								name: match.name,
								trackIds: q.map((t) => t.id),
							});
						}
					}
				}
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
		try {
			const tracks = await searchYouTube(q, pageSizeRef.current, 1, ac.signal);
			lastQueryRef.current = q;
			const sorted = sortByViewsDesc(tracks);
			setResults(sorted);
			saveSearch({ query: q, results: sorted });
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
		const target = have + pageSizeRef.current;
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
				return;
			}
			setResults((cur) => {
				const merged = sortByViewsDesc([...cur, ...fresh]);
				saveSearch({ query: q, results: merged });
				return merged;
			});
		} catch (e) {
			const err = e as { name?: string; message?: string };
			if (err.name !== "AbortError") setError(String(err.message ?? e));
		} finally {
			setSearching(false);
		}
	};

	const addToQueue = async (t: Track) => {
		setQueue((cur) => {
			if (cur.some((q) => q.id === t.id)) return cur;
			setPlaylistDirty(true);
			return [...cur, t];
		});
		await queueAdd(t);
	};

	const previewFromResults = async (t: Track) => {
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

	const openPlaylistModal = () => {
		const entries = listPlaylists();
		setPlEntries(entries);
		setPlName(playlistName ?? "");
		setPlDeleteArmedSlug(null);
		const unsaved =
			playlistDirty || (playlistName === null && queue.length > 0);
		const initialFocus: "input" | "list" =
			unsaved || entries.length === 0 ? "input" : "list";
		setPlModalFocus(initialFocus);
		const cur = playlistName
			? entries.findIndex((e) => e.name === playlistName)
			: -1;
		setPlSelected(cur >= 0 ? cur : 0);
		setShowPlaylists(true);
	};

	const closePlaylistModal = () => {
		setShowPlaylists(false);
		setPlDeleteArmedSlug(null);
	};

	const doSavePlaylist = () => {
		const name = plName.trim();
		if (!name) return;
		const sameName = playlistName === name;
		if (sameName && !playlistDirty) {
			return;
		}
		const slug = savePlaylist(name, queue);
		if (!slug) {
			return;
		}
		const renaming = !sameName && !playlistDirty && playlistName !== null;
		if (renaming && playlistName) {
			const oldSlug = slugify(playlistName);
			if (oldSlug !== slug) deletePlaylist(oldSlug);
		}
		setPlaylistName(name);
		setPlaylistDirty(false);
		saveActiveAssoc({ name, trackIds: queue.map((t) => t.id) });
		const refreshed = listPlaylists();
		setPlEntries(refreshed);
		const i = refreshed.findIndex((e) => e.slug === slug);
		if (i >= 0) setPlSelected(i);
		setPlModalFocus("list");
	};

	const doLoadPlaylist = async (entry: PlaylistEntry) => {
		const data = loadPlaylist(entry.slug);
		if (!data) {
			return;
		}
		const sameTracks =
			queue.length === data.tracks.length &&
			queue.every((t, i) => t.id === data.tracks[i]?.id);
		if (sameTracks) {
			setPlaylistName(data.name);
			setPlaylistDirty(false);
			saveActiveAssoc({
				name: data.name,
				trackIds: data.tracks.map((t) => t.id),
			});
			closePlaylistModal();
			return;
		}
		await queueSet(data.tracks);
		setQueue(data.tracks);
		setQueueIndex(-1);
		setPreview(null);
		setPlaying(false);
		setPaused(false);
		setPlaylistSelected(0);
		setPlaylistName(data.name);
		setPlaylistDirty(false);
		saveActiveAssoc({
			name: data.name,
			trackIds: data.tracks.map((t) => t.id),
		});
		closePlaylistModal();
	};

	const doDeletePlaylist = (entry: PlaylistEntry) => {
		if (plDeleteArmedSlug !== entry.slug) {
			setPlDeleteArmedSlug(entry.slug);
			return;
		}
		const ok = deletePlaylist(entry.slug);
		setPlDeleteArmedSlug(null);
		if (!ok) {
			return;
		}
		if (playlistName === entry.name) {
			setPlaylistName(null);
			setPlaylistDirty(queue.length > 0);
			saveActiveAssoc(null);
		}
		const refreshed = listPlaylists();
		setPlEntries(refreshed);
		setPlSelected((c) => Math.max(0, Math.min(refreshed.length - 1, c)));
		if (refreshed.length === 0) setPlModalFocus("input");
	};

	const removeFromQueue = async (id: string) => {
		await queueRemove(id);
		setQueue((cur) => {
			const i = cur.findIndex((t) => t.id === id);
			if (i < 0) return cur;
			const next = cur.filter((t) => t.id !== id);
			if (next.length === 0) {
				setPlaylistDirty(false);
				setPlaylistName(null);
				saveActiveAssoc(null);
			} else {
				setPlaylistDirty(true);
			}
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
		if (showPlaylists) {
			if (key.name === "escape") {
				closePlaylistModal();
				return;
			}
			if (key.name === "tab") {
				setPlModalFocus((f) => (f === "input" ? "list" : "input"));
				return;
			}
			if (plModalFocus === "list" && plEntries.length > 0) {
				if (key.name === "up" || key.name === "k") {
					setPlSelected((c) => Math.max(0, c - 1));
					setPlDeleteArmedSlug(null);
					return;
				}
				if (key.name === "down" || key.name === "j") {
					setPlSelected((c) => Math.min(plEntries.length - 1, c + 1));
					setPlDeleteArmedSlug(null);
					return;
				}
				if (key.name === "return") {
					const e = plEntries[plSelected];
					if (e) doLoadPlaylist(e);
					return;
				}
				if (key.name === "d") {
					const e = plEntries[plSelected];
					if (e) doDeletePlaylist(e);
					return;
				}
			}
			return;
		}
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
		if (key.shift && key.name === "p" && focus !== "search") {
			openPlaylistModal();
			return;
		}
		if (key.name === "tab") {
			setFocus((f) =>
				f === "search" ? "results" : f === "results" ? "playlist" : "search",
			);
			return;
		}
		if ((key.name === "h" || key.name === "l") && focus !== "search") {
			setFocus((f) => (f === "results" ? "playlist" : "results"));
			return;
		}
		if (focus === "playlist" && queue.length > 0) {
			if (key.name === "up" || key.name === "k") {
				setPlaylistSelected((c) => Math.max(0, c - 1));
				return;
			}
			if (key.name === "down" || key.name === "j") {
				setPlaylistSelected((c) => Math.min(queue.length - 1, c + 1));
				return;
			}
			if (key.name === "return") {
				jumpInQueue(playlistSelected);
				return;
			}
		}
		if (focus === "results" && results.length > 0) {
			if (key.name === "up" || key.name === "k") {
				setSelectedIndex((c) => Math.max(0, c - 1));
				return;
			}
			if (key.name === "down" || key.name === "j") {
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
			setPlaylistName(null);
			setPlaylistDirty(false);
			saveActiveAssoc(null);
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
				setPlaylistDirty(true);
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
				setPlaylistDirty(true);
				queueMove(from, to);
			}
			return;
		}
		if (key.name === "c" && focus === "results") {
			setResults([]);
			setSelectedIndex(0);
			setError(null);
			lastQueryRef.current = "";
			saveSearch(null);
			setFocus("search");
			return;
		}
	});

	const MIN_WIDTH = 80;
	const MIN_HEIGHT = 20;
	if (termWidth < MIN_WIDTH || termHeight < MIN_HEIGHT) {
		return (
			<box
				flexDirection="column"
				flexGrow={1}
				backgroundColor={theme.bg}
				justifyContent="center"
				alignItems="center"
			>
				<text fg={theme.text}>YouTube Player</text>
				<text fg={theme.textMuted}>
					Terminal too small (min {MIN_WIDTH}x{MIN_HEIGHT})
				</text>
			</box>
		);
	}

	// Layout: results pane gets ~60%, playlist pane ~40%.
	const inner = Math.max(52, termWidth - 8);
	const resultsW = Math.floor(inner * 0.6);
	const playlistW = inner - resultsW;

	const modeLabel = ` ${repeat ? "REPEAT • " : ""}${mode.toUpperCase()} `;
	const searchW = playlistW;
	const topPanelInner = Math.max(0, termWidth - searchW - 6);
	const leftLabel = " YouTube Player ";
	const gap = Math.max(1, topPanelInner - leftLabel.length - modeLabel.length);
	const topTitle = `${leftLabel}${"─".repeat(gap)}${modeLabel}`;

	const searchLeftLabel = " Search ";
	const searchRightLabel = " ? ";
	const searchGap = Math.max(
		1,
		searchW - searchLeftLabel.length - searchRightLabel.length - 4,
	);
	const searchTitle = `${searchLeftLabel}${"─".repeat(searchGap)}${searchRightLabel}`;

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
	const plTitleW = Math.max(10, playlistW - plDurW - 5);

	const playlistUnsaved =
		playlistDirty || (playlistName === null && queue.length > 0);
	const plPrefix = `${playlistUnsaved ? "* " : ""}Playlist`;
	const plCountSuffix = queue.length > 0 ? ` (${queue.length}) ` : " ";
	const plNameBudget = Math.max(
		0,
		playlistW - 4 - displayWidth(plPrefix) - 2 - displayWidth(plCountSuffix),
	);
	const plNamePart =
		playlistName && plNameBudget >= 4
			? `: ${clip(playlistName, plNameBudget)}`
			: "";
	const playlistTitle = ` ${plPrefix}${plNamePart}${plCountSuffix}`;

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			padding={1}
			backgroundColor={theme.bg}
		>
			<box flexDirection="row" minHeight={4} flexShrink={0}>
				<box
					flexGrow={1}
					flexBasis={resultsW}
					flexDirection="column"
					border
					borderColor={theme.border}
					title={topTitle}
					paddingLeft={1}
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
							<box flexDirection="row">
								<text fg={theme.textMuted}>{fmtDur(position)} </text>
								<text
									fg={theme.accent}
									onMouseDown={(e) => {
										if (totalSec <= 0 || progressW <= 0) return;
										const target = e.target;
										if (!target) return;
										const rel = e.x - target.screenX;
										const ratio = Math.max(0, Math.min(1, rel / progressW));
										const newPos = ratio * totalSec;
										seekAbsolute(newPos);
										setPosition(newPos);
									}}
								>
									{progressBar}
								</text>
								<text fg={theme.textMuted}>
									{` ${fmtDur(totalSec)}${queueLabel}`}
								</text>
							</box>
						</>
					) : (
						<text fg={theme.textMuted}>Nothing playing</text>
					)}
				</box>
				<box
					flexBasis={searchW}
					flexDirection="row"
					border
					borderColor={focus === "search" ? theme.borderFocus : theme.border}
					backgroundColor={focus === "search" ? theme.bgFocus : undefined}
					title={searchTitle}
					paddingLeft={1}
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
							<text fg={theme.textMuted} wrapMode="none">
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
											wrapMode="none"
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
					title={playlistTitle}
					onMouseDown={() => setFocus("playlist")}
				>
					{queue.length > 0 ? (
						<>
							<text fg={theme.textMuted} wrapMode="none">
								{`  ${fitCol("Title", plTitleW)} ${"Length".padStart(plDurW, " ")}`}
							</text>
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
									const isCursor =
										i === playlistSelected && focus === "playlist";
									const title = fitCol(t.title.normalize("NFKC"), plTitleW);
									const duration = fmtDur(t.duration).padStart(plDurW, " ");
									return (
										<text
											key={t.id}
											id={`playlist-row-${t.id}`}
											wrapMode="none"
											bg={
												isPlaying
													? theme.bgPlaying
													: isCursor
														? theme.bgRowSelected
														: undefined
											}
											fg={
												isPlaying || isCursor
													? theme.textRowSelected
													: undefined
											}
											onMouseDown={() => {
												setFocus("playlist");
												setPlaylistSelected(i);
												jumpInQueue(i);
											}}
										>
											{`${isCursor ? "▶ " : "  "}${title} ${duration}`}
										</text>
									);
								})}
							</scrollbox>
						</>
					) : (
						<box padding={1}>
							<text fg={theme.textMuted}>Empty. Enter on a result to add.</text>
						</box>
					)}
				</box>
			</box>

			{showPlaylists ? (
				<box
					position="absolute"
					top={4}
					left={6}
					right={6}
					border
					backgroundColor={theme.bg}
					title=" Playlists "
					padding={1}
					flexDirection="column"
				>
					<box
						flexDirection="row"
						border
						borderColor={
							plModalFocus === "input" ? theme.borderFocus : theme.border
						}
						backgroundColor={
							plModalFocus === "input" ? theme.bgFocus : undefined
						}
						paddingLeft={1}
						paddingRight={1}
						alignItems="center"
						onMouseDown={() => setPlModalFocus("input")}
					>
						<text fg={theme.textMuted}>Save current queue as: </text>
						<input
							ref={plInputRef}
							value={plName}
							onInput={setPlName}
							onSubmit={() => doSavePlaylist()}
							placeholder={
								queue.length > 0 ? "playlist name..." : "queue is empty"
							}
							placeholderColor={theme.textMuted}
							flexGrow={1}
						/>
					</box>
					<text> </text>
					<box
						flexDirection="column"
						flexGrow={1}
						border
						borderColor={
							plModalFocus === "list" ? theme.borderFocus : theme.border
						}
						backgroundColor={
							plModalFocus === "list" ? theme.bgFocus : undefined
						}
						onMouseDown={() => setPlModalFocus("list")}
					>
						{plEntries.length > 0 ? (
							plEntries.map((e, i) => {
								const isCursor = i === plSelected && plModalFocus === "list";
								const armed = plDeleteArmedSlug === e.slug;
								return (
									<text
										key={e.slug}
										bg={isCursor ? theme.bgRowSelected : undefined}
										fg={isCursor ? theme.textRowSelected : undefined}
										onMouseDown={() => {
											setPlModalFocus("list");
											setPlSelected(i);
										}}
									>
										{`${isCursor ? "▶ " : "  "}${e.name}  (${e.count})${armed ? "  — press d to confirm" : ""}`}
									</text>
								);
							})
						) : (
							<box padding={1}>
								<text fg={theme.textMuted}>
									No saved playlists. Type a name above and Enter to save.
								</text>
							</box>
						)}
					</box>
					<text> </text>
					<box flexDirection="row">
						<box flexDirection="column" flexGrow={1}>
							{(plModalFocus === "input"
								? ([
										["Enter", "save current queue"],
										["Tab", "focus list"],
									] as [string, string][])
								: ([
										["Enter", "load playlist"],
										["d", "delete (press twice)"],
										["Tab", "focus name input"],
									] as [string, string][])
							).map(([k, h]) => (
								<text key={k}>
									<span fg={theme.keyHint}>{fitCol(k, 8)}</span>
									<span fg={theme.textMuted}>{h}</span>
								</text>
							))}
						</box>
						<box flexDirection="column" flexGrow={1}>
							{(plModalFocus === "list"
								? ([
										["↑ ↓ / j k", "navigate list"],
										["Esc", "close"],
									] as [string, string][])
								: ([["Esc", "close"]] as [string, string][])
							).map(([k, h]) => (
								<text key={k}>
									<span fg={theme.keyHint}>{fitCol(k, 12)}</span>
									<span fg={theme.textMuted}>{h}</span>
								</text>
							))}
						</box>
					</box>
				</box>
			) : null}
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
					<text fg={theme.textMuted}>Esc to close</text>
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
