import { assert, beforeAll, test } from "vitest";
import GameSim from "./index.ts";
import { player, team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { range } from "../../../common/utils.ts";
import { installSeededRandom } from "../../util/seededRandom.ts";

// Bootstrap a minimal 2-team basketball league (same pattern as the football
// GameSim test).
const genTwoTeams = async () => {
	resetG();
	g.setWithoutSavingToDB("season", 2013);
	const teamsDefault = helpers.getTeamsDefault().slice(0, 2);
	await resetCache({
		players: [
			...range(30).map(() => player.generate(0, 25, 2010, true, DEFAULT_LEVEL)),
			...range(30).map(() => player.generate(1, 25, 2010, true, DEFAULT_LEVEL)),
		],
		teams: teamsDefault.map(team.generate),
		teamSeasons: teamsDefault.map((t) => team.genSeasonRow(t)),
		teamStats: teamsDefault.map((t) => team.genStatsRow(t.tid)),
	});
};

const loadInput = async () => {
	const teams = await loadTeams([0, 1], {});
	for (const t of [teams[0], teams[1]]) {
		if (t.depth !== undefined) {
			t.depth = team.getDepthPlayers(t.depth, t.player);
		}
	}
	return {
		gid: 0,
		teams: [teams[0], teams[1]] as [any, any],
		baseInjuryRate: g.get("injuryRate"),
		doPlayByPlay: true,
		homeCourtFactor: 1,
		allStarGame: false,
		neutralSite: false,
	};
};

// Run a seeded game. opts is deep-copied because GameSim mutates opts.teams.
const runSeeded = (opts: any, seed: number, coachingSchedule?: any[]) => {
	const input = helpers.deepCopy(opts);
	if (coachingSchedule) {
		input.coachingSchedule = coachingSchedule;
	}
	const restore = installSeededRandom(seed);
	try {
		return new GameSim(input).run();
	} finally {
		restore();
	}
};

beforeAll(async () => {
	await genTwoTeams();
});

test("same seed reproduces a byte-identical play-by-play", async () => {
	const opts = await loadInput();
	const a = runSeeded(opts, 424242);
	const b = runSeeded(opts, 424242);
	assert.deepStrictEqual(
		a.playByPlay,
		b.playByPlay,
		"identical seed must give identical play-by-play",
	);
	// Sanity: the game actually produced events and a score
	assert(a.playByPlay!.length > 100, "game should have many events");
	assert(a.team[0].stat.pts > 0 && a.team[1].stat.pts > 0, "both teams score");
});

test("different seeds diverge", async () => {
	const opts = await loadInput();
	const a = runSeeded(opts, 1);
	const b = runSeeded(opts, 2);
	assert.notDeepEqual(
		a.playByPlay,
		b.playByPlay,
		"different seeds should diverge",
	);
});

// Longest common prefix of two play-by-play arrays (per-event deep compare).
const commonPrefixLen = (a: any[], b: any[]) => {
	const min = Math.min(a.length, b.length);
	let i = 0;
	while (i < min && JSON.stringify(a[i]) === JSON.stringify(b[i])) {
		i += 1;
	}
	return i;
};

test("coaching change is identical before the trigger, divergent after", async () => {
	const opts = await loadInput();
	const seed = 987654;

	// Baseline (no coaching).
	const base = runSeeded(opts, seed);

	// Force team 0's LAST two roster players onto the court starting in Q2
	// (period 2, 300s left). These deep-bench guys wouldn't normally play Q2, so
	// the tail must change — but Q1 must be untouched.
	const benchPids = opts.teams[0].player.slice(-2).map((p: any) => p.id);
	const coached = runSeeded(opts, seed, [
		{ period: 2, clock: 300, forceOn: benchPids },
	]);

	// The leading "init" event embeds the FINAL box score (a summary, not a
	// chronological play), so it naturally differs between two outcomes. Compare
	// only the chronological play events.
	const chron = (pbp: any[]) => pbp.filter((e) => e.type !== "init");
	const baseChron = chron(base.playByPlay!);
	const coachedChron = chron(coached.playByPlay!);
	const lcp = commonPrefixLen(baseChron, coachedChron);

	// History before the change is preserved (not rewritten from the tip-off).
	assert(lcp > 20, `expected a real shared prefix, got ${lcp} events`);
	// ...and the change actually altered the game.
	assert(
		lcp < baseChron.length,
		"the coaching change must alter the game after the trigger",
	);

	// The first divergent event must be in Q2 or later — proving a Q2 coaching
	// change left ALL of Q1 byte-identical. `period` is only stamped on scoring
	// events, so reconstruct the period at each index by walking the timeline
	// (period/overtime events carry the new period number).
	let curPeriod = 1;
	const periodAtIndex = baseChron.map((e) => {
		if (
			(e.type === "period" || e.type === "overtime") &&
			typeof e.period === "number"
		) {
			curPeriod = e.period;
		}
		return curPeriod;
	});
	assert(
		periodAtIndex[lcp]! >= 2,
		`divergence should start in Q2+, but began in period ${periodAtIndex[lcp]}`,
	);

	// The forced players should have logged real minutes after the change.
	const totalForcedMin = coached.team[0].player
		.filter((p: any) => benchPids.includes(p.id))
		.reduce((sum: number, p: any) => sum + p.stat.min, 0);
	assert(
		totalForcedMin > 0,
		"force-on players must actually play after the change",
	);
});
