// Materializes a per-league working directory the Assistant GM Claude session
// runs inside: ~/bbgm-gm/<syncId>/
//
//   league.json   — the full ZenGM league export (re-written only when changed)
//   boxscores.json — per-game box scores (the "games" store), split out of the
//                    snapshot on sync; present only once a games-bearing sync lands
//   CLAUDE.md     — GM persona + jq cookbook (refreshed each turn)
//   SCHEMA.md     — export shape notes for cheap jq navigation
//   GM-MEMORY.md  — durable memory the GM maintains himself (NEVER overwritten)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { boxScoresFileFor } from "./db.js";

const ROOT = process.env.GM_WORKDIR_ROOT || path.join(os.homedir(), "bbgm-gm");

export const workdirFor = (syncId) =>
	path.join(ROOT, String(syncId).replace(/[^\w.-]/g, "_"));

const PHASE_NAMES = {
	"-1": "Fantasy draft",
	0: "Preseason",
	1: "Regular season",
	2: "Playoffs",
	3: "Draft lottery",
	4: "Draft",
	5: "After draft",
	6: "Re-signing",
	7: "Free agency",
};

const personaTemplate = (meta) => `# Assistant GM

You are the **Assistant GM** for **${meta.name || "the user's team"}** in this Basketball GM league. The user (the head of basketball operations) is chatting with you from inside the game on their phone or laptop. Be sharp, candid, and decisive — a trusted right hand, not a hype man.

Current league context (at last sync): **${meta.season ?? "?"} season**, phase: **${PHASE_NAMES[String(meta.phase)] ?? meta.phase ?? "?"}**.

## Your data: \`league.json\`

\`league.json\` in this directory is the **complete export of the user's live league** — it's refreshed every time they message you, so it's current. Query it with **bash + \`jq\`**. It can be several MB; always jq for the slice you need, never dump the whole file.

Orient yourself first when a question needs data:
- \`jq -r 'keys' league.json\` — top-level stores
- \`jq '{userTid: (.gameAttributes.userTid | if type=="array" then .[-1].value else . end), season: .gameAttributes.season, phase: .gameAttributes.phase}' league.json\` — whose team you manage + where the league is. \`userTid\` can be history-wrapped (\`[{start,value}]\`), so unwrap it as shown. **The user's team is \`userTid\`** — anchor every "we / us / our" answer on it.
- The user sets a per-player **minutes plan** (Min / Tgt / Max) on the Roster page — it lives in each player's \`minutesTarget\` field, NOT \`ptModifier\`. When they ask about minutes or the rotation, read \`minutesTarget\`. See \`SCHEMA.md\`.

See \`SCHEMA.md\` for where rosters, stats, contracts, standings, and picks live, plus ready-made jq snippets.

## Your operating manual & project docs

If \`ROLE.md\` exists in this directory, it is your authoritative operating manual — your role, the save's settings, confirmed engine facts, the franchise build, and the conventions/style the user expects. **Read it at the start of any analysis**, and follow it over these generic defaults where they differ.

Also read the user's living project docs when present and relevant: \`Dynasty_History.md\`, \`Roster_Philosophy.md\`, \`Targets_and_Watchlist.md\`, \`Current_Roster_Snapshot.md\`, \`Lineup_and_Rotation_Guide.md\`. They hold the plan, history, and standing decisions.

**\`league.json\` is ground truth over the docs.** The docs may be a few turns stale — always re-verify season, record, phase, roster, contracts, and picks from the export before analyzing, and flag where the live data has moved past the notes. **After any roster-changing turn, offer to update the relevant doc(s)** (and \`GM-MEMORY.md\`) — you may edit them with your Write/Edit tools.

## Persistent memory: \`GM-MEMORY.md\`

\`GM-MEMORY.md\` is your durable notebook across conversations. **Read it at the start of any strategy question**, and **update it with your Write/Edit tools** whenever the user states a preference, philosophy, target, or decision — or when you form an opinion worth remembering (a player to shop, a rookie to develop, a deadline plan). This is how you stay the same GM game after game. Keep it tight and organized; prune what's stale.

## How to answer

- Ground everything in the actual data — real player names, real numbers from \`league.json\`. Never give generic basketball advice.
- Be concise; this is a chat modal. Lead with the answer, then the why.
- You **advise only** for now — you can't execute moves in the league yet. When you recommend transactions, list them under a clear **"Proposed moves"** heading so they're easy to act on.
`;

