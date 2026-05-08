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
};

const palette = mocha;

// Semantic tokens. UI code references these names, never raw colors.
export const theme = {
	surface: palette.base,
	surfaceOverlay: palette.mantle,
	border: palette.surface1,
	text: palette.text,
	textMuted: palette.subtext0,
	textSubtle: palette.overlay0,
	accent: palette.blue,
	keyHint: palette.sky,
	playing: palette.green,
	paused: palette.yellow,
	error: palette.red,
	selection: palette.mauve,
};

export type Theme = typeof theme;
