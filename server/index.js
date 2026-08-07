import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
	saveSnapshot,
	getLatestSnapshot,
	listLeagues,
	getSnapshotHistory,
	saveSnapshotV2,
	boxScoresFileFor,
	getLatestBySyncId,
	getSyncMeta,
	listSyncLeagues,
	deleteBySyncId,
	saveRecap,
	getRecap,
	listRecaps,
} from "./db.js";
import { tallyBoxScore, generateRecap } from "./recap.js";
import {
	buildBroadcast,
	saveBroadcast,
	getBroadcast,
	listBroadcasts,
} from "./broadcast.js";
import {
	buildScript,
	saveScript,
	getScript,
	hasScript,
	scriptFile,
} from "./broadcast-script.js";
import {
	renderAudio,
	hasAudio,
	getManifest,
	resolveAudioPath,
	renderText,
	cachedTextPath,
	TTS_ENABLED,
} from "./broadcast-audio.js";
import {
	enqueue,
	queueState,
	resetBreaker,
	QueueFullError,
	BreakerOpenError,
} from "./gpu-queue.js";
import { runTurn, resetSession } from "./gm-session.js";
import { ensureWorkdir, saveAttachments } from "./gm-workdir.js";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, "..", "build");
const PORT = process.env.PORT ?? 3018;

const app = express();
const server = createServer(app);

// WebSocket server for simcast events (Phase 3)
const wss = new WebSocketServer({ server, path: "/api/simcast" });
const simcastClients = new Set();

// Latest gameStart packet — replayed to clients that connect mid-game
let lastGameStart = null;
// Ring buffer of recent events so newly-connected clients can catch up to the
// current play. Capped to avoid unbounded memory if a viewer is never opened.
const RECENT_EVENT_CAP = 400;
const recentEvents = [];

// Full event log for the CURRENT game, used to tally a complete box score for the
// post-game recap (the recentEvents ring buffer above is capped and only feeds
// late-joiner catch-up). Reset on every gameStart.
let gameEventLog = [];

wss.on("connection", (ws) => {
	simcastClients.add(ws);
	if (lastGameStart) {
		ws.send(JSON.stringify({ kind: "gameStart", ...lastGameStart }));
		for (const ev of recentEvents) {
			ws.send(JSON.stringify({ kind: "event", ...ev }));
		}
	}
	ws.on("close", () => simcastClients.delete(ws));
});

const broadcast = (msg) => {
	const str = JSON.stringify(msg);
	for (const ws of simcastClients) {
		if (ws.readyState === 1) ws.send(str);
	}
};

// Lightweight request logger — log path, body summary, and User-Agent fragment.
// Registered BEFORE express.json so an oversize body that the parser rejects
// (413) is still logged — otherwise a too-large push fails completely silently.
app.use((req, _res, next) => {
	if (req.path.startsWith("/api/")) {
		const ua = (req.headers["user-agent"] ?? "").slice(0, 40);
		const ref = (req.headers.referer ?? "").slice(0, 60);
		const len = req.headers["content-length"];
		console.log(
			`[api] ${req.method} ${req.path}${len ? ` (${len}b)` : ""}  ref=${ref}`,
		);
	}
	next();
});

// Parse JSON bodies. League sync envelopes embed the whole league JSON as a
// string (quote-escaped, so larger than the raw export) — keep generous headroom
// so a multi-season dynasty never silently 413s.
app.use(express.json({ limit: "200mb" }));

// Surface body-parser failures (esp. 413 PayloadTooLarge) instead of letting
// them die as an opaque connection error on the client.
app.use((err, req, res, next) => {
	if (err && (err.type === "entity.too.large" || err.status === 413)) {
		console.error(`[api] 413 too large on ${req.method} ${req.path}`);
		return res
			.status(413)
			.json({ error: "League too large to sync (payload exceeds limit)" });
	}
	if (err && err.status >= 400 && err.status < 500) {
		console.error(
			`[api] ${err.status} body parse on ${req.path}: ${err.message}`,
		);
		return res.status(err.status).json({ error: err.message });
	}
	next(err);
});

// ── Sync API ──────────────────────────────────────────────────────────────────

