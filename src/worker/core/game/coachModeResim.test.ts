import { beforeAll, test, assert } from "vitest";
import { player, team } from "../index.ts";
import loadTeams from "./loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { range } from "../../../common/utils.ts";
import {
	runAndStashLiveSim,
	resimLiveGameWithCoaching,
	clearLiveSimStash,
} from "./liveSimStash.ts";

// Regression for: "Re-sim failed: undefined is not an object (evaluating
// 'i.id')". runAndStashLiveSim used to deep-copy the GameSim inputs AFTER the
// sim mutated them, so the stash held post-game state; re-simming a coaching
// change from it built a starting lineup with undefined players in
// playersOnCourt and crashed in updatePlayersOnCourt. Exercised with a user
// team that has hard minutes targets + a full forced-on five, the real
// conditions that surfaced it. The fix stashes a pristine pre-run copy.

const genTwoTeams = async () => {
	resetG();
	g.setWithoutSavingToDB("season", 2013);
	// Team 0 is the user's team, so minutesTarget survives loadTeams.
	g.setWithoutSavingToDB("userTid", 0);
	g.setWithoutSavingToDB("userTids", [0]);
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
	// Hard minutes plan on the user team's rotation, like the real save.
	for (let i = 0; i < teams[0].player.length && i < 8; i++) {
		teams[0].player[i].minutesTarget = { min: 20, target: 30, max: 34 };
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

beforeAll(async () => {
	await genTwoTeams();
});

test("coaching re-sim works after a live sim (minutes targets + forced five)", async () => {
	clearLiveSimStash();
	const opts = await loadInput();
	const seed = 424242;

	// Original live sim: runs and stashes its (pristine) inputs.
	const original = runAndStashLiveSim(0, opts, seed);
	assert(
		original.playByPlay && original.playByPlay.length > 100,
		"original live sim should produce a full play-by-play",
	);

	// Mirror the UI's coaching apply: force a full five on, clear prior forces.
	const forceFive = opts.teams[0].player.slice(0, 5).map((p: any) => p.id);
	const playByPlay = resimLiveGameWithCoaching(0, [
		{
			period: 4,
			clock: 300,
			pt: {},
			forceOn: forceFive,
			forceOff: [],
			clearForce: true,
		},
	]);

	assert(
		playByPlay !== undefined && playByPlay.length > 100,
		"coaching re-sim must produce a play-by-play, not crash",
	);
});
