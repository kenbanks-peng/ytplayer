import {
	createCliRenderer,
	type InputRenderable,
	type ScrollBoxRenderable,
} from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type Subprocess, spawn } from "bun";
import { useEffect, useRef, useState } from "react";
import {
	loadActiveAssoc,
	loadSearch,
	saveActiveAssoc,
	saveSearch,
} from "./cache";
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
import {
	deletePlaylist,
	findPlaylistMatchingTrackIds,
	listPlaylists,
	loadPlaylist,
	type PlaylistEntry,
	sameTrackIdSet,
	savePlaylist,
} from "./playlists";
import type { PlayMode, Track } from "./protocol";
import { runServer } from "./server";
import { clip, displayWidth, fitCol, fmtCount, fmtDur, slugify } from "./text";
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

type Focus = "results" | "playlist";

function scrollCursorIntoView<T extends { id: string }>(
	sb: ScrollBoxRenderable | null,
	rows: T[],
	cursorIndex: number,
	rowIdPrefix: string,
	direction: number,
	padding = 2,
) {
	if (!sb || cursorIndex < 0 || cursorIndex >= rows.length) return;
	const cursorRow = rows[cursorIndex];
	if (!cursorRow) return;
	const padIndex =
		direction >= 0
			? Math.min(rows.length - 1, cursorIndex + padding)
			: Math.max(0, cursorIndex - padding);
	const padRow = rows[padIndex];
	sb.scrollChildIntoView(`${rowIdPrefix}${cursorRow.id}`);
	if (padRow && padIndex !== cursorIndex) {
		sb.scrollChildIntoView(`${rowIdPrefix}${padRow.id}`);
	}
}