const SCHEMA = `# league.json shape (ZenGM export)

Top-level keys are store names. The ones that matter for GM work:

## players[]
Every player (active + retired + draft prospects). Key fields:
- \`pid\`, \`firstName\`, \`lastName\`, \`tid\` (team id; negative = special: -1 undrafted, -2 retired, -5 free agent)
- \`ratings[]\` — one row per season: \`{ season, ovr, pot, pos, hgt, stre, spd, ... }\`. Last row = current.
- \`stats[]\` — one row per team-season: \`{ season, tid, playoffs, gp, min, pts, trb, ast, fg, fga, tp, tpa, ft, fta, stl, blk, tov, pf, ... }\`. Raw box-score totals; per-game = divide by gp. Advanced stats (PER/WS/etc.) are NOT precomputed in the export — compute from these if asked.
- \`contract\` — \`{ amount (thousands), exp (season) }\`
- \`draft\` — \`{ year, round, pick, tid }\`, \`injury\`, \`awards[]\`
- \`ptModifier\` — playing-time *nudge* multiplier only (0 / 0.75 / 1 / 1.25 / 1.5; 1 = normal). This is NOT minutes — don't report it as the rotation.
- \`minutesTarget\` — the user's hard per-game **minutes** plan for their own players: \`{ min?, target?, max? }\` in absolute minutes (any field may be absent; the whole object is absent when the coach decides freely). This is the real **Min / Tgt / Max** the user sets on the Roster page. When asked about minutes, the rotation, or who's getting a hard cap/floor, read \`minutesTarget\` — not \`ptModifier\`.

Common jq:
- Resolve your team id first — \`userTid\` may be a plain value OR history-wrapped as \`[{start, value}]\`: \`jq '.gameAttributes.userTid | if type=="array" then .[-1].value else . end' league.json\`
- Your roster, with the minutes plan: \`jq -c --argjson t <userTid> '.players[] | select(.tid==$t) | {name:(.firstName+" "+.lastName), ovr:(.ratings[-1].ovr), pos:(.ratings[-1].pos), pt:.ptModifier, minutes:.minutesTarget, salary:.contract.amount, exp:.contract.exp}' league.json\`
- A player's latest-season stats: filter \`.players[] | select(...) | .stats[-1]\`

## teams[]
\`{ tid, region, name, abbrev, cid, did }\` — team identity.

## teamSeasons[]
One row per team per season: \`{ tid, season, won, lost, ... }\` → standings. Filter by \`.season == <current>\`.

## teamStats[]
Per-team box-score totals by season (offense/defense splits).

## draftPicks[]
Future/owned picks: \`{ tid, originalTid, season, round }\` — who controls which pick.

## schedule[]
Remaining games this season: \`{ homeTid, awayTid }\`.

## boxscores.json — PER-GAME box scores (separate file, not in league.json)
A top-level JSON **array of game objects** (the ZenGM \`games\` store), split out of the export so \`league.json\` stays lean. **Present only if it exists in the workdir** — if the file is missing, no games-bearing sync has landed yet; fall back to diffing cumulative \`players[].stats\`. This is the ground truth for a single game's line (minutes, +/-, per-player stats) — no diffing needed.
- Each game: \`{ gid, season, playoffs, day, overtimes, teams: [teamA, teamB], ... }\`.
- Each team entry: \`{ tid, pts, players: [ { pid, name, min, fg, fga, tp, tpa, ft, fta, orb, drb, ast, tov, stl, blk, pf, pts, pm, ... } ], ... }\` (team-level stat totals sit alongside \`players\`).
- **Introspect the exact shape the first time** (BBGM versions differ): \`jq '.[-1] | {gid, keys:keys, team0:(.teams[0]|keys), p0:(.teams[0].players[0])}' boxscores.json\`. Confirm which of \`teams[0]/[1]\` is home (cross-ref \`schedule\`/\`day\` or the higher \`pts\` vs the known final).
- Find a specific game (e.g. our latest vs a foe) by tid + newest gid:
  \`jq --argjson me <userTid> '[.[] | select(any(.teams[]; .tid==$me))] | sort_by(.gid) | last' boxscores.json\`
- reb = \`orb + drb\` (no \`trb\` field), same as \`players[].stats\`.

## gameAttributes
Object (not array): \`userTid\`, \`season\`, \`phase\`, \`salaryCap\`, \`minPayroll\`, \`luxuryPayroll\`, \`numGames\`, \`numPeriods\`, \`quarterLength\`, \`confs\`, \`divs\`, etc.
Some keys are stored as **history arrays** \`[{ start, value }]\` rather than a bare value — \`userTid\` in particular. Always resolve with \`if type=="array" then .[-1].value else . end\` before comparing (e.g. \`select(.tid == $userTid)\` silently matches nothing if \`$userTid\` is the raw array). Game length in minutes = \`numPeriods * quarterLength\` — the ceiling for any \`minutesTarget\`.
`;

