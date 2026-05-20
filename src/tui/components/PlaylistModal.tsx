import type { RefObject } from "react";
import type { InputRenderable } from "@opentui/core";
import type { PlaylistEntry } from "../../playlists";
import { fitCol } from "../../text";
import { theme } from "../../theme";

type PlaylistModalProps = {
  inputRef: RefObject<InputRenderable | null>;
  focus: "input" | "list";
  entries: PlaylistEntry[];
  name: string;
  queueLength: number;
  selectedIndex: number;
  deleteArmedSlug: string | null;
  onFocusInput: () => void;
  onFocusList: () => void;
  onNameInput: (value: string) => void;
  onSave: () => void;
  onSelect: (index: number) => void;
};

export function PlaylistModal({
  inputRef,
  focus,
  entries,
  name,
  queueLength,
  selectedIndex,
  deleteArmedSlug,
  onFocusInput,
  onFocusList,
  onNameInput,
  onSave,
  onSelect,
}: PlaylistModalProps) {
  return (
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
        borderColor={focus === "input" ? theme.borderFocus : theme.border}
        backgroundColor={focus === "input" ? theme.bgFocus : undefined}
        paddingLeft={1}
        paddingRight={1}
        alignItems="center"
        onMouseDown={onFocusInput}
      >
        <text fg={theme.textMuted}>Save current queue as: </text>
        <input
          ref={inputRef}
          value={name}
          onInput={onNameInput}
          onSubmit={onSave}
          placeholder={queueLength > 0 ? "playlist name..." : "queue is empty"}
          placeholderColor={theme.textMuted}
          flexGrow={1}
        />
      </box>
      <text> </text>
      <box
        flexDirection="column"
        flexGrow={1}
        border
        borderColor={focus === "list" ? theme.borderFocus : theme.border}
        backgroundColor={focus === "list" ? theme.bgFocus : undefined}
        onMouseDown={onFocusList}
      >
        {entries.length > 0 ? (
          entries.map((entry, i) => {
            const isCursor = i === selectedIndex && focus === "list";
            const armed = deleteArmedSlug === entry.slug;
            return (
              <text
                key={entry.slug}
                bg={isCursor ? theme.bgRowSelected : undefined}
                fg={isCursor ? theme.textRowSelected : undefined}
                onMouseDown={() => onSelect(i)}
              >
                {`${isCursor ? "▶ " : "  "}${entry.name}  (${entry.count})${armed ? "  — press d to confirm" : ""}`}
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
          {(focus === "input"
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
          {(focus === "list"
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
  );
}