const HELP_LEFT: [string, string][] = [
	["/", "open search"],
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
	const [focus, setFocus] = useState<Focus>("results");
	const [showSearchModal, setShowSearchModal] = useState(false);
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
	const [baselineTrackIds, setBaselineTrackIds] = useState<string[] | null>(
		null,
	);
	const playlistDirty =
		baselineTrackIds !== null &&
		!sameTrackIdSet(
			queue.map((t) => t.id),
			baselineTrackIds,
		);
	const [showPlaylists, setShowPlaylists] = useState(false);
	const [plEntries, setPlEntries] = useState<PlaylistEntry[]>([]);
	const [plModalFocus, setPlModalFocus] = useState<"input" | "list">("list");
	const [plName, setPlName] = useState("");
	const [plSelected, setPlSelected] = useState(0);
	const [plDeleteArmedSlug, setPlDeleteArmedSlug] = useState<string | null>(
		null,
	);
	const abortRef = useRef<AbortController | null>(null);
	const lastActionAtRef = useRef(0);
	const inputRef = useRef<InputRenderable | null>(null);
	const plInputRef = useRef<InputRenderable | null>(null);
	const resultsScrollRef = useRef<ScrollBoxRenderable | null>(null);
	const playlistScrollRef = useRef<ScrollBoxRenderable | null>(null);
	const prevSelectedIndexRef = useRef(0);
	const prevPlaylistSelectedRef = useRef(0);
	const { width: termWidth, height: termHeight } = useTerminalDimensions();
	const pageSize = Math.max(
		MIN_PAGE_SIZE,
		termHeight - RESULTS_VERTICAL_CHROME,
	);
	const pageSizeRef = useRef(pageSize);
	pageSizeRef.current = pageSize;

	useEffect(() => {
		if (showSearchModal) inputRef.current?.focus();
		else inputRef.current?.blur();
	}, [showSearchModal]);

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
						setBaselineTrackIds(assoc.trackIds);
					} else {
						const match = findPlaylistMatchingTrackIds(q.map((t) => t.id));
						if (match) {
							setPlaylistName(match.name);
							const ids = q.map((t) => t.id);
							setBaselineTrackIds(ids);
							saveActiveAssoc({ name: match.name, trackIds: ids });
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
			} else if (q.length === 0) {
				setShowSearchModal(true);
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
			const sinceAction = Date.now() - lastActionAtRef.current;
			if (sinceAction > 1500) {
				setQueueIndex(idx);
				setPreview(state.preview ?? null);
				setPaused(Boolean(state.paused));
				setPosition(typeof state.position === "number" ? state.position : 0);
				setTrackDuration(
					typeof state.duration === "number" ? state.duration : 0,
				);
			}
			setPlaying(Boolean(state.playing));
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

	useEffect(() => {
		const dir = Math.sign(selectedIndex - prevSelectedIndexRef.current) || 1;
		prevSelectedIndexRef.current = selectedIndex;
		scrollCursorIntoView(
			resultsScrollRef.current,
			results,
			selectedIndex,
			"results-row-",
			dir,
		);
	}, [selectedIndex, results]);

	useEffect(() => {
		const dir =
			Math.sign(playlistSelected - prevPlaylistSelectedRef.current) || 1;
		prevPlaylistSelectedRef.current = playlistSelected;
		scrollCursorIntoView(
			playlistScrollRef.current,
			queue,
			playlistSelected,
			"playlist-row-",
			dir,
		);
	}, [playlistSelected, queue]);

	useEffect(() => {
		if (queueIndex >= 0) setPlaylistSelected(queueIndex);
	}, [queueIndex]);

	const nowId = now?.id;
	useEffect(() => {
		if (!nowId) return;
		const idx = results.findIndex((t) => t.id === nowId);
		if (idx >= 0) setSelectedIndex(idx);
	}, [nowId, results]);

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
			return [...cur, t];
		});
		await queueAdd(t);
	};

	const previewFromResults = async (t: Track) => {
		lastActionAtRef.current = Date.now();
		setPreview(t);
		setQueueIndex(-1);
		setPaused(false);
		setPosition(0);
		setTrackDuration(0);
		await queuePreview(t);
	};

	const jumpInQueue = async (i: number) => {
		if (i < 0 || i >= queue.length) return;
		lastActionAtRef.current = Date.now();
		setQueueIndex(i);
		setPaused(false);
		setPosition(0);
		setTrackDuration(0);
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
		const ids = queue.map((t) => t.id);
		setBaselineTrackIds(ids);
		saveActiveAssoc({ name, trackIds: ids });
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
		const sameTracks = sameTrackIdSet(
			queue.map((t) => t.id),
			data.tracks.map((t) => t.id),
		);
		const ids = data.tracks.map((t) => t.id);
		if (sameTracks) {
			setPlaylistName(data.name);
			setBaselineTrackIds(ids);
			saveActiveAssoc({ name: data.name, trackIds: ids });
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
		setBaselineTrackIds(ids);
		saveActiveAssoc({ name: data.name, trackIds: ids });
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
			setBaselineTrackIds(null);
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
				setBaselineTrackIds(null);
				setPlaylistName(null);
				saveActiveAssoc(null);
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
		if (showSearchModal) {
			if (key.name === "escape") {
				setShowSearchModal(false);
				return;
			}
			return;
		}
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
		if (key.name === "?" || (key.shift && key.name === "/")) {
			setShowHelp((s) => !s);
			return;
		}
		if (key.name === "escape" && showHelp) {
			setShowHelp(false);
			return;
		}
		if (key.name === "/") {
			setFocus("results");
			setShowSearchModal(true);
			return;
		}
		if (key.shift && key.name === "p") {
			openPlaylistModal();
			return;
		}
		if (key.name === "tab" || key.name === "h" || key.name === "l") {
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
			key.name === "q" ||
			key.name === "escape"
		) {
			process.nextTick(() => shutdown(0));
			return;
		}
		if (key.name === "space") {
			(async () => {
				const resp = await togglePause();
				if (resp) setPaused(resp.paused);
			})();
			return;
		}
		if (key.name === "m") {
			const next: PlayMode = mode === "audio" ? "video" : "audio";
			setMode(next);
			setModeOnServer(next);
			return;
		}
		if (key.name === "r") {
			const next = !repeat;
			setRepeatState(next);
			setRepeat(next);
			return;
		}
		if (key.name === "s") {
			stopPlayback();
			setQueueIndex(-1);
			setPreview(null);
			setPlaying(false);
			setPaused(false);
			return;
		}
		if (key.name === "f") {
			const q = query.trim();
			if (q && q !== lastQueryRef.current) {
				doSearch(q);
			} else {
				loadMore();
			}
			return;
		}
		if (key.name === "n") {
			if (focus === "results") {
				if (results.length === 0) return;
				const next = Math.min(results.length - 1, selectedIndex + 1);
				if (next !== selectedIndex) {
					const t = results[next];
					if (t) {
						setSelectedIndex(next);
						previewFromResults(t);
					}
				}
			} else {
				nextTrack();
			}
			return;
		}
		if (key.name === "right") {
			seekRelative(10);
			setPosition((p) => Math.min(trackDuration || p + 10, p + 10));
			return;
		}
		if (key.name === "left") {
			seekRelative(-10);
			setPosition((p) => Math.max(0, p - 10));
			return;
		}
		if (key.name === "p") {
			if (focus === "results") {
				if (results.length === 0) return;
				const prev = Math.max(0, selectedIndex - 1);
				if (prev !== selectedIndex) {
					const t = results[prev];
					if (t) {
						setSelectedIndex(prev);
						previewFromResults(t);
					}
				}
			} else {
				prevTrack();
			}
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
		if (key.name === "x") {
			queueShuffle();
			return;
		}
		if (key.name === "y") {
			const t =
				focus === "results" ? results[selectedIndex] : queue[playlistSelected];
			if (t) spawn(["open", t.url], { stdout: "ignore", stderr: "ignore" });
			return;
		}
		if (key.name === "i" && focus === "results") {
			const t = results[selectedIndex];
			if (t) previewFromResults(t);
			return;
		}
		if (key.name === "g" && queue.length > 0) {
			const i = focus === "playlist" ? playlistSelected : 0;
			jumpInQueue(i);
			setFocus("playlist");
			return;
		}
		if (key.name === "c" && focus === "playlist") {
			queueClear();
			setQueue([]);
			setQueueIndex(-1);
			setPlaylistSelected(0);
			setPlaylistName(null);
			setBaselineTrackIds(null);
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
			lastQueryRef.current = "";
			saveSearch(null);
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

	// Layout: three stacked full-width panels — Player / Playlist / Results.
	const inner = Math.max(60, termWidth - 8);
	const panelInner = Math.max(0, inner - 4);

	const totalSec = trackDuration > 0 ? trackDuration : (now?.duration ?? 0);
	const posStr = fmtDur(position);
	const totStr = fmtDur(totalSec);
	const progressSideW = posStr.length + totStr.length + 8;
	const progressW = Math.max(10, termWidth - 3 - progressSideW);
	const ratio =
		totalSec > 0 ? Math.min(1, Math.max(0, position / totalSec)) : 0;
	const filled = Math.round(progressW * ratio);
	const progressBar = `${"█".repeat(filled)}${"░".repeat(progressW - filled)}`;
	const previewing = queueIndex === -1 && !!preview;
	const progressEl = (
		<box flexDirection="row" flexShrink={0} marginTop={1}>
			<text fg={paused ? theme.paused : theme.playing}>
				{paused ? " ❚❚ " : " ▶  "}
			</text>
			<text fg={theme.textMuted}>{`${posStr} `}</text>
			<text
				fg={theme.accent}
				onMouseDown={(e) => {
					if (totalSec <= 0 || progressW <= 0) return;
					const target = e.target;
					if (!target) return;
					const rel = e.x - target.screenX;
					const r = Math.max(0, Math.min(1, rel / progressW));
					const newPos = r * totalSec;
					seekAbsolute(newPos);
					setPosition(newPos);
				}}
			>
				{progressBar}
			</text>
			<text fg={theme.textMuted}>{` ${totStr} `}</text>
		</box>
	);

	const durW = 7;
	const viewsW = 7;
	const uploaderW = Math.max(12, Math.min(28, Math.floor(panelInner * 0.2)));
	const titleW = Math.max(10, panelInner - durW - viewsW - uploaderW - 4);

	const plDurW = 6;
	const plTitleW = Math.max(10, termWidth - plDurW - 9);

	const playlistUnsaved =
		playlistDirty || (playlistName === null && queue.length > 0);
	const plPrefix = `${playlistUnsaved ? "* " : ""}Local Playlist`;
	const plCountSuffix = queue.length > 0 ? ` (${queue.length}) ` : "";
	const plRightLabel = ` ${repeat ? "REPEAT • " : ""}${mode.toUpperCase()} • ? `;
	const plTitleBarW = Math.max(0, termWidth - 6);
	const plNameBudget = Math.max(
		0,
		plTitleBarW -
			displayWidth(plPrefix) -
			2 -
			displayWidth(plCountSuffix) -
			plRightLabel.length -
			4,
	);
	const plNamePart =
		playlistName && plNameBudget >= 4
			? `: ${clip(playlistName, plNameBudget)}`
			: "";
	const plLeftLabel = ` ${plPrefix}${plNamePart}${plCountSuffix} `;
	const plGap = Math.max(
		1,
		plTitleBarW - plLeftLabel.length - plRightLabel.length,
	);
	const playlistTitle = `${plLeftLabel}${"─".repeat(plGap)}${plRightLabel}`;

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			padding={1}
			backgroundColor={theme.bg}
		>
			<box
				flexDirection="column"
				flexBasis={1}
				flexGrow={1}
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
								const isCursor = i === playlistSelected && focus === "playlist";
								const title = fitCol(t.title.normalize("NFKC"), plTitleW);
								const duration = fmtDur(t.duration).padStart(plDurW, " ");
								const marker = isCursor ? "▶ " : "  ";
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
											isPlaying || isCursor ? theme.textRowSelected : undefined
										}
										onMouseDown={() => {
											setFocus("playlist");
											setPlaylistSelected(i);
											jumpInQueue(i);
										}}
									>
										{`${marker}${title} ${duration}`}
									</text>
								);
							})}
						</scrollbox>
						{queueIndex >= 0 ? progressEl : null}
					</>
				) : (
					<box padding={1}>
						<text fg={theme.textMuted}>Empty. Enter on a result to add.</text>
					</box>
				)}
			</box>

			<box
				flexDirection="column"
				flexBasis={1}
				flexGrow={2}
				border
				borderColor={focus === "results" ? theme.borderFocus : theme.border}
				backgroundColor={focus === "results" ? theme.bgFocus : undefined}
				title={(() => {
					const rsLeftLabel = ` YouTube Search${results.length > 0 ? ` (${results.length})` : ""}${searching ? " (searching...)" : ""} `;
					const rsRightLabel = ` / `;
					const rsTitleBarW = Math.max(0, termWidth - 6);
					const rsGap = Math.max(
						1,
						rsTitleBarW - rsLeftLabel.length - rsRightLabel.length,
					);
					return `${rsLeftLabel}${"─".repeat(rsGap)}${rsRightLabel}`;
				})()}
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
								const isPlaying =
									queueIndex === -1 && playing && preview?.id === t.id;
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
						{previewing ? progressEl : null}
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

			{showSearchModal
				? ((() => {
						const MODAL_H = 9;
						const innerH = Math.max(0, termHeight - 2);
						const plH = Math.floor(innerH / 3);
						const rsTop = 1 + plH;
						const rsH = innerH - plH;
						const top =
							rsH >= MODAL_H
								? rsTop + Math.floor((rsH - MODAL_H) / 2)
								: Math.max(0, Math.floor((termHeight - MODAL_H) / 2));
						return (
							<box
								position="absolute"
								top={top}
								left={6}
								right={6}
								border
								backgroundColor={theme.bg}
								title=" Search "
								padding={1}
								flexDirection="column"
							>
								<box
									flexDirection="row"
									border
									borderColor={theme.borderFocus}
									backgroundColor={theme.bgFocus}
									paddingLeft={1}
									paddingRight={1}
									alignItems="center"
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
											setShowSearchModal(false);
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
								<text> </text>
								<box flexDirection="row">
									<text>
										<span fg={theme.keyHint}>{fitCol("Enter", 8)}</span>
										<span fg={theme.textMuted}>search</span>
									</text>
									<text>{"  "}</text>
									<text>
										<span fg={theme.keyHint}>{fitCol("Esc", 8)}</span>
										<span fg={theme.textMuted}>close</span>
									</text>
								</box>
							</box>
						);
					})() as React.ReactNode)
				: null}

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
					top={Math.max(
						0,
						Math.floor(
							(termHeight -
								(6 + Math.max(HELP_LEFT.length, HELP_RIGHT.length))) /
								2,
						),
					)}
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

// destroy() can defer the native cleanup (kitty keyboard pop, alt-screen exit,
// mouse disable) to the render loop's finally block if called mid-render.
// Wait for the 'destroy' event before exiting so those sequences actually fire.
const shutdown = (code = 0, err?: unknown) => {
	let exited = false;
	const exit = () => {
		if (exited) return;
		exited = true;
		if (err !== undefined) console.error(err);
		process.exit(code);
	};
	try {
		renderer.once("destroy", exit);
		renderer.destroy();
	} catch {}
	setTimeout(exit, 250).unref();
};

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("SIGHUP", () => shutdown(129));
process.on("uncaughtException", (err) => shutdown(1, err));
process.on("unhandledRejection", (err) => shutdown(1, err));