const MEMORY_SEED = `# GM Memory

_Maintained by the Assistant GM. Durable notes that persist across conversations._

## Philosophy & directives
<!-- The user's stated strategy, risk tolerance, timeline (contend vs rebuild), standing orders. -->

## Roster notes
<!-- Players to build around, develop, or showcase; chemistry/role observations. -->

## Trade targets & shop list
<!-- Players to pursue or move, and why. -->

## Draft & development
<!-- Picks owned, prospects to track, tank/win directives. -->

## Open questions
<!-- Things to revisit with the user. -->
`;

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");

// Ensure the working dir exists and contains fresh data + scaffolding.
// Returns the absolute working dir path. Re-writes league.json only when the
// synced blob actually changed (cheap hash check). Never clobbers GM-MEMORY.md.
export const ensureWorkdir = (syncId, leagueJsonString, meta = {}) => {
	const dir = workdirFor(syncId);
	fs.mkdirSync(dir, { recursive: true });

	// league.json — only rewrite when changed
	const leaguePath = path.join(dir, "league.json");
	const hashPath = path.join(dir, ".league.sha1");
	const newHash = sha(leagueJsonString);
	let prevHash = "";
	try {
		prevHash = fs.readFileSync(hashPath, "utf8");
	} catch {}
	if (newHash !== prevHash) {
		fs.writeFileSync(leaguePath, leagueJsonString);
		fs.writeFileSync(hashPath, newHash);
	}

	// boxscores.json — the split-out "games" store (per-game box scores). Only
	// present once a games-bearing sync has landed. Refresh it when the league
	// changed (box scores change with it) or when the workdir copy is missing.
	// Best-effort: a missing/failed copy must never break a GM turn.
	try {
		const boxSrc = boxScoresFileFor(syncId);
		const boxDest = path.join(dir, "boxscores.json");
		if (
			fs.existsSync(boxSrc) &&
			(newHash !== prevHash || !fs.existsSync(boxDest))
		) {
			fs.copyFileSync(boxSrc, boxDest);
		}
	} catch {}

	// Persona + schema — refreshed each turn (cheap, keeps them current)
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), personaTemplate(meta));
	fs.writeFileSync(path.join(dir, "SCHEMA.md"), SCHEMA);

	// Memory — seed once, then it belongs to the GM
	const memPath = path.join(dir, "GM-MEMORY.md");
	if (!fs.existsSync(memPath)) {
		fs.writeFileSync(memPath, MEMORY_SEED);
	}

	return dir;
};

const MIME_EXT = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/heic": "heic",
	"image/heif": "heif",
	"image/bmp": "bmp",
};

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Text docs the GM can read alongside images. Browsers often report an empty
// MIME for .md, so the extension (from the client filename) is the source of
// truth for these.
const TEXT_EXT = new Set(["md", "markdown", "txt", "json", "csv", "log"]);
const IMAGE_EXT = new Set(Object.values(MIME_EXT));

// Decode pasted/dropped attachments (base64 data URLs) into <workdir>/uploads/
// and return the relative paths the GM can Read. The extension is whitelisted
// (images + text docs); the client filename is NEVER used as a path. Bad entries
// are skipped, not fatal.
export const saveAttachments = (syncId, attachments) => {
	if (!Array.isArray(attachments) || attachments.length === 0) {
		return [];
	}
	const dir = workdirFor(syncId);
	const uploads = path.join(dir, "uploads");
	fs.mkdirSync(uploads, { recursive: true });

	const saved = [];
	for (const att of attachments.slice(0, MAX_ATTACHMENTS)) {
		const dataUrl = att && typeof att.dataUrl === "string" ? att.dataUrl : "";
		// MIME may be empty (.md often is) — tolerate that and lean on the ext.
		const m = /^data:([^;,]*);base64,(.+)$/s.exec(dataUrl);
		if (!m) continue;

		const mime = m[1].toLowerCase();
		const nameExt = (typeof att.name === "string" ? att.name : "")
			.split(".")
			.pop()
			?.toLowerCase();

		// Resolve a safe extension: a whitelisted client extension wins; else fall
		// back to the image MIME map. Anything else is rejected.
		let ext;
		if (nameExt && (TEXT_EXT.has(nameExt) || IMAGE_EXT.has(nameExt))) {
			ext = nameExt === "jpeg" ? "jpg" : nameExt;
		} else if (MIME_EXT[mime]) {
			ext = MIME_EXT[mime];
		}
		if (!ext) continue;

		const buf = Buffer.from(m[2], "base64");
		if (buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) continue;

		// Filename is server-generated; the client name is never used as a path.
		const fname = `${crypto.randomBytes(6).toString("hex")}.${ext}`;
		fs.writeFileSync(path.join(uploads, fname), buf);
		saved.push({
			rel: `uploads/${fname}`,
			name: typeof att.name === "string" ? att.name.slice(0, 80) : fname,
		});
	}
	return saved;
};
