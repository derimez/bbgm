import makeExportStream from "./makeExportStream.ts";
import { local } from "./local.ts";
import { toWorker } from "./toWorker.ts";
import { safeLocalStorage } from "./safeLocalStorage.ts";
import { confirm } from "./confirm.tsx";
import { logEvent } from "./logEvent.ts";
import type { LeagueDBStoreNames } from "../../worker/db/connectLeague.ts";

// All stores needed for a full ZenGM-importable snapshot
const ALL_STORES: LeagueDBStoreNames[] = [
	"allStars",
	"awards",
	"draftLotteryResults",
	"draftPicks",
	"events",
	"gameAttributes",
	"games",
	"headToHeads",
	"messages",
	"negotiations",
	"playerFeats",
	"players",
	"playoffSeries",
	"releasedPlayers",
	"savedTrades",
	"savedTradingBlock",
	"schedule",
	"scheduledEvents",
	"seasonLeaders",
	"teamSeasons",
	"teamStats",
	"teams",
	"trade",
];

// ── Per-device sync bookkeeping (localStorage) ──────────────────────────────
// Identity (syncId) lives in the league (gameAttributes) and is shared across
// devices. Dirty/lastSyncedAt are per-device facts, so they key off local lid.

const DIRTY_KEY = (lid: number) => `bbgmSync:dirty:${lid}`;
const LAST_SYNCED_KEY = (lid: number) => `bbgmSync:lastSyncedAt:${lid}`;
const DEVICE_KEY = "bbgmSync:deviceId";

