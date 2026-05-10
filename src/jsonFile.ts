import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function ensureDir(path: string): void {
	try {
		mkdirSync(path, { recursive: true });
	} catch {}
}

export function loadJson<T>(
	path: string,
	validate?: (x: unknown) => x is T,
): T | null {
	try {
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (validate && !validate(parsed)) return null;
		return parsed as T;
	} catch {
		return null;
	}
}

export function saveJson(path: string, data: unknown): void {
	try {
		ensureDir(dirname(path));
		writeFileSync(path, JSON.stringify(data));
	} catch {}
}

// Write `data` if non-null, otherwise unlink any existing file. Used for
// "the saved value reflects current state, including absence."
export function saveOrUnlink(path: string, data: unknown | null): void {
	try {
		if (data !== null) {
			ensureDir(dirname(path));
			writeFileSync(path, JSON.stringify(data));
		} else if (existsSync(path)) {
			unlinkSync(path);
		}
	} catch {}
}

export function unlinkIfExists(path: string): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {}
}
