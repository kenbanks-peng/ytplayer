export type KeyLike = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
};

export const isUpKey = (key: KeyLike) => key.name === "up" || key.name === "k";
export const isDownKey = (key: KeyLike) =>
  key.name === "down" || key.name === "j";
export const isQuitKey = (key: KeyLike) =>
  (key.ctrl && key.name === "c") || key.name === "q" || key.name === "escape";
export const isHelpKey = (key: KeyLike) =>
  key.name === "?" || (key.shift && key.name === "/");
export const isPrevMoveKey = (key: KeyLike) =>
  key.name === "[" || key.name === "bracketleft";
export const isNextMoveKey = (key: KeyLike) =>
  key.name === "]" || key.name === "bracketright";

export function movedIndex(currentIndex: number, from: number, to: number) {
  if (currentIndex < 0) return currentIndex;
  if (currentIndex === from) return to;
  if (from < currentIndex && to >= currentIndex) return currentIndex - 1;
  if (from > currentIndex && to <= currentIndex) return currentIndex + 1;
  return currentIndex;
}
