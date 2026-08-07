import { GameSim } from "../index.ts";
import { helpers } from "../../util/index.ts";
import { installSeededRandom, makeGameSeed } from "../../util/seededRandom.ts";
import type { GameResults } from "../../../common/types.ts";

// Live "coach mode" support.
//
// A live game is simmed with a fixed RNG seed and its exact GameSim inputs are
// remembered here (keyed by gid) for the duration of the game. That lets the
// user pause and re-sim the SAME game with a mid-game coaching change spliced
// in: same seed + same inputs => the play-by-play is byte-identical up to the
// earliest change and diverges only after it. Basketball live games only.
//
// pendingResult holds the FULL result (not just playByPlay) of the latest sim
// of this game — original at first, replaced by each coaching re-sim. play.ts
// defers writing stats/box/series for a live game until the viewing session
// ends (LiveGame.onLiveSimOver), then commits whatever is here — so a coached
// outcome that diverges from the original is what actually gets saved, instead
// of the original (pre-coaching) result silently being the one that counts.
type StashedLiveSim = {
	opts: any; // the GameSim constructor input (deep-copied — GameSim mutates it)
	seed: number;
	pendingResult: GameResults | undefined;
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
	// Stash a PRISTINE copy of the inputs BEFORE running. GameSim mutates
	// opts.teams during run() (stats accumulate, lineup/roster state changes), so
	// a copy taken afterward holds post-GAME state — re-simming a coaching change
	// from it corrupts the starting-lineup setup (undefined slots in
	// playersOnCourt → "undefined is not an object (evaluating 'i.id')"). Copy
	// first, then run on the original.
	const stashedOpts = helpers.deepCopy(opts);
	const result = runSeeded(opts, seed);
	stash.set(gid, {
		opts: stashedOpts,
		seed,
		pendingResult: result,
	});
	return result;
};

// Re-sim a stashed live game with a coaching schedule applied mid-game. Returns
// the new full play-by-play, or undefined if the game isn't stashed (e.g. the
// worker restarted). The stash is kept so the user can coach again later. Also
// updates pendingResult, so this coached outcome — not the original — is what
// finalizeLiveGame will persist.
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
	stashed.pendingResult = result;
	return result.playByPlay;
};

// The final (possibly coached) result for a still-stashed live game, ready to
// be written to the DB by finalizeLiveGame — and immediately cleared from the
// pending slot on read. onLiveSimOver can fire twice in close succession
// (natural game-over, then component unmount) without an intervening await
// that would let the two calls interleave visibly, but finalizeLiveGame does
// await between reading this and writing — so "take" (read-once) rather than
// "get" (peek) is what keeps a near-simultaneous second call a no-op instead
// of a double-write. Undefined if the game isn't stashed (worker restarted,
// or it was already finalized/cleared).
export const takePendingLiveResult = (gid: number): GameResults | undefined => {
	const stashed = stash.get(gid);
	if (!stashed || !stashed.pendingResult) {
		return undefined;
	}
	const result = stashed.pendingResult;
	stashed.pendingResult = undefined;
	return result;
};

// Peek at the current (possibly coached) result WITHOUT consuming it. The live
// game view uses this to build its box score while the game is still in
// progress — its stats aren't in the `games` store yet (coach mode commits them
// only at finalizeLiveGame). Unlike takePendingLiveResult, this leaves
// pendingResult in place so the eventual finalize still writes it.
export const peekStashedLiveResult = (gid: number): GameResults | undefined =>
	stash.get(gid)?.pendingResult;

export const clearLiveSimStash = (gid?: number) => {
	if (gid === undefined) {
		stash.clear();
	} else {
		stash.delete(gid);
	}
};
