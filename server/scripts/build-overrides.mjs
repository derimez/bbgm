// Build the global realTeamInfo + realPlayerPhotos override maps from the
// Knicks Dynasty league export. These are injected into the BBGM meta DB
// (attributes store) before generating a new real-roster league so the wizard
// shows real NBA team names and generation bakes in real player photos.
//
//   node server/scripts/build-overrides.mjs
//
// Writes data/server/override_realTeamInfo.json and override_realPlayerPhotos.json,
// which the server exposes at /api/overrides/realTeamInfo and /realPlayerPhotos.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "..", "data", "server");

const league = JSON.parse(
	fs.readFileSync(path.join(DATA, "knicks_dynasty_import.json"), "utf8"),
);

// ── realTeamInfo: keyed by srID. Must satisfy IndividualRealTeamInfoSchema —
// colors, if present, MUST be a 3-tuple of strings or zod rejects the WHOLE map.
const realTeamInfo = {};
let badColors = 0;
for (const t of league.teams) {
	if (!t.srID) continue;
	const info = {};
	if (typeof t.region === "string") info.region = t.region;
	if (typeof t.name === "string") info.name = t.name;
	if (typeof t.abbrev === "string") info.abbrev = t.abbrev;
	if (typeof t.pop === "number") info.pop = t.pop;
	if (typeof t.imgURL === "string" && t.imgURL) info.imgURL = t.imgURL;
	if (typeof t.imgURLSmall === "string" && t.imgURLSmall)
		info.imgURLSmall = t.imgURLSmall;
	if (typeof t.jersey === "string") info.jersey = t.jersey;
	if (
		Array.isArray(t.colors) &&
		t.colors.length === 3 &&
		t.colors.every((c) => typeof c === "string")
	) {
		info.colors = [t.colors[0], t.colors[1], t.colors[2]];
	} else if (t.colors !== undefined) {
		badColors++;
	}
	realTeamInfo[t.srID] = info;
}

// ── realPlayerPhotos: srID → imgURL, skipping blanks. Year-suffixed duplicate
// srIDs (rare) collapse to the last seen; fine for photos.
const realPlayerPhotos = {};
for (const p of league.players) {
	if (!p.srID) continue;
	if (!p.imgURL || p.imgURL === "/img/blank-face.png") continue;
	realPlayerPhotos[p.srID] = p.imgURL;
}

fs.writeFileSync(
	path.join(DATA, "override_realTeamInfo.json"),
	JSON.stringify(realTeamInfo),
);
fs.writeFileSync(
	path.join(DATA, "override_realPlayerPhotos.json"),
	JSON.stringify(realPlayerPhotos),
);

console.log(
	`realTeamInfo: ${Object.keys(realTeamInfo).length} teams (${badColors} dropped colors)`,
);
console.log(
	`realPlayerPhotos: ${Object.keys(realPlayerPhotos).length} players`,
);
console.log("Knicks (NYK):", JSON.stringify(realTeamInfo.NYK));
