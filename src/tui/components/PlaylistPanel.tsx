import type { ReactNode, RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { Track } from "../../protocol";
import { fitCol, fmtDur } from "../../text";
import { theme } from "../../theme";
import { transparentScrollOptions } from "./scrollOptions";

type PlaylistPanelProps = {
  height: number;
  focused: boolean;
  title: string;
  queue: Track[];
  queueIndex: number;
  playing: boolean;
  selectedIndex: number;
  titleWidth: number;
  durationWidth: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  progress: ReactNode;
  onFocus: () => void;
  onSelect: (index: number) => void;
};

export function PlaylistPanel({
  height,
  focused,
  title,
  queue,
  queueIndex,
  playing,
  selectedIndex,
  titleWidth,
  durationWidth,
  scrollRef,
  progress,
  onFocus,
  onSelect,
}: PlaylistPanelProps) {
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
      {queue.length > 0 ? (
        <>
          <text fg={theme.textMuted} wrapMode="none">
            {`  ${fitCol("Title", titleWidth)} ${"Length".padStart(durationWidth, " ")}`}
          </text>
          <scrollbox ref={scrollRef} flexGrow={1} {...transparentScrollOptions}>
            {queue.map((t, i) => {
              const isPlaying = i === queueIndex && playing;
              const isCursor = i === selectedIndex && focused;
              const title = fitCol(t.title.normalize("NFKC"), titleWidth);
              const duration = fmtDur(t.duration).padStart(durationWidth, " ");
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
                  fg={isPlaying || isCursor ? theme.textRowSelected : undefined}
                  onMouseDown={() => onSelect(i)}
                >
                  {`${marker}${title} ${duration}`}
                </text>
              );
            })}
          </scrollbox>
          {queueIndex >= 0 ? progress : null}
        </>
      ) : (
        <box padding={1}>
          <text fg={theme.textMuted}>Empty. Enter on a result to add.</text>
        </box>
      )}
    </box>
  );
}
