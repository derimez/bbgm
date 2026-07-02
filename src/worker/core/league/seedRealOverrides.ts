import {
	RealPlayerPhotosSchema,
	RealTeamInfoSchema,
} from "../../../common/types.ts";
import { idb } from "../../db/index.ts";

// Stock ZenGM pulls its real NBA team info (names/logos/colors) and real player
// photos from its live account server. This local fork has no such server, so it
// ships those maps as static files (data/server/override_*.json) served at
// /api/overrides/:which. Without them the New League wizard, Exhibition, and
// league generation fall back to fictional team names ("Gangsters", "Unicorns")
// and generated cartoon faces — which is exactly what we don't want.
//
// This seeds both maps into the meta `attributes` store, which is where every
// real-roster code path already reads them from (getRealTeamInfo, exhibition,
// getRealTeamPlayerData → applyRealTeamInfo / applyRealPlayerPhotos).
//
// Idempotent: a key that is already set is left untouched, so a manual Global
// Settings edit is never clobbered and re-seeding is free. Memoized so concurrent
// callers (boot + wizard + generation) share a single pass. Every failure is
// swallowed — a missing override must never block the worker or league creation.
const OVERRIDES = [
	{ key: "realTeamInfo" as const, schema: RealTeamInfoSchema },
	{ key: "realPlayerPhotos" as const, schema: RealPlayerPhotosSchema },
];

const doSeed = async () => {
	for (const { key, schema } of OVERRIDES) {
		try {
			const existing = await idb.meta.get("attributes", key);
			if (existing !== undefined) {
				continue;
			}

			const res = await fetch(`/api/overrides/${key}`);
			if (!res.ok) {
				continue;
			}

			const parsed = schema.safeParse(await res.json());
			if (!parsed.success) {
				console.error(`[seedRealOverrides] invalid ${key}`, parsed.error);
				continue;
			}

			// Re-check under the write transaction in case another caller seeded it
			// while we were fetching.
			const store = (await idb.meta.transaction("attributes", "readwrite"))
				.store;
			if ((await store.get(key)) === undefined) {
				await store.put(parsed.data, key);
				console.log(`[seedRealOverrides] seeded ${key}`);
			}
		} catch (error) {
			console.error(`[seedRealOverrides] ${key} failed`, error);
		}
	}
};

let seedPromise: Promise<void> | undefined;

// Returns a shared promise that resolves once the real overrides are guaranteed
// present (or provably unavailable). Await it before reading realTeamInfo /
// realPlayerPhotos from the meta store to avoid a first-load race.
const seedRealOverrides = () => {
	if (!seedPromise) {
		seedPromise = doSeed();
	}
	return seedPromise;
};

export default seedRealOverrides;
