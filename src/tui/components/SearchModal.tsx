import type { RefObject } from "react";
import type { InputRenderable } from "@opentui/core";
import { fitCol } from "../../text";
import { theme } from "../../theme";

type SearchModalProps = {
  termHeight: number;
  query: string;
  inputRef: RefObject<InputRenderable | null>;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
};

export function SearchModal({
  termHeight,
  query,
  inputRef,
  onInput,
  onSubmit,
}: SearchModalProps) {
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
          onInput={onInput}
          onSubmit={(value) =>
            onSubmit(typeof value === "string" ? value : query)
          }
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
}
