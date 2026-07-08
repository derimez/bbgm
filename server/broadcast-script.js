// Radio broadcast — Phase 2: two-voice announcer script generator.
//
// Takes a Phase-1 transcript (server/broadcast.js buildBroadcast output) and
// rewrites it as a live two-announcer radio script:
//   - BREEN  → play-by-play voice (Mike Breen style): calls every play.
//   - CLYDE  → color analyst (Walt "Clyde" Frazier style): sparse, vivid color.
//
// The transcript's deterministic `plays` are chunked (per quarter, then capped
// at N plays) and each chunk is handed to a local Ollama model, which returns
// prefixed announcer lines we parse into ordered utterances. Every chunk has a
// deterministic fallback (the raw play-by-play text) so a model/network failure
// degrades one segment to plain PBP instead of losing the game.
//
// Reuses the exact Ollama pattern from server/recap.js: /api/chat, think:false,
// qwen3:8b. No BBGM rebuild required — this is server-side only. The output is
// the canonical source the later TTS + in-app player stages read from.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.join(
	__dirname,
	"..",
	"data",
	"server",
	"broadcast-scripts",
);
fs.mkdirSync(SCRIPT_DIR, { recursive: true });

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
// Same model recap.js settled on — qwen3:8b via /api/chat + think:false emits
// clean prose with no reasoning traces. Override with BBGM_BROADCAST_MODEL.
const SCRIPT_MODEL = process.env.BBGM_BROADCAST_MODEL ?? "qwen3:8b";
const CHUNK_TIMEOUT_MS = Number(
	process.env.BBGM_BROADCAST_TIMEOUT_MS ?? 90_000,
);
const PLAYS_PER_CHUNK = Number(process.env.BBGM_BROADCAST_CHUNK ?? 12);

// ── Chunking ────────────────────────────────────────────────────────────────

/**
 * Split the flat play list into broadcast segments. A new segment starts at
 * every quarter/overtime boundary and whenever the current one reaches `size`
 * plays. Each segment is annotated with the running score entering and leaving
 * it (for progressive, spoiler-free score reveal in the player) and whether it
 * closes out a period (so BREEN reads the score to end the quarter).
 */
function chunkPlays(plays, size) {
	const chunks = [];
	let cur = null;
	for (const p of plays) {
		const isBreak = p.type === "period" || p.type === "overtime";
		if (!cur || isBreak || cur.plays.length >= size) {
			cur = { period: p.period, plays: [] };
			chunks.push(cur);
		}
		cur.plays.push(p);
		cur.period = p.period;
	}
	let prev = [0, 0];
	chunks.forEach((c, idx) => {
		c.scoreStart = [...prev];
		const last = c.plays[c.plays.length - 1];
		c.scoreEnd = last?.score ? [...last.score] : [...prev];
		prev = c.scoreEnd;
		const next = chunks[idx + 1];
		c.endsPeriod = !next || next.period > c.period;
	});
	return chunks;
}

// Plays that are pure scene markers — they carry no spoken action for the
// announcers to call (the quarter start is set by the prompt's segment header).
const isMarker = (p) => p.type === "period" || p.type === "overtime";

const quarterLabel = (period) =>
	period > 4 ? (period === 5 ? "overtime" : `${period - 4}OT`) : `Q${period}`;

// Walt "Clyde" Frazier's signature rhyming vocabulary. Each chunk is an
// independent LLM call, so priming every one with the same few examples makes
// the model parrot them game-wide ("dishing and swishing" 17x). We instead show
// a ROTATING subset per chunk (by index) so different segments reach for
// different phrases → variety across the whole broadcast.
const CLYDE_ISMS = [
	"dishing and swishing",
	"posting and toasting",
	"moving without improving",
	"hustling and bustling",
	"shaking and baking",
	"wheeling and dealing",
	"spinning and winning",
	"slicing and dicing",
	"stumbling and bumbling",
	"huffing and stuffing",
	"swooping and hooping",
	"driving and diving",
];

function clydePalette(chunkIndex) {
	const n = CLYDE_ISMS.length;
	return [0, 1, 2].map((k) => CLYDE_ISMS[(chunkIndex * 3 + k) % n]);
}

