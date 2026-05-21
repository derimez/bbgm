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
`);

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

export { saveSnapshot, getLatestSnapshot, listLeagues, getSnapshotHistory };
