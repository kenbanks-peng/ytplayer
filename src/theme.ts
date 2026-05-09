// Catppuccin Mocha palette. Swap this object to retheme the whole app.
const mocha = {
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
  surface0: "#313244",
  surface1: "#45475a",
  surface2: "#585b70",
  overlay0: "#6c7086",
  overlay1: "#7f849c",
  overlay2: "#9399b2",
  subtext0: "#a6adc8",
  subtext1: "#bac2de",
  text: "#cdd6f4",
  blue: "#89b4fa",
  sky: "#89dceb",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  red: "#f38ba8",
  mauve: "#cba6f7",
  pureGreen: "#00ff00",
};

const palette = mocha;

function mix(a: string, b: string, t: number): string {
  const ch = (i: number) => {
    const av = parseInt(a.slice(i, i + 2), 16);
    const bv = parseInt(b.slice(i, i + 2), 16);
    return Math.round(av * t + bv * (1 - t))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

const accent = palette.blue;

// Semantic tokens. UI code references these names, never raw colors.
export const theme = {
  bg: palette.base,
  bgFocus: mix(accent, palette.base, 0.08),
  bgRowSelected: mix(accent, palette.base, 1),
  textRowSelected: palette.base,
  border: palette.subtext1,
  borderFocus: accent,
  text: palette.text,
  textMuted: palette.subtext0,
  textSubtle: palette.overlay0,
  accent,
  keyHint: palette.sky,
  playing: palette.green,
  paused: palette.yellow,
  error: palette.red,
  selection: palette.mauve,
};

export type Theme = typeof theme;
