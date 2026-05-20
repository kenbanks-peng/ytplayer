import { fitCol } from "../../text";
import { theme } from "../../theme";
import {
  HELP_LEFT,
  HELP_LEFT_KEY_W,
  HELP_RIGHT,
  HELP_RIGHT_KEY_W,
} from "../help";

type HelpModalProps = {
  termHeight: number;
};

export function HelpModal({ termHeight }: HelpModalProps) {
  return (
    <box
      position="absolute"
      top={Math.max(
        0,
        Math.floor(
          (termHeight - (6 + Math.max(HELP_LEFT.length, HELP_RIGHT.length))) /
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
  );
}
