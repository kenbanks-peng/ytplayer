import type { ReactNode, RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { Track } from "../../protocol";
import { displayWidth, fitCol, fmtCount, fmtDur } from "../../text";
import { theme } from "../../theme";
import { pageMarker } from "../search";
import { transparentScrollOptions } from "./scrollOptions";

type ResultsPanelProps = {
  height: number;
  focused: boolean;
  termWidth: number;
  results: Track[];
  selectedIndex: number;
  queueIndex: number;
  playing: boolean;
  preview: Track | null;
  searching: boolean;
  error: string | null;
  titleWidth: number;
  uploaderWidth: number;
  viewsWidth: number;
  durationWidth: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  progress: ReactNode;
  previewing: boolean;
  onFocus: () => void;
  onSelect: (track: Track, index: number) => void;
};

export function ResultsPanel({
  height,
  focused,
  termWidth,
  results,
  selectedIndex,
  queueIndex,
  playing,
  preview,
  searching,
  error,
  titleWidth,
  uploaderWidth,
  viewsWidth,
  durationWidth,
  scrollRef,
  progress,
  previewing,
  onFocus,
  onSelect,
}: ResultsPanelProps) {
  const leftLabel = ` YouTube Search${results.length > 0 ? ` (${results.length})` : ""}${searching ? " (searching...)" : ""} `;
  const rightLabel = ` / `;
  const titleBarWidth = Math.max(0, termWidth - 6);
  const gap = Math.max(
    1,
    titleBarWidth - displayWidth(leftLabel) - displayWidth(rightLabel),
  );
  const title = `${leftLabel}${"─".repeat(gap)}${rightLabel}`;

  return (
    <box
      flexDirection="column"
      height={height}
      border
      borderColor={focused ? theme.borderFocus : theme.border}
      backgroundColor={focused ? theme.bgFocus : undefined}
      title={title}
      onMouseDown={onFocus}
    >
      {results.length > 0 ? (
        <>
          <text fg={theme.textMuted} wrapMode="none">
            {`    ${fitCol("Title", titleWidth)}  ${fitCol("Uploader", uploaderWidth)}  ${"Views".padStart(viewsWidth, " ")}  ${"Length".padStart(durationWidth, " ")}`}
          </text>
          <scrollbox
            ref={scrollRef}
            flexGrow={1}
            flexShrink={1}
            horizontalScrollbarOptions={{ height: 0, visible: false }}
            {...transparentScrollOptions}
          >
            {results.map((t, i) => {
              const isCursor = i === selectedIndex && focused;
              const isPlaying =
                queueIndex === -1 && playing && preview?.id === t.id;
              const marker = pageMarker(t.page);
              const title = fitCol(t.title.normalize("NFKC"), titleWidth);
              const uploader = fitCol(
                (t.uploader ?? "").normalize("NFKC"),
                uploaderWidth,
              );
              const views = fmtCount(t.views).padStart(viewsWidth, " ");
              const duration = fmtDur(t.duration).padStart(durationWidth, " ");
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
                  fg={isPlaying || isCursor ? theme.textRowSelected : undefined}
                  onMouseDown={() => onSelect(t, i)}
                >
                  {`${isCursor ? "▶ " : "  "}${marker} ${title}  ${uploader}  ${views}  ${duration}`}
                </text>
              );
            })}
          </scrollbox>
          {previewing ? progress : null}
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
  );
}
