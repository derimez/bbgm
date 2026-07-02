// Phase 4 — post-game recap generation.
//
// Two responsibilities:
//   1. tallyBoxScore() — derive final score + per-player/per-team stats from the
//      raw event stream. Event semantics are kept IN SYNC with the interpreter in
//      server/public/simcast.html (the made-FG list + point values below mirror
//      its scoring switch). If BBGM's event taxonomy changes, update both.
//   2. generateRecap() — feed a compact game summary to a local Ollama model and
//      return a 2–3 paragraph sports-reporter recap. Network/model failures throw;
//      the caller (index.js) swallows them so a recap is best-effort, never fatal.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
// Plan decision #15 locked qwen2.5:7b, but it isn't pulled locally. qwen3:8b is
// installed and, via /api/chat with think:false, produces clean prose with no
// reasoning traces. (qwen3-fast's Modelfile is broken — it emits empty output.)
// Override with BBGM_RECAP_MODEL if you later pull qwen2.5:7b.
const RECAP_MODEL = process.env.BBGM_RECAP_MODEL ?? "qwen3:8b";
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

// Defensively strip any reasoning artifacts some qwen3 variants prepend even
// with think:false (e.g. a leading "Assistant" line or empty <think></think>).
function cleanOutput(raw) {
	return (raw ?? "")
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/^\s*assistant\s*/i, "")
		.trim();
}

/**
 * Generate recap prose via Ollama. Throws on network/model/timeout failure.
 * @returns {Promise<{text: string, model: string}>}
 */
export async function generateRecap(box, meta = {}) {
	const prompt = buildPrompt(box, meta);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), RECAP_TIMEOUT_MS);
	try {
		// Use /api/chat (not /api/generate) — qwen3 chat models need it. think:false
		// suppresses reasoning so recap_text is clean prose.
		const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: RECAP_MODEL,
				messages: [{ role: "user", content: prompt }],
				stream: false,
				think: false,
				options: { temperature: 0.7, num_predict: 600 },
			}),
			signal: controller.signal,
		});
		if (!resp.ok) {
			throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
		}
		const json = await resp.json();
		const text = cleanOutput(json.message?.content ?? "");
		if (!text) throw new Error("Ollama returned empty response");
		return { text, model: RECAP_MODEL };
	} finally {
		clearTimeout(timer);
	}
}

export { RECAP_MODEL, OLLAMA_URL };
