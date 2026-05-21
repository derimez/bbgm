import makeExportStream from "./makeExportStream.ts";
import { local } from "./local.ts";
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

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let syncInProgress = false;

const getLeagueName = (): string => {
	const state = local.getState();
	const { userTid, teamInfoCache, lid } = state;
	if (teamInfoCache && userTid !== undefined && teamInfoCache[userTid]) {
		const t = teamInfoCache[userTid];
		return `${t.region} ${t.name}`;
	}
	return `League ${lid}`;
};

const doSync = async () => {
	if (syncInProgress) return;

	const { lid } = local.getState();
	if (lid === undefined) return;

	syncInProgress = true;
	try {
		const stream = await makeExportStream(ALL_STORES, { compressed: true });
		const reader = stream.getReader();
		const chunks: string[] = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}

		const data = chunks.join("");
		await fetch("/api/sync", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ lid, name: getLeagueName(), data }),
		});
	} catch (err) {
		console.warn("[bbgmSync] sync failed:", err);
	} finally {
		syncInProgress = false;
	}
};

// Debounced: coalesces rapid gameSim events (fast-sim many days) into one sync
export const triggerSync = () => {
	if (debounceTimer !== undefined) {
		clearTimeout(debounceTimer);
	}
	debounceTimer = setTimeout(doSync, 3000);
};
