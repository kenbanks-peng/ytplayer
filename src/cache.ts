import { loadJson, saveOrUnlink } from "./jsonFile";
import { ACTIVE_FILE, SEARCH_FILE } from "./paths";
import type { Track } from "./protocol";

export type ActiveAssoc = { name: string; trackIds: string[] };
export type SearchCache = { query: string; results: Track[] };

function isActiveAssoc(x: unknown): x is ActiveAssoc {
	return (
		!!x &&
		typeof x === "object" &&
		typeof (x as ActiveAssoc).name === "string" &&
		Array.isArray((x as ActiveAssoc).trackIds)
	);
}

function isSearchCache(x: unknown): x is SearchCache {
	return (
		!!x &&
		typeof x === "object" &&
		typeof (x as SearchCache).query === "string" &&
		Array.isArray((x as SearchCache).results)
	);
}

export const saveActiveAssoc = (assoc: ActiveAssoc | null): void =>
	saveOrUnlink(ACTIVE_FILE, assoc);

export const loadActiveAssoc = (): ActiveAssoc | null =>
	loadJson<ActiveAssoc>(ACTIVE_FILE, isActiveAssoc);

export const saveSearch = (cache: SearchCache | null): void =>
	saveOrUnlink(SEARCH_FILE, cache && cache.results.length > 0 ? cache : null);

export const loadSearch = (): SearchCache | null =>
	loadJson<SearchCache>(SEARCH_FILE, isSearchCache);