// POST /api/sync  { lid, name, data }
// data is the full league JSON string
app.post("/api/sync", (req, res) => {
	const { lid, name, data } = req.body;
	if (typeof lid !== "number" || typeof data !== "string") {
		return res
			.status(400)
			.json({ error: "lid (number) and data (string) required" });
	}
	try {
		const savedAt = saveSnapshot(lid, data, name);
		res.json({ ok: true, savedAt });
	} catch (err) {
		console.error("Sync save error:", err);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/sync/:lid  → latest snapshot
app.get("/api/sync/:lid", (req, res) => {
	const lid = parseInt(req.params.lid, 10);
	if (isNaN(lid)) return res.status(400).json({ error: "invalid lid" });

	const row = getLatestSnapshot(lid);
	if (!row) return res.status(404).json({ error: "no snapshot found" });

	res.json({ ok: true, savedAt: row.saved_at, data: row.data });
});

// GET /api/sync/:lid/history
app.get("/api/sync/:lid/history", (req, res) => {
	const lid = parseInt(req.params.lid, 10);
	if (isNaN(lid)) return res.status(400).json({ error: "invalid lid" });
	res.json(getSnapshotHistory(lid));
});

// GET /api/leagues
app.get("/api/leagues", (_req, res) => {
	res.json(listLeagues());
});

// GET /api/restore/:lid  → raw JSON data string for #importUrl= consumption
app.get("/api/restore/:lid", (req, res) => {
	const lid = parseInt(req.params.lid, 10);
	if (isNaN(lid)) return res.status(400).json({ error: "invalid lid" });

	const row = getLatestSnapshot(lid);
	if (!row) return res.status(404).json({ error: "no snapshot found" });

	res.setHeader("Content-Type", "application/json");
	res.send(row.data);
});

// ── Cross-device sync v2 — keyed by syncId (stable across devices) ──────────────

// POST /api/v2/sync  { syncId, name, season, phase, device, data }
// Manual "Sync ⬆" button pushes the full league here, keyed by its syncId.
app.post("/api/v2/sync", (req, res) => {
	const { syncId, name, season, phase, device, lid, data } = req.body;
	if (typeof syncId !== "string" || !syncId || typeof data !== "string") {
		return res
			.status(400)
			.json({ error: "syncId (string) and data (string) required" });
	}
	try {
		const savedAt = saveSnapshotV2(syncId, data, {
			name,
			season,
			phase,
			device,
			lid,
		});
		res.json({ ok: true, savedAt });
	} catch (err) {
		console.error("v2 sync save error:", err);
		res.status(500).json({ error: err.message });
	}
});

// GET /api/v2/meta/:syncId → cheap freshness check (no data payload)
// Auto-pull-on-load hits this first to decide whether a download is needed.
app.get("/api/v2/meta/:syncId", (req, res) => {
	const meta = getSyncMeta(req.params.syncId);
	if (!meta) return res.status(404).json({ error: "no snapshot for syncId" });
	res.json({ ok: true, ...meta, savedAt: meta.last_saved });
});

// GET /api/v2/pull/:syncId → raw league JSON for createLeague({url}) import
//
// The stored snapshot has its `games` store split out (see splitBoxScores in
// db.js — keeps the 30-deep snapshot history lean). But BBGM's own import path
// computes maxGid by scanning `games` in the incoming stream (see "Need to
// store max gid from games, so generated schedule does not overwrite it" in
// leagueFileUpload.ts) — if games is absent, maxGid falls back to -1 and the
// importer renumbers every schedule entry starting near 0, colliding with
// real early-season game ids and losing all box score history on the
// receiving device. So a pull specifically (unlike the stored snapshot) must
// merge games back in before serving.
app.get("/api/v2/pull/:syncId", (req, res) => {
	const row = getLatestBySyncId(req.params.syncId);
	if (!row) return res.status(404).json({ error: "no snapshot for syncId" });

	let payload = row.data;
	try {
		const boxScoresPath = boxScoresFileFor(req.params.syncId);
		if (fs.existsSync(boxScoresPath)) {
			const games = JSON.parse(fs.readFileSync(boxScoresPath, "utf8"));
			const league = JSON.parse(row.data);
			league.games = games;
			payload = JSON.stringify(league);
		}
	} catch (err) {
		console.error(
			`[pull] failed to merge box scores for ${req.params.syncId}:`,
			err.message,
		);
		// Fall through and serve without games rather than fail the pull outright —
		// same degraded (but at least functional for stats/roster) behavior as before this fix.
	}

	res.setHeader("Content-Type", "application/json");
	res.send(payload);
});

// GET /api/v2/leagues → all known synced leagues (for a pull-picker UI)
app.get("/api/v2/leagues", (_req, res) => {
	res.json(listSyncLeagues());
});

// DELETE /api/v2/sync/:syncId → remove a synced league from the server.
// Counters Sync; the local save on each device is unaffected.
app.delete("/api/v2/sync/:syncId", (req, res) => {
	try {
		const result = deleteBySyncId(req.params.syncId);
		res.json({ ok: true, ...result });
	} catch (err) {
		console.error("v2 delete error:", err);
		res.status(500).json({ error: err.message });
	}
});

// ── Assistant GM — Claude-backed in-app chat ────────────────────────────────
//
// The GM reads the league's latest synced snapshot (materialized to a per-league
// working dir) and maintains persistent memory there. Turns run detached and are
// polled, so the answer survives the PWA backgrounding mid-turn (mirrors the
// command-center family-chat pattern). Same-origin from the BBGM frontend, so it
// works on desktop and the iPhone PWA (Tailscale HTTPS) with no CORS/cert work.

const gmTurns = new Map(); // turnId → { status, reply?, error?, ts }
const GM_TURN_TTL_MS = 30 * 60 * 1000;
const pruneGmTurns = () => {
	const cutoff = Date.now() - GM_TURN_TTL_MS;
	for (const [id, t] of gmTurns) {
		if (t.ts < cutoff) gmTurns.delete(id);
	}
};

// POST /api/gm/chat  { syncId, prompt, attachments?: [{ name, dataUrl }] }
app.post("/api/gm/chat", (req, res) => {
	const { syncId, prompt, attachments } = req.body || {};
	const userText = String(prompt || "").trim();
	if (typeof syncId !== "string" || !syncId) {
		return res.status(400).json({ error: "syncId (string) required" });
	}
	const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
	if (!userText && !hasAttachments) {
		return res.status(400).json({ error: "Missing prompt" });
	}

	const row = getLatestBySyncId(syncId);
	if (!row) {
		return res.status(409).json({
			error:
				"This league hasn't synced to the server yet — tap Sync and try again.",
		});
	}

	const meta = getSyncMeta(syncId) || {};
	let dir;
	let saved = [];
	try {
		dir = ensureWorkdir(syncId, row.data, meta);
		saved = saveAttachments(syncId, attachments);
	} catch (err) {
		console.error("[gm] workdir error:", err);
		return res.status(500).json({ error: "Could not prepare GM workspace" });
	}

	// Tell the GM where any pasted images landed so it can Read them. They live
	// in the workdir (cwd), referenced by relative path.
	let promptForGm = userText || "Take a look at the attached image(s).";
	if (saved.length > 0) {
		promptForGm +=
			"\n\n" +
			saved
				.map(
					(a) =>
						`[The user attached a file "${a.name}", saved to: ${a.rel} — use your Read tool to view it.]`,
				)
				.join("\n");
	}

	const turnId = randomUUID();
	// `steps` accumulates the GM's live thinking / tool activity so the client can
	// render it as it happens (polled), the way the Claude app streams its work.
	gmTurns.set(turnId, { status: "pending", ts: Date.now(), steps: [] });
	pruneGmTurns();

	// Keep the timeline bounded — a long tool-heavy turn shouldn't grow unbounded.
	const MAX_STEPS = 400;
	const clip = (s) => (s.length > 4000 ? `${s.slice(0, 4000)}…` : s);
	const onEvent = (ev) => {
		const rec = gmTurns.get(turnId);
		if (!rec || !Array.isArray(rec.steps) || rec.steps.length >= MAX_STEPS)
			return;
		if (ev.kind === "tool") {
			rec.steps.push({ kind: "tool", name: ev.name, summary: ev.summary });
		} else if (ev.kind === "thinking" || ev.kind === "text") {
			rec.steps.push({ kind: ev.kind, text: clip(ev.text) });
		}
	};

	const startTime = Date.now();
	console.log(
		`[gm] syncId=${syncId.slice(0, 8)} turn=${turnId.slice(0, 8)} len=${userText.length} imgs=${saved.length}`,
	);

	(async () => {
		try {
			const turn = await runTurn(syncId, promptForGm, dir, onEvent);
			const reply = (turn.result || "").trim() || "(no response)";
			console.log(
				`[gm] turn=${turnId.slice(0, 8)} done in ${Date.now() - startTime}ms`,
			);
			const prev = gmTurns.get(turnId);
			gmTurns.set(turnId, {
				status: "done",
				reply,
				// isNew === true means runTurn spawned a *fresh* Claude session for
				// this turn (the prior --resume thread was gone — reset, timeout, or
				// a server restart). The client uses it to flag that the model can't
				// see the conversation above, so the visible transcript and the
				// model's memory don't silently diverge.
				isNew: turn.isNew === true,
				steps: prev?.steps || [],
				ts: Date.now(),
			});
		} catch (err) {
			console.error(`[gm] turn=${turnId.slice(0, 8)} error:`, err.message);
			const timedOut = err.timedOut || /timeout/i.test(err.message || "");
			const prev = gmTurns.get(turnId);
			gmTurns.set(turnId, {
				status: "error",
				error: timedOut
					? "That took too long and the session was reset — please try again."
					: `GM chat failed: ${(err.message || "unknown").slice(0, 200)}`,
				steps: prev?.steps || [],
				ts: Date.now(),
			});
		}
	})();

	res.json({ ok: true, turnId, status: "pending" });
});

// GET /api/gm/chat/result/:turnId
app.get("/api/gm/chat/result/:turnId", (req, res) => {
	pruneGmTurns();
	const t = gmTurns.get(req.params.turnId);
	if (!t) return res.json({ ok: true, status: "unknown" });
	const steps = t.steps || [];
	if (t.status === "done")
		return res.json({
			ok: true,
			status: "done",
			reply: t.reply,
			isNew: t.isNew === true,
			steps,
		});
	if (t.status === "error")
		return res.json({ ok: true, status: "error", error: t.error, steps });
	return res.json({ ok: true, status: "pending", steps });
});

// POST /api/gm/reset  { syncId } → drop the resumed Claude conversation for this
// league. The next message spawns a fresh session, so it re-reads CLAUDE.md /
// SCHEMA.md and sheds any stale framing. Backs the client's `/clear` command
// (which otherwise only wipes the local transcript). GM-MEMORY.md is untouched.
app.post("/api/gm/reset", (req, res) => {
	const { syncId } = req.body || {};
	if (!syncId || typeof syncId !== "string") {
		return res.status(400).json({ ok: false, error: "Missing syncId" });
	}
	try {
		resetSession(syncId);
		res.json({ ok: true });
	} catch (err) {
		res.status(500).json({ ok: false, error: err.message });
	}
});

// GET /api/gm/status/:syncId → freshness + memory presence for the modal header
app.get("/api/gm/status/:syncId", (req, res) => {
	const meta = getSyncMeta(req.params.syncId);
	res.json({
		ok: true,
		synced: !!meta,
		lastSyncedAt: meta?.last_saved ?? null,
		name: meta?.name ?? null,
		season: meta?.season ?? null,
	});
});

// GET /api/overrides/:which  → realTeamInfo / realPlayerPhotos override maps,
// built from the dynasty by server/scripts/build-overrides.mjs. Injected into
// the meta DB (attributes store) before generating a real-roster league so the
// wizard shows real NBA names and generation bakes in real player photos.
app.get("/api/overrides/:which", (req, res) => {
	const map = {
		realTeamInfo: "override_realTeamInfo.json",
		realPlayerPhotos: "override_realPlayerPhotos.json",
	};
	const file = map[req.params.which];
	if (!file) return res.status(404).json({ error: "unknown override" });
	res.setHeader("Content-Type", "application/json");
	res.sendFile(path.join(__dirname, "..", "data", "server", file));
});

// GET /api/import-file/knicks  → serve the Knicks Dynasty league JSON for auto-import
app.get("/api/import-file/knicks", (_req, res) => {
	const filePath = path.join(
		__dirname,
		"..",
		"data",
		"server",
		"knicks_dynasty_import.json",
	);
	res.setHeader("Content-Type", "application/json");
	res.sendFile(filePath);
});

// ── Phase 3 simcast — receive events from worker, fan out to WS clients ────

app.post("/api/sim-game-start", (req, res) => {
	const { gid, lid, season, day, teams, events } = req.body ?? {};
	if (!Array.isArray(teams) || teams.length !== 2) {
		return res.status(400).json({ error: "teams (2) required" });
	}
	lastGameStart = {
		gid,
		lid,
		season,
		day,
		teams,
		events: Array.isArray(events) ? events : [],
		startedAt: Date.now(),
	};
	recentEvents.length = 0;
	gameEventLog = [];
	broadcast({ kind: "gameStart", ...lastGameStart });

	// Radio broadcast — the gameStart packet carries the ENTIRE game's event list
	// up front (BBGM ships it at the `init` event), so we can build and persist a
	// complete, self-contained transcript immediately — no playback, no dependency
	// on the live /simcast viewer. Best-effort: a capture failure must never break
	// the sim/simcast pipeline.
	try {
		if (lastGameStart.gid != null && lastGameStart.events.length > 0) {
			const transcript = buildBroadcast(lastGameStart);
			saveBroadcast(transcript, Date.now());
			console.log(
				`[broadcast] gid=${lastGameStart.gid} captured ${transcript.numPlays} plays ` +
					`(${transcript.teams[0]?.abbrev} ${transcript.finalScore[0]}-${transcript.finalScore[1]} ${transcript.teams[1]?.abbrev})`,
			);
		}
	} catch (err) {
		console.error(`[broadcast] capture failed:`, err.message);
	}

	res.json({ ok: true });
});

// ── Playback control (Phase 1) — BBGM's LiveGame is the master clock ──────────
// BBGM fires this on every processToNextPause advance (its real playback heartbeat,
// throttled) carrying the current game clock, and on pause/play carrying { paused }.
// Simcast derives its live gameRate from the cadence of these ticks and freezes on
// pause, so the court view tracks BBGM's speed slider / fast-forward / pause 1:1.
// Fire-and-forget: never persisted, just fanned out to connected simcast clients.
app.post("/api/sim-control", (req, res) => {
	const { paused, gameClock, gameOver, period } = req.body ?? {};
	broadcast({ kind: "control", paused, gameClock, gameOver, period });
	res.json({ ok: true });
});

// ── Live coach mode — mid-game re-sim splice ─────────────────────────────────
// After a coaching change, BBGM's LiveGame re-sims the rest of the game (same
// seed, so the prefix is byte-identical) and POSTs the FULL new event list here
// (same filtering as the gameStart packet: init + "stat" entries stripped).
// Connected simcast clients swap in everything they haven't fired yet; the
// stored packet is updated so late joiners replay the coached game.
app.post("/api/sim-splice", (req, res) => {
	const { gid, events } = req.body ?? {};
	if (!Array.isArray(events)) {
		return res.status(400).json({ error: "events array required" });
	}
	if (lastGameStart) {
		lastGameStart.events = events;
	}
	broadcast({ kind: "eventsSplice", gid, events });
	res.json({ ok: true });
});

// Kick off recap generation for a finished game. Fire-and-forget: a 'pending'
// row is written immediately so the card appears in the browse-back UI, then the
// row is upgraded to 'done' (or 'error') once Ollama returns. All failures are
// swallowed — a missing recap must never break the sim pipeline.
function triggerRecap(gameStart, events) {
	if (!gameStart || gameStart.gid == null) return;
	const { gid, lid, season, day, teams } = gameStart;
	let box;
	try {
		box = tallyBoxScore(gameStart, events);
	} catch (err) {
		console.error(`[recap] tally failed gid=${gid}:`, err.message);
		return;
	}
	const base = {
		gid,
		lid,
		season,
		day,
		home_abbrev: box.abbrev[0],
		away_abbrev: box.abbrev[1],
		home_score: box.score[0],
		away_score: box.score[1],
		box,
	};
	try {
		saveRecap({ ...base, status: "pending" });
	} catch (err) {
		console.error(`[recap] pending save failed gid=${gid}:`, err.message);
		return;
	}
	console.log(
		`[recap] gid=${gid} ${box.abbrev[0]} ${box.score[0]}-${box.score[1]} ${box.abbrev[1]} → generating…`,
	);
	generateRecap(box, { season, day })
		.then(({ text, model }) => {
			saveRecap({ ...base, recap_text: text, model, status: "done" });
			console.log(`[recap] gid=${gid} done (${model})`);
		})
		.catch((err) => {
			saveRecap({ ...base, status: "error", recap_text: err.message });
			console.error(`[recap] gid=${gid} generation failed:`, err.message);
		});
}

app.post("/api/sim-event", (req, res) => {
	const { gid, seq, event } = req.body ?? {};
	if (!event || typeof event.type !== "string") {
		return res.status(400).json({ error: "event.type required" });
	}
	const payload = { gid, seq, event };
	recentEvents.push(payload);
	if (recentEvents.length > RECENT_EVENT_CAP) {
		recentEvents.splice(0, recentEvents.length - RECENT_EVENT_CAP);
	}
	gameEventLog.push(event);
	broadcast({ kind: "event", ...payload });
	if (event.type === "gameOver") {
		// Generate a recap from the full game log BEFORE clearing it.
		triggerRecap(lastGameStart, gameEventLog);
		// Stop replaying this game's tail to new connections — otherwise opening
		// a fresh simcast tab after the game ends just shows a stale FINAL state.
		// Clients that were live during the game already have the full sequence.
		lastGameStart = null;
		recentEvents.length = 0;
		gameEventLog = [];
	}
	res.json({ ok: true });
});

// ── Phase 4 — recap browse-back API + UI ────────────────────────────────────

// GET /api/recaps  → list of completed games (most recent first)
app.get("/api/recaps", (_req, res) => {
	res.json(listRecaps());
});

// GET /api/recap/:gid  → one recap card (box score + prose + status)
app.get("/api/recap/:gid", (req, res) => {
	const gid = parseInt(req.params.gid, 10);
	if (isNaN(gid)) return res.status(400).json({ error: "invalid gid" });
	const row = getRecap(gid);
	if (!row) return res.status(404).json({ error: "no recap for that game" });
	res.json(row);
});

// GET /recaps  → browse-back UI
app.get("/recaps", (_req, res) => {
	res.sendFile(path.join(__dirname, "public", "recaps.html"));
});

// ── Radio broadcast — captured game transcripts ─────────────────────────────

// GET /api/broadcasts → list of captured games (most recent first).
// ?safe=1 returns a SPOILER-SAFE projection: matchup + date only, with score,
// winner, and play-count stripped (play-count leaks OT / a close finish). The
// in-app picker always uses safe=1 so you can pick a game to listen to without
// learning the result first.
app.get("/api/broadcasts", (req, res) => {
	const list = listBroadcasts();
	if (req.query.safe === "1") {
		return res.json(
			list.map((b) => ({
				gid: b.gid,
				season: b.season,
				day: b.day,
				generatedAt: b.generatedAt,
				teams: b.teams?.map((t) => ({
					tid: t.tid,
					abbrev: t.abbrev,
					label: t.label,
				})),
			})),
		);
	}
	res.json(list);
});

// GET /api/broadcast/:gid → one full transcript (teams + plays)
app.get("/api/broadcast/:gid", (req, res) => {
	const b = getBroadcast(req.params.gid);
	if (!b) return res.status(404).json({ error: "no broadcast for that game" });
	res.json(b);
});

// GET /broadcast → viewer UI
app.get("/broadcast", (_req, res) => {
	res.sendFile(path.join(__dirname, "public", "broadcast.html"));
});

// ── Radio broadcast Phase 2 — two-voice announcer script ────────────────────
//
// Script generation runs a local LLM over every segment of a game (2–3 min for
// a full game), so it can't be a synchronous request. POST kicks off a
// background job; the client polls the status endpoint; GET returns the cached
// script when done. One job per game at a time; a finished script is cached on
// disk and reused.
// 503 = card is out of action (breaker open); 429 = we're just backed up.
function gpuQueueHttpStatus(err) {
	if (err instanceof BreakerOpenError) return 503;
	if (err instanceof QueueFullError) return 429;
	throw err;
}

// GET /api/gpu-queue → breaker state, what's rendering, what's waiting.
app.get("/api/gpu-queue", (_req, res) => res.json(queueState()));

// POST /api/gpu-queue/reset → clear the breaker after the card is confirmed back
// (in practice: after a reboot). Queued jobs are already blocked; resubmit them.
app.post("/api/gpu-queue/reset", (_req, res) =>
	res.json({ was: resetBreaker(), now: queueState() }),
);

const scriptJobs = new Map(); // gid -> { status, done, total, error, startedAt }

// Script generation runs a local LLM on the GPU, so it queues behind (and ahead
// of) TTS renders rather than competing with them for the card. See gpu-queue.js.
function runScriptJob(gid, broadcast) {
	const job = { status: "queued", done: 0, total: 0, error: null };
	scriptJobs.set(String(gid), job);
	return enqueue({
		kind: "script",
		gid,
		onBlocked: (reason) => {
			job.status = "blocked";
			job.error = reason;
		},
		run: async () => {
			job.status = "running";
			try {
				const script = await buildScript(broadcast, {
					onProgress: ({ done, total }) => {
						job.done = done;
						job.total = total;
					},
				});
				saveScript(script, Date.now());
				job.status = "done";
				console.log(
					`[broadcast-script] gid=${gid} done — ${script.numSegments} segments, ` +
						`${script.numUtterances} lines, ${script.llmFailures} fallback(s)`,
				);
			} catch (err) {
				job.status = "error";
				job.error = err.message;
				console.error(`[broadcast-script] gid=${gid} job failed:`, err.message);
				throw err; // let the queue's breaker see it
			}
		},
	});
}

// POST /api/broadcast/:gid/script → start (or reuse) two-voice script generation.
// ?force=1 regenerates even if a cached script exists.
app.post("/api/broadcast/:gid/script", (req, res) => {
	const gid = req.params.gid;
	if (req.query.force !== "1" && hasScript(gid)) {
		return res.json({ status: "done", cached: true });
	}
	const existing = scriptJobs.get(String(gid));
	if (
		existing &&
		(existing.status === "running" || existing.status === "queued")
	) {
		return res.json({
			status: existing.status,
			done: existing.done,
			total: existing.total,
		});
	}
	const broadcast = getBroadcast(gid);
	if (!broadcast) {
		return res
			.status(404)
			.json({ error: "no broadcast transcript for that game" });
	}
	try {
		const { position } = runScriptJob(gid, broadcast);
		res.status(202).json({ status: "queued", position, done: 0, total: 0 });
	} catch (err) {
		res.status(gpuQueueHttpStatus(err)).json({ error: err.message });
	}
});

// GET /api/broadcast/:gid/script/status → poll job progress.
app.get("/api/broadcast/:gid/script/status", (req, res) => {
	const gid = req.params.gid;
	const job = scriptJobs.get(String(gid));
	if (job) return res.json(job);
	if (hasScript(gid)) return res.json({ status: "done", done: 1, total: 1 });
	res.json({ status: "none" });
});

// GET /api/broadcast/:gid/script → the finished two-voice script.
app.get("/api/broadcast/:gid/script", (req, res) => {
	const s = getScript(req.params.gid);
	if (!s) return res.status(404).json({ error: "script not generated yet" });
	res.json(s);
});

// ── Radio broadcast Phase 3 — Kokoro TTS audio ──────────────────────────────
//
// Renders the Phase-2 script to a single stitched two-voice audio file via the
// Python Kokoro renderer (a few minutes for a full game — background job, same
// shape as scriptJobs). The finished mp3 + timing manifest are cached on disk
// and streamed to the in-app player, which uses the manifest's per-segment
// startSec/scoreEnd to reveal the score progressively (spoiler-safe).
const audioJobs = new Map(); // gid -> { status, done, total, error }

function runAudioJob(gid) {
	const job = { status: "queued", done: 0, total: 0, error: null };
	audioJobs.set(String(gid), job);
	return enqueue({
		kind: "audio",
		gid,
		onBlocked: (reason) => {
			job.status = "blocked";
			job.error = reason;
		},
		run: async () => {
			job.status = "running";
			try {
				await renderAudio(gid, scriptFile(gid), {
					onProgress: ({ done, total }) => {
						job.done = done;
						job.total = total;
					},
				});
				job.status = "done";
				const m = getManifest(gid);
				console.log(
					`[broadcast-audio] gid=${gid} done — ${m?.numUtterances ?? "?"} lines, ` +
						`${m ? (m.durationSec / 60).toFixed(1) : "?"} min`,
				);
			} catch (err) {
				job.status = "error";
				job.error = err.message;
				console.error(`[broadcast-audio] gid=${gid} job failed:`, err.message);
				throw err; // let the queue's breaker see it
			}
		},
	});
}

// POST /api/broadcast/:gid/audio → start (or reuse) TTS rendering. Requires the
// Phase-2 script to exist first. ?force=1 re-renders even if cached.
app.post("/api/broadcast/:gid/audio", (req, res) => {
	const gid = req.params.gid;
	if (req.query.force !== "1" && hasAudio(gid)) {
		return res.json({ status: "done", cached: true });
	}
	// Refuse before the job reaches the GPU queue, so a disabled render can't
	// trip the breaker or burn its retries.
	if (!TTS_ENABLED) {
		return res
			.status(503)
			.json({ error: "TTS disabled (GPU fault 2026-07-09); set BBGM_TTS=1" });
	}
	const existing = audioJobs.get(String(gid));
	if (
		existing &&
		(existing.status === "running" || existing.status === "queued")
	) {
		return res.json({
			status: existing.status,
			done: existing.done,
			total: existing.total,
		});
	}
	if (!hasScript(gid)) {
		return res
			.status(409)
			.json({ error: "generate the announcer script first" });
	}
	try {
		const { position } = runAudioJob(gid);
		res.status(202).json({ status: "queued", position, done: 0, total: 0 });
	} catch (err) {
		res.status(gpuQueueHttpStatus(err)).json({ error: err.message });
	}
});

// GET /api/broadcast/:gid/audio/status → poll render progress.
app.get("/api/broadcast/:gid/audio/status", (req, res) => {
	const gid = req.params.gid;
	const job = audioJobs.get(String(gid));
	if (job) return res.json(job);
	if (hasAudio(gid)) return res.json({ status: "done", done: 1, total: 1 });
	res.json({ status: "none" });
});

// GET /api/broadcast/:gid/audio → the timing manifest (durationSec + per-segment
// startSec/score reveal). The player fetches this, then streams .../audio/stream.
app.get("/api/broadcast/:gid/audio", (req, res) => {
	const m = getManifest(req.params.gid);
	if (!m) return res.status(404).json({ error: "audio not rendered yet" });
	res.json(m);
});

// GET /api/broadcast/:gid/audio/stream → the stitched audio file (Range-enabled
// via res.sendFile so the player can seek/scrub).
app.get("/api/broadcast/:gid/audio/stream", (req, res) => {
	const p = resolveAudioPath(req.params.gid);
	if (!p) return res.status(404).json({ error: "audio not rendered yet" });
	res.sendFile(p);
});

// POST /api/tts { text, voice? } → speak arbitrary text in a cloned voice and
// stream back the mp3. Powers the AGM "speak this reply" button (default = Breen).
// Cached by content hash, so a repeat of the same text returns instantly.
app.post("/api/tts", async (req, res) => {
	const text = (req.body?.text ?? "").toString();
	const voice = (req.body?.voice ?? "pbp").toString();
	if (!text.trim()) return res.status(400).json({ error: "text required" });
	// Cap length so a giant GM reply can't tie up the GPU for minutes.
	const capped = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;

	// Checked before the cache lookup so the kill switch stays authoritative:
	// cachedTextPath() reads voices.json and can throw, which would otherwise
	// mask this with a 500.
	if (!TTS_ENABLED) {
		return res
			.status(503)
			.json({ error: "TTS disabled (GPU fault 2026-07-09); set BBGM_TTS=1" });
	}

	// A cache hit is pure disk — always safe, even mid-render.
	const cached = cachedTextPath(capped, voice);
	if (cached) return res.type("audio/mpeg").sendFile(cached);

	// Otherwise this would put a second ROCm stream on the card alongside a
	// broadcast render, which is what wedged the GPU on 2026-07-09. Refuse rather
	// than contend; the render finishes and the button works again.
	const q = queueState();
	if (q.breaker.open) {
		return res
			.status(503)
			.json({ error: `GPU circuit breaker open: ${q.breaker.reason}` });
	}
	if (q.active) {
		return res.status(503).json({
			error: `GPU busy rendering ${q.active.kind} for game ${q.active.gid} — try again when it finishes`,
			active: q.active,
		});
	}
	try {
		const mp3 = await renderText(capped, voice);
		res.type("audio/mpeg").sendFile(mp3);
	} catch (err) {
		console.error("[tts] speak failed:", err.message);
		res.status(500).json({ error: err.message });
	}
});

// ── Phase 2 animation spike — standalone Pixi.js viewer ─────────────────────
app.get("/simcast-spike", (_req, res) => {
	res.sendFile(path.join(__dirname, "public", "simcast-spike.html"));
});
app.use(
	"/simcast-spike/static",
	express.static(path.join(__dirname, "public")),
);

// ── Phase 3 live simcast viewer ─────────────────────────────────────────────
app.get("/simcast", (_req, res) => {
	res.sendFile(path.join(__dirname, "public", "simcast.html"));
});
app.use("/simcast/static", express.static(path.join(__dirname, "public")));

// ── Static: serve ZenGM build ─────────────────────────────────────────────────
app.use(express.static(BUILD_DIR));

// SPA fallback — but NOT for asset-looking requests. A stale lazy chunk (e.g.
// /gen/exportLeague-OLDHASH.js after a redeploy) must 404 cleanly, not get
// index.html — otherwise the browser tries to run HTML as JS and throws
// "'text/html' is not a valid JavaScript MIME type". Real navigation routes
// (no file extension) still get index.html.
app.use((req, res) => {
	const reqPath = req.path.split("?")[0];
	const looksLikeAsset =
		reqPath.startsWith("/gen/") || /\.[a-z0-9]+$/i.test(reqPath);
	if (looksLikeAsset) {
		return res.status(404).type("text/plain").send("Not found");
	}
	res.sendFile(path.join(BUILD_DIR, "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`BBGM server running on :${PORT}`);
	console.log(`  Game:    http://localhost:${PORT}/`);
	console.log(`  Sync:    http://localhost:${PORT}/api/sync`);
	console.log(`  WS:      ws://localhost:${PORT}/api/simcast`);
});
