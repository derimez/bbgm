import { GameSim } from "../index.ts";
import { helpers } from "../../util/index.ts";
import { installSeededRandom, makeGameSeed } from "../../util/seededRandom.ts";

// Live "coach mode" support.
//
// A live game is simmed with a fixed RNG seed and its exact GameSim inputs are
// remembered here (keyed by gid) for the duration of the game. That lets the
// user pause and re-sim the SAME game with a mid-game coaching change spliced
// in: same seed + same inputs => the play-by-play is byte-identical up to the
// earliest change and diverges only after it. Basketball live games only.

type StashedLiveSim = {
	opts: any; // the GameSim constructor input (deep-copied — GameSim mutates it)
	seed: number;
};

const stash = new Map<number, StashedLiveSim>();

export const makeLiveSimSeed = makeGameSeed;

// Construct + run a GameSim under a fixed RNG seed. The install wraps BOTH
// construction (the opening-lineup jitter draws randomness) and run(), so the
// entire game is reproducible from the seed.
const runSeeded = (opts: any, seed: number) => {
	const restore = installSeededRandom(seed);
	try {
		return new GameSim(opts).run();
	} finally {
		restore();
	}
};

// Sim the original live game (seeded) and stash its inputs for later re-sim.
export const runAndStashLiveSim = (gid: number, opts: any, seed: number) => {
	// Deep-copy: GameSim mutates opts.teams (stats accumulate) during run().
	stash.set(gid, { opts: helpers.deepCopy(opts), seed });
	return runSeeded(opts, seed);
};

// Re-sim a stashed live game with a coaching schedule applied mid-game. Returns
// the new full play-by-play, or undefined if the game isn't stashed (e.g. the
// worker restarted). The stash is kept so the user can coach again later.
export const resimLiveGameWithCoaching = (
	gid: number,
	coachingSchedule: any[],
) => {
	const stashed = stash.get(gid);
	if (!stashed) {
		return undefined;
	}
	const opts = helpers.deepCopy(stashed.opts);
	opts.coachingSchedule = coachingSchedule;
	const result = runSeeded(opts, stashed.seed);
	return result.playByPlay;
};

export const clearLiveSimStash = (gid?: number) => {
	if (gid === undefined) {
		stash.clear();
	} else {
		stash.delete(gid);
	}
};
