import type { ScrollBoxRenderable } from "@opentui/core";

export function scrollCursorIntoView(
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