// ── Prompt ────────────────────────────────────────────────────────────────

function buildChunkPrompt(chunk, ctx, chunkIndex) {
	const [home, away] = ctx.teamLabels;
	const [ha, aa] = ctx.teamAbbrevs;
	// Ground every play with the running score so any score the announcer states
	// is correct — the model must never invent numbers. The (score: …) tag is a
	// reference only; the parser also strips it in case the model echoes it.
	const lines = chunk.plays
		.filter((p) => !isMarker(p))
		.map(
			(p, i) =>
				`${i + 1}. [${p.clock ?? ""}] ${p.text} (score: ${ha} ${p.score?.[0] ?? "?"}, ${aa} ${p.score?.[1] ?? "?"})`,
		)
		.join("\n");
	const ql = quarterLabel(chunk.period);
	const closer = chunk.endsPeriod
		? `\nThis segment ENDS ${ql}. Close it out with BREEN reading the exact score: ${home} ${chunk.scoreEnd[0]}, ${away} ${chunk.scoreEnd[1]}.`
		: "";
	const isms = clydePalette(chunkIndex);

	return `You are scripting a live NBA radio broadcast with TWO announcers:
- BREEN: the play-by-play voice, in the style of Mike Breen. Crisp, energetic, calls the action as it happens. Says "Bang!" on a big three-pointer. States the score at natural breaks.
- CLYDE: the color analyst, in the style of Walt "Clyde" Frazier. He chimes in after the notable moments — a three, a big finish, a block, a turnover, a scoring run — but stays quiet through routine possessions. Aim for one Clyde line for every two or three of Breen's calls. Each line is concrete analysis of that moment, occasionally seasoned with a signature rhyme (e.g. "${isms[0]}", "${isms[1]}", "${isms[2]}"). Use those rhymes sparingly and never the same one twice; never tack on a stock tag like "that's the way to go".

Game: ${home} (home) vs ${away} (away). Segment: ${ql}. Score entering this segment — ${home} ${chunk.scoreStart[0]}, ${away} ${chunk.scoreStart[1]}.

Call these plays IN ORDER. Reference ONLY the players and events listed below — invent no players or storylines. State ONLY the scores shown in parentheses; never make up a number. The "(score: …)" tags are for YOUR reference only — NEVER write them in your output:
${lines}${closer}

Output ONLY announcer lines, one per line, each beginning with "BREEN:" or "CLYDE:". BREEN carries the play-by-play for every play; MOST plays get a BREEN call with NO Clyde line. CLYDE speaks at most once per three BREEN calls, and never twice in a row. Vary Clyde's phrasing — do not repeat yourself. No stage directions, no blank lines, no headers, no other text.`;
}

// ── Parsing ────────────────────────────────────────────────────────────────

// Map a line prefix to a voice. Accept the persona names and generic tags so a
// slightly-off model still parses.
const VOICE_BY_TAG = {
	BREEN: "pbp",
	PBP: "pbp",
	CLYDE: "color",
	FRAZIER: "color",
	COLOR: "color",
};

function parseTwoVoice(raw) {
	const clean = (raw ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
	const utts = [];
	for (const rawLine of clean.split("\n")) {
		const m = rawLine.match(
			/^\s*(BREEN|PBP|CLYDE|FRAZIER|COLOR)\s*[:\-–]\s*(.+?)\s*$/i,
		);
		if (!m) continue;
		const voice = VOICE_BY_TAG[m[1].toUpperCase()];
		// Strip any echoed "(score: IND 0, NYK 2)" grounding tag and wrapping
		// quotes — those are prompt scaffolding, not something to speak aloud.
		const text = m[2]
			.replace(/\s*\(score:[^)]*\)/gi, "")
			.replace(/^["“']+|["”']+$/g, "")
			.trim();
		if (voice && text) utts.push({ voice, text });
	}
	return utts;
}

// Enforce color sparsity structurally, independent of model compliance: allow a
// CLYDE line only once enough BREEN calls have accumulated (≤ ~1 color per 3
// pbp), preserving order. This also spaces them out, so a chatty model can't
// produce a 1:1 back-and-forth. Extra color lines are dropped, not reordered.
function thinColor(utts) {
	let pbp = 0;
	let color = 0;
	const out = [];
	for (const u of utts) {
		if (u.voice === "pbp") {
			pbp++;
			out.push(u);
		} else if (color < Math.floor(pbp / 3)) {
			color++;
			out.push(u);
		}
	}
	return out;
}

// Deterministic degrade: one PBP utterance per real play. Never loses a segment.
function fallbackUtterances(chunk) {
	return chunk.plays
		.filter((p) => !isMarker(p))
		.map((p) => ({ voice: "pbp", text: p.text }));
}

// ── Ollama ────────────────────────────────────────────────────────────────

async function callOllama(prompt) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
	try {
		const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: SCRIPT_MODEL,
				messages: [{ role: "user", content: prompt }],
				stream: false,
				think: false,
				options: { temperature: 0.8, num_predict: 700 },
			}),
			signal: controller.signal,
		});
		if (!resp.ok) {
			throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
		}
		const json = await resp.json();
		return json.message?.content ?? "";
	} finally {
		clearTimeout(timer);
	}
}

