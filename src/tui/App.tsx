import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { spawn } from "bun";
import { useEffect, useRef, useState } from "react";
import { HelpModal } from "./components/HelpModal";
import { PlaylistModal } from "./components/PlaylistModal";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { ResultsPanel } from "./components/ResultsPanel";
import { SearchModal } from "./components/SearchModal";
import {
  loadActiveAssoc,
  loadSearch,
  saveActiveAssoc,
  saveSearch,
} from "../cache";
import {
  getState,
  nextTrack,
  pausePlayback,
  playPlayback,
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
} from "../client";
import {
  deletePlaylist,
  findPlaylistMatchingTrackIds,
  listPlaylists,
  loadPlaylist,
  type PlaylistEntry,
  sameTrackIdSet,
  savePlaylist,
} from "../playlists";
import type { PlayMode, Track } from "../protocol";
import { clip, displayWidth, fmtDur, slugify } from "../text";
import { theme } from "../theme";
import {
  isDownKey,
  isHelpKey,
  isNextMoveKey,
  isPrevMoveKey,
  isQuitKey,
  isUpKey,
  movedIndex,
} from "./keyboard";
import { scrollCursorIntoView } from "./scroll";
import { searchYouTube, sortByViewsDesc } from "./search";

// Rows inside the results panel that are not available for result items:
// border(2) + header(1).
const RESULTS_PANEL_CHROME = 3;
// The progress row has marginTop={1} and one text row.
const PROGRESS_EL_HEIGHT = 2;

type Focus = "results" | "playlist";

type AppProps = {
  onQuit: () => void;
};

