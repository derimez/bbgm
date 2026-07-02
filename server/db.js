import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data", "server");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "leagues.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS league_snapshots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    lid       INTEGER NOT NULL,
    saved_at  INTEGER NOT NULL,
    size      INTEGER NOT NULL,
    data      TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lid_saved ON league_snapshots(lid, saved_at DESC);

  -- Keep only the 30 most recent snapshots per league (enforced on write)
  CREATE TABLE IF NOT EXISTS league_meta (
    lid         INTEGER PRIMARY KEY,
    name        TEXT,
    last_saved  INTEGER NOT NULL
  );

  -- Phase 4 — post-game recap cards (one per completed game)
  CREATE TABLE IF NOT EXISTS recaps (
    gid         INTEGER PRIMARY KEY,
    lid         INTEGER,
    season      INTEGER,
    day         INTEGER,
    home_abbrev TEXT,
    away_abbrev TEXT,
    home_score  INTEGER,
    away_score  INTEGER,
    box         TEXT,           -- JSON: tallied box score / top scorers
    recap_text  TEXT,           -- Ollama-generated recap (null until generated)
    model       TEXT,           -- model that produced recap_text
    status      TEXT NOT NULL,  -- 'pending' | 'done' | 'error'
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recaps_created ON recaps(created_at DESC);

  -- Cross-device sync v2 — keyed by a stable syncId that lives INSIDE the league
  -- (gameAttributes), so the same league shares one key across every device
  -- regardless of its local lid. Decouples sync identity from the local lid.
  CREATE TABLE IF NOT EXISTS sync_meta (
    sync_id     TEXT PRIMARY KEY,
    name        TEXT,
    season      INTEGER,
    phase       INTEGER,
    device      TEXT,
    last_saved  INTEGER NOT NULL
  );

  -- Assistant GM — one persistent Claude Code session per league (keyed by the
  -- same stable syncId). session_id is the Claude CLI conversation uuid resumed
  -- each turn; turns is a running count used to bound context (reset after N).
  CREATE TABLE IF NOT EXISTS gm_sessions (
    sync_id      TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    turns        INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
`);

// Migration: add sync_id to the existing snapshots table if it predates v2.
{
	const cols = db.prepare("PRAGMA table_info(league_snapshots)").all();
	if (!cols.some((c) => c.name === "sync_id")) {
		db.exec("ALTER TABLE league_snapshots ADD COLUMN sync_id TEXT");
	}
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_syncid_saved ON league_snapshots(sync_id, saved_at DESC)",
	);
}

const saveSnapshot = db.transaction((lid, data, name) => {
	const now = Date.now();
	db.prepare(
		"INSERT INTO league_snapshots (lid, saved_at, size, data) VALUES (?, ?, ?, ?)",
	).run(lid, now, data.length, data);

	db.prepare(
		"INSERT INTO league_meta (lid, name, last_saved) VALUES (?, ?, ?) ON CONFLICT(lid) DO UPDATE SET name=excluded.name, last_saved=excluded.last_saved",
	).run(lid, name ?? null, now);

	// Prune to 30 snapshots
	db.prepare(`
    DELETE FROM league_snapshots
    WHERE lid = ? AND id NOT IN (
      SELECT id FROM league_snapshots WHERE lid = ? ORDER BY saved_at DESC LIMIT 30
    )
  `).run(lid, lid);

	return now;
});

const getLatestSnapshot = (lid) => {
	return db
		.prepare(
			"SELECT data, saved_at FROM league_snapshots WHERE lid = ? ORDER BY saved_at DESC LIMIT 1",
		)
		.get(lid);
};

const listLeagues = () => {
	return db
		.prepare(
			"SELECT lid, name, last_saved FROM league_meta ORDER BY last_saved DESC",
		)
		.all();
};

const getSnapshotHistory = (lid, limit = 10) => {
	return db
		.prepare(
			"SELECT id, saved_at, size FROM league_snapshots WHERE lid = ? ORDER BY saved_at DESC LIMIT ?",
		)
		.all(lid, limit);
};

// ── Cross-device sync v2 (keyed by syncId) ──────────────────────────────────

// Save a snapshot under a stable syncId. meta carries display/identity fields
// so the dashboard pull-picker can tell leagues apart (they're often all named
// the same team). lid is stored only for debugging/back-compat.
const saveSnapshotV2 = db.transaction((syncId, data, meta = {}) => {
	const now = Date.now();
	db.prepare(
		"INSERT INTO league_snapshots (lid, sync_id, saved_at, size, data) VALUES (?, ?, ?, ?, ?)",
	).run(meta.lid ?? 0, syncId, now, data.length, data);

	db.prepare(
		`INSERT INTO sync_meta (sync_id, name, season, phase, device, last_saved)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sync_id) DO UPDATE SET
       name=excluded.name, season=excluded.season, phase=excluded.phase,
       device=excluded.device, last_saved=excluded.last_saved`,
	).run(
		syncId,
		meta.name ?? null,
		meta.season ?? null,
		meta.phase ?? null,
		meta.device ?? null,
		now,
	);

	// Keep only the 30 most recent snapshots per syncId.
	db.prepare(
		`DELETE FROM league_snapshots
     WHERE sync_id = ? AND id NOT IN (
       SELECT id FROM league_snapshots WHERE sync_id = ? ORDER BY saved_at DESC LIMIT 30
     )`,
	).run(syncId, syncId);

	return now;
});

const getLatestBySyncId = (syncId) =>
	db
		.prepare(
			"SELECT data, saved_at FROM league_snapshots WHERE sync_id = ? ORDER BY saved_at DESC LIMIT 1",
		)
		.get(syncId);

const getSyncMeta = (syncId) =>
	db
		.prepare(
			"SELECT sync_id, name, season, phase, device, last_saved FROM sync_meta WHERE sync_id = ?",
		)
		.get(syncId);

const listSyncLeagues = () =>
	db
		.prepare(
			"SELECT sync_id, name, season, phase, device, last_saved FROM sync_meta ORDER BY last_saved DESC",
		)
		.all();

// Remove a synced league from the server entirely (all snapshots + meta). The
// "Delete from Server" button uses this to counter Sync; the local save is
// untouched.
const deleteBySyncId = db.transaction((syncId) => {
	const snapshots = db
		.prepare("DELETE FROM league_snapshots WHERE sync_id = ?")
		.run(syncId).changes;
	const meta = db
		.prepare("DELETE FROM sync_meta WHERE sync_id = ?")
		.run(syncId).changes;
	return { snapshots, meta };
});

// ── Assistant GM sessions (keyed by syncId) ─────────────────────────────────

const getGmSession = (syncId) =>
	db.prepare("SELECT * FROM gm_sessions WHERE sync_id = ?").get(syncId);

const createGmSession = (syncId, sessionId) => {
	const now = Date.now();
	db.prepare(
		`INSERT INTO gm_sessions (sync_id, session_id, turns, created_at, last_used_at)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(sync_id) DO UPDATE SET
       session_id=excluded.session_id, turns=0,
       created_at=excluded.created_at, last_used_at=excluded.last_used_at`,
	).run(syncId, sessionId, now, now);
	return {
		sync_id: syncId,
		session_id: sessionId,
		turns: 0,
		created_at: now,
		last_used_at: now,
	};
};

const touchGmSession = (syncId) => {
	db.prepare(
		"UPDATE gm_sessions SET turns = turns + 1, last_used_at = ? WHERE sync_id = ?",
	).run(Date.now(), syncId);
};

const deleteGmSession = (syncId) => {
	db.prepare("DELETE FROM gm_sessions WHERE sync_id = ?").run(syncId);
};

// ── Phase 4 — recaps ────────────────────────────────────────────────────────

// Upsert a recap row. Called twice per game: once as 'pending' the moment the
// game ends (so the card shows immediately), then again as 'done'/'error' once
// Ollama returns.
const saveRecap = (r) => {
	const now = Date.now();
	db.prepare(`
    INSERT INTO recaps
      (gid, lid, season, day, home_abbrev, away_abbrev, home_score, away_score,
       box, recap_text, model, status, created_at, updated_at)
    VALUES
      (@gid, @lid, @season, @day, @home_abbrev, @away_abbrev, @home_score, @away_score,
       @box, @recap_text, @model, @status, @created_at, @updated_at)
    ON CONFLICT(gid) DO UPDATE SET
      box        = excluded.box,
      recap_text = excluded.recap_text,
      model      = excluded.model,
      status     = excluded.status,
      updated_at = excluded.updated_at
  `).run({
		gid: r.gid,
		lid: r.lid ?? null,
		season: r.season ?? null,
		day: r.day ?? null,
		home_abbrev: r.home_abbrev ?? null,
		away_abbrev: r.away_abbrev ?? null,
		home_score: r.home_score ?? null,
		away_score: r.away_score ?? null,
		box: r.box ? JSON.stringify(r.box) : null,
		recap_text: r.recap_text ?? null,
		model: r.model ?? null,
		status: r.status,
		created_at: r.created_at ?? now,
		updated_at: now,
	});
	return now;
};

const getRecap = (gid) => {
	const row = db.prepare("SELECT * FROM recaps WHERE gid = ?").get(gid);
	if (row && row.box) row.box = JSON.parse(row.box);
	return row;
};

const listRecaps = (limit = 50) => {
	return db
		.prepare(
			"SELECT gid, lid, season, day, home_abbrev, away_abbrev, home_score, away_score, status, created_at FROM recaps ORDER BY created_at DESC LIMIT ?",
		)
		.all(limit);
};

export {
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
	getGmSession,
	createGmSession,
	touchGmSession,
	deleteGmSession,
};
