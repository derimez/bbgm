// Seeded PRNG used to make a single live-game simulation reproducible, so it
// can be re-simmed identically up to a pause point and then diverge when a
// coaching change is applied (see the live "coach mode" feature).
//
// GameSim draws randomness two ways: direct `Math.random()` calls and the
// helpers in common/random.ts (which themselves fall back to `Math.random()`
// when no explicit seed is passed). Both funnel through the global
// `Math.random`, so swapping that one function for the duration of a `.run()`
// captures ALL of a game's randomness at a single interception point. The sim
// is synchronous and single-threaded, so nothing else runs in the worker
// during that window — the global swap is safe as long as it's always
// restored (use the returned `restore()` in a finally).

// Mulberry32: tiny, fast, well-distributed 32-bit PRNG. Deterministic for a
// given seed, which is exactly what re-sim needs.
export const mulberry32 = (seed: number): (() => number) => {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

let savedRandom: (() => number) | undefined;

// Replace Math.random with a seeded stream. Returns a restore() that puts the
// native Math.random back. Nested installs are refused (returns a no-op
// restore) so a stray double-install can't strand the native RNG.
export const installSeededRandom = (seed: number): (() => void) => {
	if (savedRandom !== undefined) {
		return () => {};
	}
	savedRandom = Math.random;
	const rng = mulberry32(seed);
	Math.random = rng;
	return () => {
		if (savedRandom !== undefined) {
			Math.random = savedRandom;
			savedRandom = undefined;
		}
	};
};

// Derive a fresh 32-bit seed for a new live game.
export const makeGameSeed = (): number =>
	Math.floor(Math.random() * 0xffffffff) >>> 0;