export function App({ onQuit }: AppProps) {
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
  const { width: termWidth, height: termHeight } = useTerminalDimensions();
  const innerHeight = Math.max(0, termHeight - 2);
  const playlistPanelHeight = Math.floor(innerHeight / 3);
  const resultsPanelHeight = innerHeight - playlistPanelHeight;
  const previewing = queueIndex === -1 && !!preview;
  const pageSize = Math.max(
    1,
    resultsPanelHeight -
      RESULTS_PANEL_CHROME -
      (previewing ? PROGRESS_EL_HEIGHT : 0),
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
    scrollCursorIntoView(resultsScrollRef.current, selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    scrollCursorIntoView(playlistScrollRef.current, playlistSelected);
  }, [playlistSelected]);

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

  const movePlaylistItem = (from: number, to: number) => {
    if (from < 0 || to < 0 || to >= queue.length) return;
    setQueue((cur) => {
      const next = [...cur];
      const [item] = next.splice(from, 1);
      if (item) next.splice(to, 0, item);
      return next;
    });
    setQueueIndex((idx) => movedIndex(idx, from, to));
    setPlaylistSelected(to);
    queueMove(from, to);
  };

  const pauseCurrentPlayback = async () => {
    const resp = await pausePlayback();
    if (resp) setPaused(resp.paused);
  };

  const playCurrentPlayback = async () => {
    const resp = await playPlayback();
    if (resp) setPaused(resp.paused);
  };

  const stopCurrentPlayback = () => {
    stopPlayback();
    setQueueIndex(-1);
    setPreview(null);
    setPlaying(false);
    setPaused(false);
  };

  useKeyboard((key) => {
    if (showSearchModal) {
      if (key.name === "escape") setShowSearchModal(false);
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
        if (isUpKey(key)) {
          setPlSelected((c) => Math.max(0, c - 1));
          setPlDeleteArmedSlug(null);
          return;
        }
        if (isDownKey(key)) {
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
    if (isHelpKey(key)) {
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
      if (isUpKey(key)) {
        setPlaylistSelected((c) => Math.max(0, c - 1));
        return;
      }
      if (isDownKey(key)) {
        setPlaylistSelected((c) => Math.min(queue.length - 1, c + 1));
        return;
      }
      if (key.name === "return") {
        jumpInQueue(playlistSelected);
        return;
      }
    }
    if (focus === "results" && results.length > 0) {
      if (isUpKey(key)) {
        setSelectedIndex((c) => Math.max(0, c - 1));
        return;
      }
      if (isDownKey(key)) {
        setSelectedIndex((c) => Math.min(results.length - 1, c + 1));
        return;
      }
      if (key.name === "return") {
        const t = results[selectedIndex];
        if (t) addToQueue(t);
        return;
      }
    }
    if (isQuitKey(key)) {
      onQuit();
      return;
    }
    if (key.name === "space") {
      pauseCurrentPlayback();
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
      stopCurrentPlayback();
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
    if (isPrevMoveKey(key) && focus === "playlist") {
      movePlaylistItem(playlistSelected, playlistSelected - 1);
      return;
    }
    if (isNextMoveKey(key) && focus === "playlist") {
      movePlaylistItem(playlistSelected, playlistSelected + 1);
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

  const progressTotalSec = trackDuration > 0 ? trackDuration : 0;
  const displayTotalSec = now?.duration ?? progressTotalSec;
  const posStr = fmtDur(position);
  const totStr = fmtDur(displayTotalSec);
  const stopLabel = " ◾";
  const pauseLabel = "⏸ ";
  const playLabel = "▶";
  const progressSideW =
    displayWidth(stopLabel) +
    displayWidth(pauseLabel) +
    displayWidth(playLabel) +
    posStr.length +
    totStr.length +
    3;
  const progressW = Math.max(10, termWidth - 7 - progressSideW);
  const ratio =
    progressTotalSec > 0
      ? Math.min(1, Math.max(0, position / progressTotalSec))
      : 0;
  const filled = Math.round(progressW * ratio);
  const progressBar = `${"█".repeat(filled)}${"░".repeat(progressW - filled)}`;
  const progressEl = (
    <box flexDirection="row" flexShrink={0} marginTop={1}>
      <text
        fg={theme.paused}
        onMouseDown={() => {
          stopCurrentPlayback();
        }}
      >
        {stopLabel}
      </text>
      <text
        fg={theme.paused}
        onMouseDown={() => {
          pauseCurrentPlayback();
        }}
      >
        {pauseLabel}
      </text>
      <text
        fg={theme.playing}
        onMouseDown={() => {
          playCurrentPlayback();
        }}
      >
        {playLabel}
      </text>
      <text fg={theme.textMuted}>{` ${posStr} `}</text>
      <text
        fg={paused ? theme.paused : theme.accent}
        onMouseDown={(e) => {
          if (progressTotalSec <= 0 || progressW <= 0) return;
          const target = e.target;
          if (!target) return;
          const rel = e.x - target.screenX;
          const r = Math.max(0, Math.min(1, rel / progressW));
          const newPos = r * progressTotalSec;
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
      <PlaylistPanel
        height={playlistPanelHeight}
        focused={focus === "playlist"}
        title={playlistTitle}
        queue={queue}
        queueIndex={queueIndex}
        playing={playing}
        selectedIndex={playlistSelected}
        titleWidth={plTitleW}
        durationWidth={plDurW}
        scrollRef={playlistScrollRef}
        progress={progressEl}
        onFocus={() => setFocus("playlist")}
        onSelect={(i) => {
          setFocus("playlist");
          setPlaylistSelected(i);
          jumpInQueue(i);
        }}
      />

      <ResultsPanel
        height={resultsPanelHeight}
        focused={focus === "results"}
        termWidth={termWidth}
        results={results}
        selectedIndex={selectedIndex}
        queueIndex={queueIndex}
        playing={playing}
        preview={preview}
        searching={searching}
        error={error}
        titleWidth={titleW}
        uploaderWidth={uploaderW}
        viewsWidth={viewsW}
        durationWidth={durW}
        scrollRef={resultsScrollRef}
        progress={progressEl}
        previewing={previewing}
        onFocus={() => setFocus("results")}
        onSelect={(track, i) => {
          setFocus("results");
          setSelectedIndex(i);
          previewFromResults(track);
        }}
      />

      {showSearchModal ? (
        <SearchModal
          termHeight={termHeight}
          query={query}
          inputRef={inputRef}
          onInput={setQuery}
          onSubmit={(value) => {
            setQuery(value);
            const q = value.trim();
            if (!q) return;
            setShowSearchModal(false);
            setFocus("results");
            if (q === lastQueryRef.current) {
              loadMore();
            } else {
              doSearch(value);
            }
          }}
        />
      ) : null}

      {showPlaylists ? (
        <PlaylistModal
          inputRef={plInputRef}
          focus={plModalFocus}
          entries={plEntries}
          name={plName}
          queueLength={queue.length}
          selectedIndex={plSelected}
          deleteArmedSlug={plDeleteArmedSlug}
          onFocusInput={() => setPlModalFocus("input")}
          onFocusList={() => setPlModalFocus("list")}
          onNameInput={setPlName}
          onSave={doSavePlaylist}
          onSelect={(i) => {
            setPlModalFocus("list");
            setPlSelected(i);
          }}
        />
      ) : null}
      {showHelp ? <HelpModal termHeight={termHeight} /> : null}
    </box>
  );
}
