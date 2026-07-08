// Radio broadcast — Phase 1: standalone game transcript builder.
//
// Turns a captured /api/sim-game-start packet (the FULL play-by-play event list
// BBGM ships up front at the `init` event, minus "stat" entries) into a
// self-contained, name-resolved broadcast transcript: one line per play with
// period, game clock, running score, and a plain-English call. This is the
// canonical source the later stages (LLM two-voice script → TTS → audio player)
// read from. It has NO dependency on the live /simcast viewer.
//
// Event taxonomy + point values mirror server/recap.js and the interpreter in
// src/ui/util/processLiveGameEvents.basketball.tsx. If BBGM's event types change,
// update all three.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROADCAST_DIR = path.join(
	__dirname,
	"..",
	"data",
	"server",
	"broadcasts",
);
fs.mkdirSync(BROADCAST_DIR, { recursive: true });

const MADE_3PT = new Set(["tp", "tpAndOne"]);
const MADE_2PT = new Set([
	"fgAtRim",
	"fgAtRimAndOne",
	"fgLowPost",
	"fgLowPostAndOne",
	"fgMidRange",
	"fgMidRangeAndOne",
	"fgTipIn",
	"fgTipInAndOne",
	"fgPutBack",
	"fgPutBackAndOne",
]);

// Events that are pure scene-setting / non-attributed — kept in the transcript
// for color but never move the score or possession.
const ordinal = (n) => {
	const s = ["th", "st", "nd", "rd"];
	const v = n % 100;
	return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const mmss = (seconds) => {
	if (seconds === undefined || seconds === null || Number.isNaN(seconds)) {
		return null;
	}
	const s = Math.max(0, Math.round(seconds));
	const m = Math.floor(s / 60);
	const r = s % 60;
	return `${m}:${String(r).padStart(2, "0")}`;
};

/**
 * Build a name/team resolver from the gameStart teams packet.
 * teams[t] = { tid, abbrev, region, name, players: [{ pid, name, pos }] }
 */
function buildResolver(teams) {
	const pidTeam = new Map(); // pid -> 0 | 1
	const pidName = new Map(); // pid -> "First Last"
	teams.forEach((team, t) => {
		for (const p of team?.players ?? []) {
			pidTeam.set(p.pid, t);
			pidName.set(p.pid, p.name);
		}
	});
	const teamLabel = (t) => {
		const team = teams[t];
		if (!team) return "?";
		if (team.region && team.name) return `${team.region} ${team.name}`;
		return team.abbrev ?? "?";
	};
	return {
		name: (pid) => (pid == null ? null : (pidName.get(pid) ?? `#${pid}`)),
		team: (pid) => (pid == null ? undefined : pidTeam.get(pid)),
		teamLabel,
		teamAbbrev: (t) => teams[t]?.abbrev ?? (t === 0 ? "HOME" : "AWAY"),
	};
}

// Plain-English, radio-friendly call for a single event. Deterministic (no
// random variants — the LLM color layer adds flavor later). Assists and fouls
// are appended as clauses. Returns null for events that carry no spoken line
// (raw "stat"/"timeouts" bookkeeping never reach here).
function describe(e, R) {
	const n = (pid) => R.name(pid);
	const t = e.type;

	switch (t) {
		case "period":
			return `Start of the ${ordinal(e.period)} quarter.`;
		case "overtime":
			return `Start of overtime.`;
		case "jumpBall":
			return `${n(e.pid)} wins the opening tip over ${n(e.pid2)}.`;
		// Shot attempts (the wind-up)
		case "fgaAtRim":
			return `${n(e.pid)} drives to the rim`;
		case "fgaLowPost":
			return `${n(e.pid)} works in the low post`;
		case "fgaMidRange":
			return `${n(e.pid)} pulls up from mid-range`;
		case "fgaTp":
			return e.desperation
				? `${n(e.pid)} launches a deep three as the clock winds down`
				: `${n(e.pid)} sets for three`;
		case "fgaTpFake":
			return `${n(e.pid)} rises for a long jumper`;
		case "fgaTipIn":
			return `${n(e.pid)} goes up for the tip`;
		case "fgaPutBack":
			return `${n(e.pid)} goes back up with the offensive board`;
		// Makes
		case "fgAtRim":
		case "fgTipIn":
		case "fgPutBack":
			return `${n(e.pid)} finishes at the rim — good!`;
		case "fgAtRimAndOne":
		case "fgTipInAndOne":
		case "fgPutBackAndOne":
			return `${n(e.pid)} scores at the rim — and the foul!`;
		case "fgLowPost":
			return `${n(e.pid)} scores from the post — good!`;
		case "fgLowPostAndOne":
			return `${n(e.pid)} scores from the post — and one!`;
		case "fgMidRange":
			return `${n(e.pid)} knocks down the mid-range jumper.`;
		case "fgMidRangeAndOne":
			return `${n(e.pid)} hits the jumper — and the foul!`;
		case "tp":
			return `${n(e.pid)} buries the three!`;
		case "tpAndOne":
			return `${n(e.pid)} drills the three — and a foul!`;
		// Misses
		case "missAtRim":
		case "missTipIn":
		case "missPutBack":
			return `${n(e.pid)} misses at the rim.`;
		case "missLowPost":
			return `${n(e.pid)} misses in the post.`;
		case "missMidRange":
			return `${n(e.pid)} misses the mid-range shot.`;
		case "missTp":
			return `${n(e.pid)} is off the mark from three.`;
		// Blocks
		case "blkAtRim":
		case "blkTipIn":
		case "blkPutBack":
		case "blkLowPost":
		case "blkMidRange":
		case "blkTp":
			return `Blocked by ${n(e.pid)}!`;
		// Rebounds
		case "orb":
			return `${n(e.pid)} grabs the offensive rebound.`;
		case "drb":
			return `${n(e.pid)} pulls down the rebound.`;
		// Free throws
		case "ft":
			return `${n(e.pid)} makes the free throw.`;
		case "missFt":
			return `${n(e.pid)} misses the free throw.`;
		// Turnovers / steals
		case "tov":
			return e.outOfBounds
				? `${n(e.pid)} loses it out of bounds.`
				: `${n(e.pid)} turns it over.`;
		case "stl":
			return `${n(e.pid)} steals it from ${n(e.pidTov)}!`;
		// Fouls
		case "pfNonShooting":
			return `Non-shooting foul on ${n(e.pid)}.`;
		case "pfBonus":
			return `Foul on ${n(e.pid)} — they're in the bonus, two shots for ${n(e.pidShooting)}.`;
		case "pfFG":
			return `Shooting foul on ${n(e.pid)} — two at the line for ${n(e.pidShooting)}.`;
		case "pfTP":
			return `Shooting foul on ${n(e.pid)} behind the arc — three at the line for ${n(e.pidShooting)}.`;
		case "foulOut":
			return `${n(e.pid)} has fouled out.`;
		case "injury":
			return `${n(e.pid)} is down injured.`;
		case "sub":
			return null; // substitutions are noise on radio; skip
		case "timeout":
			return `Timeout called.`;
		case "endOfPeriod":
			return `That's the end of the quarter.`;
		case "outOfBounds":
			return `Ball goes out of bounds.`;
		case "gameOver":
			return `That's the ballgame.`;
		default:
			return null; // unknown / non-spoken bookkeeping event
	}
}

/**
 * @param {object} gameStart  { gid, season, day, teams, events }
 * @returns {object} broadcast transcript
 */
export function buildBroadcast(gameStart) {
	const teams = gameStart?.teams ?? [];
	const R = buildResolver(teams);
	const events = Array.isArray(gameStart?.events) ? gameStart.events : [];

	const score = [0, 0];
	// BBGM emits a "period" marker only at the START of Q2/Q3/Q4 (and OT) — the
	// game tips off in Q1 with no marker, so seed at 1, not 0. The first "period"
	// event (start of Q2, e.period=2) then sets it correctly.
	let period = 1;
	const plays = [];

	for (const e of events) {
		if (!e || typeof e.type !== "string") continue;
		if (e.type === "stat" || e.type === "timeouts" || e.type === "init") {
			continue;
		}

		if (e.type === "period") period = e.period ?? period + 1;
		else if (e.type === "overtime") period = e.period ?? period + 1;

		// Score attribution BEFORE emitting the line so the running score reflects
		// the make on the same play (as a real box score / ticker would).
		const scorer = R.team(e.pid);
		if (MADE_3PT.has(e.type) && scorer != null) score[scorer] += 3;
		else if (MADE_2PT.has(e.type) && scorer != null) score[scorer] += 2;
		else if (e.type === "ft" && scorer != null) score[scorer] += 1;

		const text = describe(e, R);
		if (text == null) continue;

		const assisted = e.pidAst != null ? R.name(e.pidAst) : null;
		const line = assisted ? `${text} Assist, ${assisted}.` : text;

		plays.push({
			i: plays.length,
			period,
			clock: mmss(e.clock),
			type: e.type,
			t: scorer != null ? scorer : (e.t ?? null),
			score: [score[0], score[1]],
			text: line,
		});
	}

	const winner = score[0] === score[1] ? null : score[0] > score[1] ? 0 : 1;

	return {
		gid: gameStart?.gid ?? null,
		season: gameStart?.season ?? null,
		day: gameStart?.day ?? null,
		generatedAt: null, // stamped by caller (Date.now is server-side only)
		teams: teams.map((t, i) => ({
			tid: t?.tid,
			abbrev: t?.abbrev,
			label: R.teamLabel(i),
		})),
		finalScore: [score[0], score[1]],
		winner,
		numPlays: plays.length,
		plays,
	};
}

// ── Persistence — one JSON file per game, plus a cheap listing ────────────────

const safeGid = (gid) => String(gid).replace(/[^\w.-]/g, "_");

export function saveBroadcast(broadcast, ts) {
	if (broadcast?.gid == null) throw new Error("broadcast.gid required");
	broadcast.generatedAt = ts ?? null;
	const file = path.join(BROADCAST_DIR, `${safeGid(broadcast.gid)}.json`);
	fs.writeFileSync(file, JSON.stringify(broadcast));
	return file;
}

export function getBroadcast(gid) {
	const file = path.join(BROADCAST_DIR, `${safeGid(gid)}.json`);
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

export function listBroadcasts() {
	let files;
	try {
		files = fs.readdirSync(BROADCAST_DIR).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out = [];
	for (const f of files) {
		try {
			const b = JSON.parse(
				fs.readFileSync(path.join(BROADCAST_DIR, f), "utf8"),
			);
			out.push({
				gid: b.gid,
				season: b.season,
				day: b.day,
				generatedAt: b.generatedAt,
				teams: b.teams,
				finalScore: b.finalScore,
				winner: b.winner,
				numPlays: b.numPlays,
			});
		} catch {
			/* skip corrupt file */
		}
	}
	out.sort((a, b) => (b.generatedAt ?? 0) - (a.generatedAt ?? 0));
	return out;
}

export { BROADCAST_DIR };
