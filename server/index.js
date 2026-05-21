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
} from "./db.js";

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

// Parse JSON bodies up to 50MB (league exports can be large)
app.use(express.json({ limit: "50mb" }));

// Lightweight request logger — log path, body summary, and User-Agent fragment
app.use((req, _res, next) => {
	if (req.path.startsWith("/api/")) {
		const evType = req.body?.event?.type ?? "";
		const ua = (req.headers["user-agent"] ?? "").slice(0, 40);
		const ref = (req.headers.referer ?? "").slice(0, 60);
		console.log(
			`[api] ${req.method} ${req.path}${evType ? " " + evType : ""}  ref=${ref}`,
		);
	}
	next();
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
	broadcast({ kind: "gameStart", ...lastGameStart });
	res.json({ ok: true });
});

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
	broadcast({ kind: "event", ...payload });
	if (event.type === "gameOver") {
		// Stop replaying this game's tail to new connections — otherwise opening
		// a fresh simcast tab after the game ends just shows a stale FINAL state.
		// Clients that were live during the game already have the full sequence.
		lastGameStart = null;
		recentEvents.length = 0;
	}
	res.json({ ok: true });
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

// SPA fallback
app.use((_req, res) => {
	res.sendFile(path.join(BUILD_DIR, "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`BBGM server running on :${PORT}`);
	console.log(`  Game:    http://localhost:${PORT}/`);
	console.log(`  Sync:    http://localhost:${PORT}/api/sync`);
	console.log(`  WS:      ws://localhost:${PORT}/api/simcast`);
});
