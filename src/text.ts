// Combining marks, zero-width joiners, variation selectors render as 0 cells.
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x0300, 0x036f],
	[0x200b, 0x200f],
	[0x200d, 0x200d],
	[0xfe00, 0xfe0f],
	[0xe0100, 0xe01ef],
];

// CJK, hangul, kana, fullwidth, most emoji — render as 2 cells.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe4f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1faff],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];

function inRanges(
	cp: number,
	ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
	for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
	return false;
}

export function charWidth(cp: number): number {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (inRanges(cp, ZERO_RANGES)) return 0;
	if (inRanges(cp, WIDE_RANGES)) return 2;
	return 1;
}

export function displayWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
}

// Truncate `s` to fit within `width` display cells. Adds an ellipsis when
// truncating (unless width <= 1). When `pad` is true, right-pads with spaces
// to exactly fill `width`.
export function fit(
	s: string,
	width: number,
	opts?: { pad?: boolean },
): string {
	const pad = opts?.pad ?? false;
	if (width <= 0) return "";
	const w = displayWidth(s);
	if (w === width) return s;
	if (w < width) return pad ? s + " ".repeat(width - w) : s;
	const reserve = width <= 1 ? 0 : 1;
	let acc = "";
	let aw = 0;
	for (const ch of s) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (aw + cw > width - reserve) break;
		acc += ch;
		aw += cw;
	}
	if (reserve) {
		acc += "…";
		aw += 1;
	}
	if (pad && aw < width) acc += " ".repeat(width - aw);
	return acc;
}

export const fitCol = (s: string, width: number): string =>
	fit(s, width, { pad: true });

export const clip = (s: string, width: number): string => fit(s, width);

export function fmtCount(n?: number): string {
	if (n == null || !Number.isFinite(n)) return "";
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function fmtDur(s?: number): string {
	if (!s || !Number.isFinite(s)) return "--:--";
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function slugify(name: string): string {
	const s = name
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "untitled";
}