// crypto.randomUUID() is undefined in non-secure contexts (HTTP over the
// Tailscale hostname); getRandomValues works there, Math.random is the floor.
const randomHex = (n: number): string => {
	const c: Crypto | undefined = (globalThis as any).crypto;
	const b = new Uint8Array(n);
	if (c && typeof c.getRandomValues === "function") {
		c.getRandomValues(b);
	} else {
		for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
	}
	return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

const getDeviceId = (): string => {
	let id = safeLocalStorage.getItem(DEVICE_KEY);
	if (!id) {
		id = randomHex(4);
		safeLocalStorage.setItem(DEVICE_KEY, id);
	}
	return id;
};

// Called on every gameSim: this device now has changes not yet pushed. We do
// NOT auto-push — pushing is the manual "Sync ⬆" button — so two devices can't
// silently clobber each other. The dirty flag feeds conflict detection on load.
export const markDirty = () => {
	const { lid } = local.getState();
	if (lid === undefined) return;
	safeLocalStorage.setItem(DIRTY_KEY(lid), "1");

	// The cached snapshot (Tools > Export Snapshot) is now stale. Drop it and
	// re-build a couple seconds after simming settles, so the next tap is instant.
	invalidateSnapshot();
	scheduleWarmSnapshot();
};

export const isDirty = (lid: number): boolean =>
	safeLocalStorage.getItem(DIRTY_KEY(lid)) === "1";

export const getLastSyncedAt = (lid: number): number => {
	const v = safeLocalStorage.getItem(LAST_SYNCED_KEY(lid));
	return v ? Number.parseInt(v, 10) : 0;
};

// Record a clean sync point (after a successful push or pull): server snapshot
// at `savedAt` now matches local, and there are no unpushed local changes.
export const markSynced = (lid: number, savedAt: number) => {
	safeLocalStorage.setItem(LAST_SYNCED_KEY(lid), String(savedAt));
	safeLocalStorage.removeItem(DIRTY_KEY(lid));
};

// ── One-tap "Export Snapshot" via the iOS Share Sheet ────────────────────────
// Goal: open menu → tap Export Snapshot → share sheet (with the .json.gz file
// attached) → tap Claude (or "Copy"). That collapses the old 7-step
// download→preview→share→copy→switch→paste dance.
//
// We hand the gzip File to navigator.share({ files }). Two platform facts shape
// this:
//   1. navigator.share needs a SECURE context, so the app must be reached over
//      HTTPS (Tailscale serve, https://…:8445). Over plain http:// it's
//      undefined and we fall back to a normal file download.
//   2. navigator.share must run inside the tap gesture, but the gzip export is
//      async and iOS drops the gesture's permission after any await. So we keep
//      the File pre-built (warmed on load + ~2.5s after sims) and share it
//      synchronously. If a tap lands before it's warm, we build and ask for one
//      more tap.

// Same artifact as Tools > Export League's default download: the whole league
// minus box scores (which balloon the file to tens of MB).
const SNAPSHOT_STORES: LeagueDBStoreNames[] = ALL_STORES.filter(
	(store) => store !== "games",
);

type SnapshotFile = { blob: Blob; filename: string };

let snapshotCache: SnapshotFile | undefined;
let snapshotBuilding: Promise<void> | undefined;
let warmTimer: ReturnType<typeof setTimeout> | undefined;

const buildSnapshot = async (): Promise<SnapshotFile> => {
	const name = await toWorker("main", "getLeagueName", undefined);
	let filename = await toWorker("main", "getExportFilename", "league");

	const stream = await makeExportStream(SNAPSHOT_STORES, {
		compressed: true,
		name,
	});

	let byteStream = stream.pipeThrough(new TextEncoderStream());
	if (typeof CompressionStream !== "undefined") {
		byteStream = byteStream.pipeThrough(new CompressionStream("gzip"));
		filename += ".gz";
	}

	const blob = await new Response(byteStream).blob();
	return { blob, filename };
};

export const invalidateSnapshot = () => {
	snapshotCache = undefined;
};

// Build the snapshot File (or join an in-flight build) and cache it. Cheap to
// call eagerly — no-ops if a fresh one is cached or a build is already running.
export const warmSnapshot = async (): Promise<void> => {
	const { lid } = local.getState();
	if (lid === undefined) return;
	if (snapshotCache !== undefined) return;
	if (snapshotBuilding) return snapshotBuilding;

	snapshotBuilding = (async () => {
		try {
			snapshotCache = await buildSnapshot();
		} catch {
			// Leave the cache empty; shareSnapshot will rebuild on demand.
		} finally {
			snapshotBuilding = undefined;
		}
	})();
	return snapshotBuilding;
};

// Debounced warm: called on every sim, so it must coalesce — fire ~2.5s after
// the last sim rather than once per simulated game.
export const scheduleWarmSnapshot = () => {
	if (warmTimer) clearTimeout(warmTimer);
	warmTimer = setTimeout(() => {
		warmTimer = undefined;
		void warmSnapshot();
	}, 2500);
};

const downloadFallback = ({ blob, filename }: SnapshotFile) => {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
};

export type ShareSnapshotResult =
	| { ok: true }
	| { ok: false; error: string; needsPrepare?: boolean };

// Synchronous on purpose: navigator.share has to fire inside the tap gesture.
// If the snapshot isn't cached yet, start building and ask for one more tap.
export const shareSnapshot = (): ShareSnapshotResult => {
	const { lid } = local.getState();
	if (lid === undefined) return { ok: false, error: "No league open" };

	if (!snapshotCache) {
		void warmSnapshot();
		return { ok: false, error: "Snapshot not ready yet", needsPrepare: true };
	}

	const { blob, filename } = snapshotCache;
	const file = new File([blob], filename, {
		type: blob.type || "application/gzip",
	});

	const nav = navigator as Navigator & {
		canShare?: (data?: ShareData) => boolean;
	};

	if (
		typeof nav.share === "function" &&
		(!nav.canShare || nav.canShare({ files: [file] }))
	) {
		// Fire within the gesture — do NOT await before calling share().
		nav.share({ files: [file], title: filename }).catch((err: any) => {
			// AbortError = user dismissed the sheet; not worth a toast.
			if (err && err.name !== "AbortError") {
				void logEvent({
					type: "error",
					text: `Share failed: ${err.message}`,
					saveToDb: false,
					persistent: true,
				});
			}
		});
		return { ok: true };
	}

	// No Web Share (e.g. opened over plain http://) — just download the file.
	downloadFallback(snapshotCache);
	return {
		ok: false,
		error:
			"Share unavailable — downloaded the file instead (open over https://…:8445 for one-tap share)",
	};
};

// ── Manual push (the "Sync ⬆" button) ───────────────────────────────────────

let pushInProgress = false;

export type PushResult =
	| { ok: true; savedAt: number; syncId: string }
	| { ok: false; error: string };

export const pushNow = async (): Promise<PushResult> => {
	if (pushInProgress) return { ok: false, error: "Sync already in progress" };

	const { lid } = local.getState();
	if (lid === undefined) return { ok: false, error: "No league open" };

	pushInProgress = true;
	try {
		// Mint a syncId on first push if the league doesn't have one yet.
		const info = await toWorker("main", "bbgmSyncInfo", true);
		if (!info.syncId) return { ok: false, error: "Could not get syncId" };

		// Exclude box scores ("games") — same as SNAPSHOT_STORES. They balloon a
		// dynasty to tens of MB (and grow every sim); embedding that in the JSON
		// sync envelope blows past the server's body limit and 413s the push.
		// Everything needed to continue the league on another device survives.
		const stream = await makeExportStream(SNAPSHOT_STORES, {
			compressed: true,
		});
		const reader = stream.getReader();
		const chunks: string[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		const data = chunks.join("");

		const res = await fetch("/api/v2/sync", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				syncId: info.syncId,
				name: info.name,
				season: info.season,
				phase: info.phase,
				device: getDeviceId(),
				lid,
				data,
			}),
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			return { ok: false, error: body.error || `HTTP ${res.status}` };
		}

		const body = (await res.json()) as { savedAt: number };
		markSynced(lid, body.savedAt);
		return { ok: true, savedAt: body.savedAt, syncId: info.syncId };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	} finally {
		pushInProgress = false;
	}
};