// ── Build ──────────────────────────────────────────────────────────────────

/**
 * Generate the two-voice script for a Phase-1 broadcast transcript.
 * @param {object} broadcast  buildBroadcast() output
 * @param {{chunkSize?:number, onProgress?:(p:{done:number,total:number})=>void}} opts
 * @returns {Promise<object>} script { gid, teams, finalScore, segments:[...] }
 */
export async function buildScript(broadcast, opts = {}) {
	const onProgress = opts.onProgress ?? (() => {});
	const size = opts.chunkSize ?? PLAYS_PER_CHUNK;
	const teamLabels = [
		broadcast.teams?.[0]?.label ?? "Home",
		broadcast.teams?.[1]?.label ?? "Away",
	];
	const teamAbbrevs = [
		broadcast.teams?.[0]?.abbrev ?? "HOME",
		broadcast.teams?.[1]?.abbrev ?? "AWAY",
	];
	const ctx = { teamLabels, teamAbbrevs };
	const chunks = chunkPlays(broadcast.plays ?? [], size);

	const segments = [];
	let llmFailures = 0;
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		let utterances;
		try {
			const raw = await callOllama(buildChunkPrompt(chunk, ctx, i));
			utterances = thinColor(parseTwoVoice(raw));
			if (!utterances.length) {
				utterances = fallbackUtterances(chunk);
				llmFailures++;
			}
		} catch (err) {
			utterances = fallbackUtterances(chunk);
			llmFailures++;
			console.error(
				`[broadcast-script] gid=${broadcast.gid} chunk ${i} failed: ${err.message}`,
			);
		}
		segments.push({
			i,
			period: chunk.period,
			endsPeriod: chunk.endsPeriod,
			scoreStart: chunk.scoreStart,
			scoreEnd: chunk.scoreEnd,
			utterances,
		});
		onProgress({ done: i + 1, total: chunks.length });
	}

	return {
		gid: broadcast.gid,
		season: broadcast.season,
		day: broadcast.day,
		generatedAt: null, // stamped by saveScript
		model: SCRIPT_MODEL,
		teams: broadcast.teams,
		finalScore: broadcast.finalScore,
		winner: broadcast.winner,
		numSegments: segments.length,
		numUtterances: segments.reduce((n, s) => n + s.utterances.length, 0),
		llmFailures,
		segments,
	};
}

// ── Persistence ──────────────────────────────────────────────────────────────

const safeGid = (gid) => String(gid).replace(/[^\w.-]/g, "_");

export function scriptFile(gid) {
	return path.join(SCRIPT_DIR, `${safeGid(gid)}.json`);
}

export function saveScript(script, ts) {
	if (script?.gid == null) throw new Error("script.gid required");
	script.generatedAt = ts ?? null;
	const file = scriptFile(script.gid);
	fs.writeFileSync(file, JSON.stringify(script));
	return file;
}

export function getScript(gid) {
	const file = scriptFile(gid);
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

export function hasScript(gid) {
	return fs.existsSync(scriptFile(gid));
}

export { SCRIPT_DIR, SCRIPT_MODEL };
