import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	saveSnapshot,
	getLatestSnapshot,
	listLeagues,
	getSnapshotHistory,
	saveSnapshotV2,
	getLatestBySyncId,
	getSyncMeta,
	listSyncLeagues,
	deleteBySyncId,
	saveRecap,
	getRecap,
	listRecaps,
} from "./db.js";
import { tallyBoxScore, generateRecap } from "./recap.js";
import { runTurn } from "./gm-session.js";
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
app.get("/api/v2/pull/:syncId", (req, res) => {
	const row = getLatestBySyncId(req.params.syncId);
	if (!row) return res.status(404).json({ error: "no snapshot for syncId" });
	res.setHeader("Content-Type", "application/json");
	res.send(row.data);
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
	gmTurns.set(turnId, { status: "pending", ts: Date.now() });
	pruneGmTurns();

	const startTime = Date.now();
	console.log(
		`[gm] syncId=${syncId.slice(0, 8)} turn=${turnId.slice(0, 8)} len=${userText.length} imgs=${saved.length}`,
	);

	(async () => {
		try {
			const turn = await runTurn(syncId, promptForGm, dir);
			const reply = (turn.result || "").trim() || "(no response)";
			console.log(
				`[gm] turn=${turnId.slice(0, 8)} done in ${Date.now() - startTime}ms`,
			);
			gmTurns.set(turnId, { status: "done", reply, ts: Date.now() });
		} catch (err) {
			console.error(`[gm] turn=${turnId.slice(0, 8)} error:`, err.message);
			const timedOut = err.timedOut || /timeout/i.test(err.message || "");
			gmTurns.set(turnId, {
				status: "error",
				error: timedOut
					? "That took too long and the session was reset — please try again."
					: `GM chat failed: ${(err.message || "unknown").slice(0, 200)}`,
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
	if (t.status === "done")
		return res.json({ ok: true, status: "done", reply: t.reply });
	if (t.status === "error")
		return res.json({ ok: true, status: "error", error: t.error });
	return res.json({ ok: true, status: "pending" });
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