// ── Delete from server (counters Sync) ──────────────────────────────────────
// Removes this league's copy from the sync server. The local save is untouched
// — delete it locally afterward (Dashboard) if you want it gone entirely. Also
// clears local sync bookkeeping so auto-pull/conflict won't fire for it.

export type DeleteResult =
	| { ok: true; syncId: string }
	| { ok: false; error: string };

export const deleteFromServer = async (): Promise<DeleteResult> => {
	const { lid } = local.getState();
	if (lid === undefined) return { ok: false, error: "No league open" };

	const info = await toWorker("main", "bbgmSyncInfo", false);
	if (!info.syncId) return { ok: false, error: "This league was never synced" };

	try {
		const res = await fetch(`/api/v2/sync/${info.syncId}`, {
			method: "DELETE",
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			return { ok: false, error: body.error || `HTTP ${res.status}` };
		}
		safeLocalStorage.removeItem(LAST_SYNCED_KEY(lid));
		safeLocalStorage.removeItem(DIRTY_KEY(lid));
		return { ok: true, syncId: info.syncId };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
};

// ── Auto-pull on load ───────────────────────────────────────────────────────
// "Read latest is automatic": when a league is opened, if the server has a
// newer copy of its syncId AND this device has no unpushed changes, pull it in.
// If both sides changed, prompt (Keep mine / Take server). The pull itself
// reuses ZenGM's tested import-over-lid flow (/new_league/<lid>#importUrl=…),
// driven automatically by a sessionStorage handoff that NewLeague consumes.

export const AUTO_PULL_KEY = "bbgmSync:autoPull";

type ServerMeta = { savedAt: number; season: number; phase: number };

const getServerMeta = async (syncId: string): Promise<ServerMeta | null> => {
	try {
		const res = await fetch(`/api/v2/meta/${syncId}`);
		if (!res.ok) return null;
		const body = await res.json();
		return { savedAt: body.savedAt, season: body.season, phase: body.phase };
	} catch {
		return null;
	}
};

// Hand off to the import-over-lid flow. Optimistically advance lastSyncedAt so
// the post-import firstRun (back on /l/<lid>) doesn't re-trigger a pull loop.
const startPull = (lid: number, syncId: string, savedAt: number) => {
	markSynced(lid, savedAt);
	safeLocalStorage.setItem(AUTO_PULL_KEY, JSON.stringify({ lid, syncId }));
	const url = `/new_league/${lid}#importUrl=${encodeURIComponent(
		`${window.location.origin}/api/v2/pull/${syncId}`,
	)}`;
	// Full navigation so NewLeague mounts fresh and parses the hash cleanly.
	window.location.href = url;
};

// Only re-check when the open league actually changes, not on every in-league
// page navigation (firstRun fires on both).
let lastCheckedLid: number | undefined;

export const checkAndPullOnLoad = async () => {
	const { lid } = local.getState();
	if (lid === undefined) {
		lastCheckedLid = undefined;
		return;
	}
	if (lid === lastCheckedLid) return;
	lastCheckedLid = lid;

	const info = await toWorker("main", "bbgmSyncInfo", false);
	if (!info.syncId) return; // never synced → nothing to pull

	const meta = await getServerMeta(info.syncId);
	if (!meta) return; // nothing on server

	const lastSynced = getLastSyncedAt(lid);
	if (meta.savedAt <= lastSynced) return; // local is current or ahead

	// Server is newer than our last sync point.
	if (isDirty(lid)) {
		// True conflict: both sides changed. Don't nag more than once per
		// server version per session.
		const dismissKey = `bbgmSync:conflictDismiss:${info.syncId}`;
		if (Number(sessionStorage.getItem(dismissKey)) === meta.savedAt) return;

		const fmt = (s: number, p: number) => `season ${s} (phase ${p})`;
		const takeServer = await confirm(
			`This league has a newer copy on the server (${fmt(
				meta.season,
				meta.phase,
			)}), but this device also has unsynced changes (${fmt(
				info.season,
				info.phase,
			)}). Loading the server copy will discard this device's unsynced changes.`,
			{ okText: "Take server", cancelText: "Keep mine" },
		);
		if (!takeServer) {
			sessionStorage.setItem(dismissKey, String(meta.savedAt));
			return;
		}
	}

	logEvent({
		type: "info",
		text: "Loading the latest version from the server…",
		saveToDb: false,
	});
	startPull(lid, info.syncId, meta.savedAt);
};
