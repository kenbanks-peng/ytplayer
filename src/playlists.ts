import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadJson, saveJson, unlinkIfExists } from "./jsonFile";
import { PLAYLIST_DIR } from "./paths";
import type { Track } from "./protocol";
import { slugify } from "./text";

export type PlaylistEntry = { name: string; slug: string; count: number };
export type PlaylistFile = { name: string; tracks: Track[] };

function isPlaylistFile(x: unknown): x is { name?: string; tracks?: Track[] } {
	return !!x && typeof x === "object";
}

function readPlaylistFile(file: string): { name: string; tracks: Track[] } {
	const slug = file.slice(0, -5);
	const raw = loadJson<{ name?: string; tracks?: Track[] }>(
		join(PLAYLIST_DIR, file),
		isPlaylistFile,
	);
	const tracks = Array.isArray(raw?.tracks) ? raw.tracks : [];
	const name = typeof raw?.name === "string" ? raw.name : slug;
	return { name, tracks };
}

function listFiles(): string[] {
	try {
		if (!existsSync(PLAYLIST_DIR)) return [];
		return readdirSync(PLAYLIST_DIR).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
}

export function listPlaylists(): PlaylistEntry[] {
	const entries: PlaylistEntry[] = [];
	for (const file of listFiles()) {
		const { name, tracks } = readPlaylistFile(file);
		entries.push({ name, slug: file.slice(0, -5), count: tracks.length });
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return entries;
}

export function savePlaylist(name: string, tracks: Track[]): string | null {
	const trimmed = name.trim();
	if (!trimmed) return null;
	const slug = slugify(trimmed);
	saveJson(join(PLAYLIST_DIR, `${slug}.json`), { name: trimmed, tracks });
	return slug;
}

export function loadPlaylist(slug: string): PlaylistFile | null {
	const raw = loadJson<{ name?: string; tracks?: Track[] }>(
		join(PLAYLIST_DIR, `${slug}.json`),
		isPlaylistFile,
	);
	if (!raw) return null;
	const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
	const name = typeof raw.name === "string" ? raw.name : slug;
	return { name, tracks };
}

export function deletePlaylist(slug: string): boolean {
	unlinkIfExists(join(PLAYLIST_DIR, `${slug}.json`));
	return true;
}

export function findPlaylistMatchingTrackIds(
	trackIds: string[],
): { name: string; slug: string } | null {
	for (const file of listFiles()) {
		const { name, tracks } = readPlaylistFile(file);
		if (
			tracks.length === trackIds.length &&
			tracks.every((t, i) => t.id === trackIds[i])
		) {
			return { name, slug: file.slice(0, -5) };
		}
	}
	return null;
}

export function sameTrackIdSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	for (const id of b) if (!set.has(id)) return false;
	return true;
}
