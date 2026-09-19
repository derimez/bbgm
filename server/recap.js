// Phase 4 — post-game recap generation.
//
// Two responsibilities:
//   1. tallyBoxScore() — derive final score + per-player/per-team stats from the
//      raw event stream. Event semantics are kept IN SYNC with the interpreter in
//      server/public/simcast.html (the made-FG list + point values below mirror
//      its scoring switch). If BBGM's event taxonomy changes, update both.
//   2. generateRecap() — feed a compact game summary to Claude and return a 2–3
//      paragraph sports-reporter recap. Model failures throw; the caller
//      (index.js) swallows them so a recap is best-effort, never fatal.

import { claudeText } from "./claude-llm.js";

// Was qwen3:8b on local Ollama until 2026-09-05, when Ollama was retired with
// the Mac mini migration. haiku is the default because recaps are per-game and
// high-volume; set BBGM_RECAP_MODEL=sonnet for better prose.
const RECAP_MODEL = process.env.BBGM_RECAP_MODEL ?? "haiku";
const RECAP_TIMEOUT_MS = Number(process.env.BBGM_RECAP_TIMEOUT_MS ?? 60_000);

// Made-FG event types → point value. Mirrors simcast.html lines ~2323-2340.
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
// "ft" is a made free throw (1 pt); "missFt" is a miss. Standard BBGM taxonomy.

const teamLabel = (team) => {
	if (!team) return "?";
	if (team.region && team.name) return `${team.region} ${team.name}`;
	return team.abbrev ?? "?";
};

const nameForPid = (team, pid) =>
	team?.players?.find?.((p) => p.pid === pid)?.name ?? `#${pid}`;

/**
 * Reduce a full game's event log into a structured box score.
 * @param {{teams: any[], season?: number, day?: number}} gameStart
 * @param {Array<{type:string,t:number,pid?:number,pidAst?:number}>} events
 */
export function tallyBoxScore(gameStart, events) {
	const teams = gameStart?.teams ?? [];
	const score = [0, 0];
	// per-team aggregate
	const team = [
		{
			fgm: 0,
			fga: 0,
			tpm: 0,
			tpa: 0,
			ftm: 0,
			fta: 0,
			ast: 0,
			reb: 0,
			tov: 0,
			stl: 0,
			blk: 0,
		},
		{
			fgm: 0,
			fga: 0,
			tpm: 0,
			tpa: 0,
			ftm: 0,
			fta: 0,
			ast: 0,
			reb: 0,
			tov: 0,
			stl: 0,
			blk: 0,
		},
	];
	// per-player points (pid -> { t, pts, ast, reb })
	const players = new Map();
	const bump = (t, pid, field, n = 1) => {
		if (pid === undefined || pid === null) return;
		if (!players.has(pid)) players.set(pid, { t, pts: 0, ast: 0, reb: 0 });
		players.get(pid)[field] += n;
	};

	for (const ev of events ?? []) {
		const t = ev.t;
		if (t !== 0 && t !== 1) continue;
		const type = ev.type;

		if (MADE_3PT.has(type) || MADE_2PT.has(type)) {
			const pts = MADE_3PT.has(type) ? 3 : 2;
			score[t] += pts;
			team[t].fgm++;
			team[t].fga++;
			if (MADE_3PT.has(type)) {
				team[t].tpm++;
				team[t].tpa++;
			}
			bump(t, ev.pid, "pts", pts);
			if (ev.pidAst !== undefined && ev.pidAst !== null) {
				team[t].ast++;
				bump(t, ev.pidAst, "ast");
			}
		} else if (type?.startsWith("miss")) {
			team[t].fga++;
			if (type === "missTp") team[t].tpa++;
			if (type === "missFt") team[t].fta++;
		} else if (type === "ft") {
			score[t] += 1;
			team[t].ftm++;
			team[t].fta++;
			bump(t, ev.pid, "pts", 1);
		} else if (type === "drb" || type === "orb") {
			team[t].reb++;
			bump(t, ev.pid, "reb");
		} else if (type === "tov") {
			team[t].tov++;
		} else if (type === "stl") {
			team[t].stl++;
		} else if (type?.startsWith("blk")) {
			team[t].blk++;
		}
	}

	// Top 3 scorers per team
	const topScorers = [[], []];
	for (const [pid, s] of players) {
		topScorers[s.t].push({ pid, name: nameForPid(teams[s.t], pid), ...s });
	}
	for (const t of [0, 1]) {
		topScorers[t].sort((a, b) => b.pts - a.pts);
		topScorers[t] = topScorers[t].slice(0, 3);
	}

	return {
		teams: [teamLabel(teams[0]), teamLabel(teams[1])],
		abbrev: [teams[0]?.abbrev ?? "HOME", teams[1]?.abbrev ?? "AWAY"],
		score,
		team,
		topScorers,
		winner: score[0] === score[1] ? null : score[0] > score[1] ? 0 : 1,
	};
}

function buildPrompt(box, meta) {
	const [home, away] = box.teams;
	const [hs, as] = box.score;
	const seasonLine = meta?.season != null ? `Season ${meta.season}` : "";
	const line = (t) => {
		const s = box.team[t];
		const tops = box.topScorers[t]
			.map((p) => `${p.name} ${p.pts}pts/${p.ast}ast/${p.reb}reb`)
			.join(", ");
		return `${box.teams[t]} (${box.score[t]}): FG ${s.fgm}/${s.fga}, 3P ${s.tpm}/${s.tpa}, FT ${s.ftm}/${s.fta}, AST ${s.ast}, REB ${s.reb}, TOV ${s.tov}. Leaders: ${tops}`;
	};
	return `You are a sports reporter writing a short game recap for a basketball box score.

${seasonLine}
Final: ${home} ${hs}, ${away} ${as}

${line(0)}
${line(1)}

Write a punchy 2-3 paragraph recap in a professional sports-reporter voice. Lead with the result and the standout performer. Do not invent stats, quotes, dates, or storylines beyond what the numbers support. No headline, no markdown — just the prose.`;
}

// Strip any preamble the model prepends (e.g. a leading "Assistant" line).
function cleanOutput(raw) {
	return (raw ?? "")
		.replace(/^\s*assistant\s*/i, "")
		.trim();
}

/**
 * Generate recap prose via Claude. Throws on model/timeout failure.
 * @returns {Promise<{text: string, model: string}>}
 */
export async function generateRecap(box, meta = {}) {
	const prompt = buildPrompt(box, meta);
	const raw = await claudeText(prompt, {
		model: RECAP_MODEL,
		timeoutMs: RECAP_TIMEOUT_MS,
		budgetUsd: 0.1,
	});
	const text = cleanOutput(raw);
	if (!text) throw new Error("claude returned empty recap");
	return { text, model: RECAP_MODEL };
}

export { RECAP_MODEL };
