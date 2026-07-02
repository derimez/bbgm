import { PHASE, PLAYER } from "../../common/constants.ts";
import { idb } from "../db/index.ts";
import { g } from "../util/index.ts";
import { isSport } from "../../common/sportFunctions.ts";

// Radar axes: each is shown as a percentile (0-100) vs all qualifying players
// that season. All of these stats are already computed in
// processPlayerStats.basketball.ts and are loaded onto p.stats via
// getPlayerProfileStats(). pts is the only counting stat here, so we fetch with
// statType "perGame" to make it comparable; the rest are rate/advanced stats
// that are independent of perGame/totals.
export const RADAR_METRICS = [
	{ stat: "pts", name: "Scoring" },
	{ stat: "tsp", name: "Efficiency" },
	{ stat: "astp", name: "Playmaking" },
	{ stat: "trbp", name: "Rebounding" },
	{ stat: "dbpm", name: "Defense" },
	{ stat: "per", name: "Overall" },
] as const;

export type RadarAxis = {
	stat: string;
	name: string;
	value: number;
	percentile: number;
};

export type PlayerAnalytics = {
	metrics: { stat: string; name: string }[];
	// Keyed by season -> one entry per radar metric
	radarBySeason: Record<number, RadarAxis[]>;
};

// Midrank percentile of `value` within `values` (0-100). Players tied with the
// target split the difference so the percentile is stable.
const percentileOf = (value: number, values: number[]): number => {
	const n = values.length;
	if (n === 0) {
		return 50;
	}

	let below = 0;
	let equal = 0;
	for (const v of values) {
		if (v < value) {
			below += 1;
		} else if (v === value) {
			equal += 1;
		}
	}

	return ((below + 0.5 * equal) / n) * 100;
};

export const getPlayerAnalytics = async (p: {
	pid: number;
	stats: any[];
}): Promise<PlayerAnalytics | undefined> => {
	// Advanced percentile radar only makes sense for basketball
	if (!isSport("basketball")) {
		return undefined;
	}

	// Distinct regular-season seasons the player actually played
	const seasons = Array.from(
		new Set(
			p.stats
				.filter((row) => !row.playoffs && row.gp > 0)
				.map((row) => row.season),
		),
	);
	if (seasons.length === 0) {
		return undefined;
	}

	const radarStats = RADAR_METRICS.map((m) => m.stat);
	const radarBySeason: Record<number, RadarAxis[]> = {};

	for (const season of seasons) {
		let playersAll;
		if (g.get("season") === season && g.get("phase") <= PHASE.PLAYOFFS) {
			playersAll = await idb.cache.players.indexGetAll("playersByTid", [
				PLAYER.FREE_AGENT,
				Infinity,
			]);
		} else {
			playersAll = await idb.getCopies.players(
				{ activeSeason: season },
				"noCopyCache",
			);
		}

		const players = await idb.getCopies.playersPlus(playersAll, {
			attrs: ["pid"],
			stats: ["gp", "min", ...radarStats],
			season,
			statType: "perGame",
			regularSeason: true,
			mergeStats: "totOnly",
			fuzz: true,
		});

		const withStats = players.filter((p2) => p2.stats && p2.stats.gp > 0);
		const me = withStats.find((p2) => p2.pid === p.pid);
		if (!me) {
			continue;
		}

		// Qualifying pool: rotation players that season, so percentiles aren't
		// skewed by deep-bench scrubs. Scale the games threshold to season length.
		const maxGp = Math.max(1, ...withStats.map((p2) => p2.stats.gp));
		const minGp = Math.max(5, 0.25 * maxGp);
		let pool = withStats.filter(
			(p2) => p2.stats.gp >= minGp && p2.stats.min >= 8,
		);

		// Always rank the player against the pool, even if he didn't qualify
		if (!pool.some((p2) => p2.pid === p.pid)) {
			pool = [...pool, me];
		}

		radarBySeason[season] = RADAR_METRICS.map((m) => {
			const value = me.stats[m.stat] ?? 0;
			const values = pool.map((p2) => p2.stats[m.stat] ?? 0);
			return {
				stat: m.stat,
				name: m.name,
				value,
				percentile: percentileOf(value, values),
			};
		});
	}

	if (Object.keys(radarBySeason).length === 0) {
		return undefined;
	}

	return {
		metrics: RADAR_METRICS.map((m) => ({ stat: m.stat, name: m.name })),
		radarBySeason,
	};
};
