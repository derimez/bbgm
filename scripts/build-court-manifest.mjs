#!/usr/bin/env node
// Build courts/manifest.json from filenames under server/public/courts/.
//
// Each file is `<arena_snake>_<startYear>[_<endYear>][_and_<y2>[_<y3>]][__<dupe>].jpg`.
// We parse → map arena to team era(s) → group by team, collapse same-range
// entries into a single variant whose `images` array gives the runtime a pool
// to pick randomly from. Inset is detected via `sharp` (white sideline scan
// on a downscaled raster) and falls back to a sane default when detection
// can't find both sidelines + baselines.
//
// Run: node scripts/build-court-manifest.mjs           → writes manifest.json
//      node scripts/build-court-manifest.mjs --check   → prints coverage, no write

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import sharp from "sharp";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COURT_DIR = path.resolve(__dirname, "..", "server", "public", "courts");
const OUT_PATH = path.join(COURT_DIR, "manifest.json");

// ── Arena → team-era map ──────────────────────────────────────────────────
// Each arena lists every franchise that called it home, with the season-year
// range (inclusive). Season year = the year a season ENDS in (BBGM convention).
// e.g., the 1985–86 Lakers season is `season: 1986`. So Bulls @ United Center
// 1994–present is { start: 1995, end: 2099 }.
const ARENA_TEAM_ERAS = {
	// ATL Hawks
	st_louis_arena: [{ t: "ATL", s: 1956, e: 1968 }],
	kiel_auditorium: [{ t: "ATL", s: 1956, e: 1968 }],
	alexander_memorial_coliseum: [
		{ t: "ATL", s: 1969, e: 1972 },
		{ t: "ATL", s: 1997, e: 1999 },
	],
	omni_coliseum: [{ t: "ATL", s: 1973, e: 1997 }],
	georgia_dome: [{ t: "ATL", s: 1997, e: 1999 }],
	philips_arena: [{ t: "ATL", s: 2000, e: 2018 }],
	state_farm_arena: [{ t: "ATL", s: 2019, e: 2099 }],

	// BOS Celtics
	boston_garden: [{ t: "BOS", s: 1947, e: 1995 }],
	hartford_civic_center: [{ t: "BOS", s: 1976, e: 1995 }],
	fleet_center: [{ t: "BOS", s: 1996, e: 2005 }],
	td_banknorth_garden: [{ t: "BOS", s: 2006, e: 2009 }],
	td_garden: [{ t: "BOS", s: 2010, e: 2099 }],

	// BKN Nets (NY Nets ABA, NJ Nets, Brooklyn Nets)
	rutgers_athletic_center: [{ t: "BKN", s: 1978, e: 1981 }],
	nassau_veterans_memorial_coliseum: [
		{ t: "BKN", s: 1973, e: 1977 },
		{ t: "BKN", s: 1978, e: 1981 },
	],
	brendan_byrne_arena: [{ t: "BKN", s: 1982, e: 1996 }],
	continental_airlines_arena: [{ t: "BKN", s: 1997, e: 2007 }],
	izod_center: [{ t: "BKN", s: 2008, e: 2010 }],
	prudential_center: [{ t: "BKN", s: 2011, e: 2012 }],
	barclays_center: [{ t: "BKN", s: 2013, e: 2099 }],

	// CHA Hornets / Bobcats / original Hornets
	charlotte_coliseum: [{ t: "CHA", s: 1989, e: 2002 }], // original Hornets (became NOP)
	charlotte_bobcats_arena: [{ t: "CHA", s: 2005, e: 2008 }],
	time_warner_cable_arena: [{ t: "CHA", s: 2009, e: 2016 }],
	spectrum_center: [{ t: "CHA", s: 2017, e: 2099 }],

	// CHI Bulls
	international_amphitheatre: [{ t: "CHI", s: 1967, e: 1968 }],
	chicago_stadium: [{ t: "CHI", s: 1968, e: 1994 }],
	united_center: [{ t: "CHI", s: 1995, e: 2099 }],

	// CLE Cavaliers
	cleveland_arena: [{ t: "CLE", s: 1971, e: 1974 }],
	the_coliseum_at_richfield: [{ t: "CLE", s: 1975, e: 1994 }],
	richfield_coliesum: [{ t: "CLE", s: 1975, e: 1994 }],
	gund_arena: [{ t: "CLE", s: 1995, e: 2005 }],
	quicken_loans_arena: [{ t: "CLE", s: 2006, e: 2019 }],
	rocket_mortgage_fieldhouse: [{ t: "CLE", s: 2020, e: 2099 }],

	// DAL Mavericks
	reunion_arena: [{ t: "DAL", s: 1981, e: 2001 }],
	american_airlines_center: [{ t: "DAL", s: 2002, e: 2099 }],

	// DEN Nuggets
	mcnichols_sports_arena: [{ t: "DEN", s: 1976, e: 1999 }],
	pepsi_center: [{ t: "DEN", s: 2000, e: 2020 }],
	ball_arena: [{ t: "DEN", s: 2021, e: 2099 }],

	// DET Pistons
	cobo_arena: [{ t: "DET", s: 1962, e: 1978 }],
	pontiac_silverdome: [{ t: "DET", s: 1979, e: 1988 }],
	the_palace_of_auburn_hills: [{ t: "DET", s: 1989, e: 2017 }],
	little_caesars_arena: [{ t: "DET", s: 2018, e: 2099 }],

	// GSW Warriors (SF → Oakland → SF)
	cow_palace: [{ t: "GSW", s: 1963, e: 1971 }],
	san_francisco_civic_auditorium: [{ t: "GSW", s: 1963, e: 1971 }],
	usf_war_memorial_gymnasium: [{ t: "GSW", s: 1963, e: 1971 }],
	oakland_coliseum_arena: [
		{ t: "GSW", s: 1972, e: 1996 },
		{ t: "GSW", s: 1997, e: 2005 },
	],
	san_jose_arena: [{ t: "GSW", s: 1997, e: 1997 }],
	the_arena_in_oakland: [{ t: "GSW", s: 1998, e: 2005 }],
	oracle_arena: [{ t: "GSW", s: 2006, e: 2019 }],
	chase_center: [{ t: "GSW", s: 2020, e: 2099 }],

	// HOU Rockets (SD → Houston)
	san_diego_sports_arena: [
		{ t: "HOU", s: 1968, e: 1971 },
		{ t: "LAC", s: 1979, e: 1984 },
	],
	hofheinz_pavilion: [{ t: "HOU", s: 1972, e: 1975 }],
	the_summit: [{ t: "HOU", s: 1976, e: 1998 }],
	compaq_center: [{ t: "HOU", s: 1999, e: 2003 }],
	toyota_center: [{ t: "HOU", s: 2004, e: 2099 }],

	// IND Pacers
	market_square_arena: [{ t: "IND", s: 1975, e: 1999 }],
	conseco_fieldhouse: [{ t: "IND", s: 2000, e: 2011 }],
	bankers_life_fieldhouse: [{ t: "IND", s: 2012, e: 2021 }],

	// LAC Clippers (Buffalo Braves → SD Clippers → LAC)
	buffalo_memorial_auditorium: [{ t: "LAC", s: 1971, e: 1978 }],
	los_angeles_memorial_sports_arena: [
		{ t: "LAC", s: 1985, e: 1999 },
		{ t: "LAL", s: 1961, e: 1967 },
	],
	// staples_center: shared with LAL/LAC, see LAL below

	// LAL Lakers (Minneapolis → LA)
	the_forum: [{ t: "LAL", s: 1968, e: 1988 }],
	great_western_forum: [{ t: "LAL", s: 1989, e: 1999 }],
	staples_center: [
		{ t: "LAL", s: 2000, e: 2021 },
		{ t: "LAC", s: 2000, e: 2024 },
	],
	// crypto.com Arena (no files yet) → falls back to staples_center

	// MEM Grizzlies (Vancouver → Memphis)
	general_motors_place: [{ t: "MEM", s: 1996, e: 2001 }],
	the_pyramid: [{ t: "MEM", s: 2002, e: 2004 }],
	fedex_forum: [{ t: "MEM", s: 2005, e: 2099 }],
	fed_ex_forum: [{ t: "MEM", s: 2005, e: 2099 }],

	// MIA Heat
	miami_arena: [{ t: "MIA", s: 1989, e: 1999 }],
	american_airlines_arena: [{ t: "MIA", s: 2000, e: 2099 }],

	// MIL Bucks
	milwaukee_arena: [{ t: "MIL", s: 1969, e: 1988 }],
	mecca_arena: [{ t: "MIL", s: 1969, e: 1988 }],
	uwm_panther_arena: [{ t: "MIL", s: 1969, e: 1988 }],
	bradley_center: [{ t: "MIL", s: 1989, e: 2017 }],
	bmo_harris_bradley_center: [{ t: "MIL", s: 2013, e: 2018 }],
	fiserv_forum: [{ t: "MIL", s: 2019, e: 2099 }],
	wisconsin_field_house: [{ t: "MIL", s: 1969, e: 1988 }],

	// MIN Timberwolves
	hubert_h_humphrey_metrodome: [{ t: "MIN", s: 1990, e: 1990 }],
	target_center: [{ t: "MIN", s: 1991, e: 2099 }],

	// NOP Pelicans (NO Hornets era from CHA's 2003 move; Katrina relocation)
	new_orleans_arena: [{ t: "NOP", s: 2003, e: 2013 }],
	uno_lakefront_arena: [{ t: "NOP", s: 2006, e: 2007 }],
	ford_center: [
		{ t: "NOP", s: 2006, e: 2007 },
		{ t: "OKC", s: 2009, e: 2011 },
	],
	smoothie_king_center: [{ t: "NOP", s: 2014, e: 2099 }],

	// NYK Knicks
	madison_square_garden_iii: [{ t: "NYK", s: 1947, e: 1968 }],
	madison_square_garden_iv: [{ t: "NYK", s: 1969, e: 2099 }],

	// OKC Thunder (Seattle SuperSonics → OKC)
	seattle_center_coliseum: [
		{ t: "OKC", s: 1968, e: 1995 },
		{ t: "OKC", s: 1996, e: 2008 },
	],
	key_arena_at_seattle_center: [{ t: "OKC", s: 1996, e: 2008 }],
	tacoma_dome: [{ t: "OKC", s: 1995, e: 1995 }],
	king_county_multipurpose_domed_stadium: [{ t: "OKC", s: 1979, e: 1985 }],
	hec_edmunson_pavilion: [{ t: "OKC", s: 1986, e: 1995 }],
	oklahoma_city_arena: [{ t: "OKC", s: 2012, e: 2012 }],
	chesapeake_energy_arena: [{ t: "OKC", s: 2012, e: 2020 }],

	// ORL Magic
	orlando_arena: [{ t: "ORL", s: 1990, e: 1999 }],
	the_arena_in_orlando: [{ t: "ORL", s: 2000, e: 2007 }],
	amway_arena: [{ t: "ORL", s: 2008, e: 2010 }],
	amway_center: [{ t: "ORL", s: 2011, e: 2099 }],
	adventhealth_arena: [{ t: "ORL", s: 2020, e: 2099 }],

	// PHI 76ers
	philadelphia_convention_hall_and_civic_center: [
		{ t: "PHI", s: 1964, e: 1971 },
	],
	spectrum: [{ t: "PHI", s: 1968, e: 1996 }],
	corestates_spectrum: [{ t: "PHI", s: 1995, e: 1998 }],
	corestates_center: [{ t: "PHI", s: 1997, e: 1998 }],
	first_union_center: [{ t: "PHI", s: 1999, e: 2003 }],
	wachovia_center: [{ t: "PHI", s: 2004, e: 2010 }],
	wachovia_spectrum: [{ t: "PHI", s: 1995, e: 1998 }],
	wells_fargo_center: [{ t: "PHI", s: 2011, e: 2099 }],

	// PHX Suns
	arizona_veterans_memorial_coliseum: [{ t: "PHX", s: 1969, e: 1992 }],
	america_west_arena: [{ t: "PHX", s: 1993, e: 2006 }],
	us_airways_center: [{ t: "PHX", s: 2007, e: 2014 }],
	talking_stick_resort_arena: [{ t: "PHX", s: 2015, e: 2019 }],
	phoenix_suns_arena: [{ t: "PHX", s: 2020, e: 2022 }],

	// POR Trail Blazers
	moody_coliseum: [{ t: "POR", s: 1971, e: 1971 }],
	veterans_memorial_coliseum: [{ t: "POR", s: 1971, e: 1995 }],
	rose_garden: [{ t: "POR", s: 1996, e: 2013 }],
	moda_center: [{ t: "POR", s: 2014, e: 2099 }],

	// SAC Kings (Cincinnati → KC → Sacramento)
	cincinnati_gardens: [{ t: "SAC", s: 1958, e: 1972 }],
	omaha_civic_auditorium: [{ t: "SAC", s: 1973, e: 1978 }],
	kemper_arena: [{ t: "SAC", s: 1975, e: 1985 }],
	arco_arena_i: [{ t: "SAC", s: 1986, e: 1988 }],
	arco_arena_ii: [{ t: "SAC", s: 1989, e: 2011 }],
	power_balance_pavilion: [{ t: "SAC", s: 2012, e: 2012 }],
	sleep_train_arena: [{ t: "SAC", s: 2013, e: 2016 }],
	golden1_center: [{ t: "SAC", s: 2017, e: 2099 }],

	// SAS Spurs
	hemisfair_arena: [{ t: "SAS", s: 1974, e: 1993 }],
	alamodome: [{ t: "SAS", s: 1994, e: 2002 }],
	sbc_center: [{ t: "SAS", s: 2003, e: 2006 }],
	at_and_t_center: [{ t: "SAS", s: 2007, e: 2099 }],

	// TOR Raptors
	skydome: [{ t: "TOR", s: 1996, e: 1999 }],
	air_canada_centre: [{ t: "TOR", s: 2000, e: 2018 }],
	scotiabank_arena: [{ t: "TOR", s: 2019, e: 2099 }],
	copps_coliseum: [{ t: "TOR", s: 1996, e: 2018 }],
	maple_leaf_gardens: [{ t: "TOR", s: 1947, e: 1947 }], // Toronto Huskies (BAA)
	td_waterhouse_centre: [{ t: "TOR", s: 2000, e: 2018 }],

	// UTA Jazz (New Orleans → Utah)
	louisiana_superdome: [{ t: "UTA", s: 1975, e: 1979 }],
	salt_palace: [{ t: "UTA", s: 1980, e: 1991 }],
	delta_center: [
		{ t: "UTA", s: 1992, e: 2006 },
		{ t: "UTA", s: 2024, e: 2099 },
	],
	energy_solutions_arena: [{ t: "UTA", s: 2007, e: 2015 }],
	vivint_arena: [{ t: "UTA", s: 2016, e: 2023 }],
	vivint_smart_home_arena: [{ t: "UTA", s: 2016, e: 2023 }],

	// WAS Wizards (Chicago Packers/Zephyrs → Baltimore → Capital → Washington Bullets → Wizards)
	baltimore_civic_center: [{ t: "WAS", s: 1964, e: 1973 }],
	baltimore_arena: [{ t: "WAS", s: 1964, e: 1973 }],
	capital_centre: [{ t: "WAS", s: 1974, e: 1997 }],
	usair_arena: [{ t: "WAS", s: 1994, e: 1997 }],
	mci_center: [{ t: "WAS", s: 1998, e: 2006 }],
	verizon_center: [{ t: "WAS", s: 2007, e: 2017 }],
	capital_one_arena: [{ t: "WAS", s: 2018, e: 2099 }],

	// Shared / college / odd
	amalie_arena: [{ t: "ORL", s: 2020, e: 2099 }], // Tampa Raptors-borrowed-occasionally; map to ORL
	carolina_coliseum: [{ t: "CHA", s: 1989, e: 2002 }],
	cole_field_house: [{ t: "WAS", s: 1969, e: 1973 }],
	joe_louis_arena: [{ t: "DET", s: 1978, e: 1988 }], // alt during Silverdome era
	pete_maravich_assembly_center: [{ t: "UTA", s: 1975, e: 1979 }],
	thomas_and_mack_center: [{ t: "LAC", s: 1979, e: 1984 }],
	lloyd_noble_center: [{ t: "OKC", s: 2009, e: 2011 }],
	visa_athletic_center: [{ t: "ORL", s: 2008, e: 2010 }],
	bankers_life_fieldhouse__bonus_no_op: [], // sentinel; ignored
	arrowhead_pond_of_anaheim: [{ t: "LAC", s: 1995, e: 1999 }],
	kansas_city_municipal_auditorium: [{ t: "SAC", s: 1973, e: 1978 }],
	baltimore_arena_dup: [], // ignored
};

// NBA Cup tournament floors (one per current franchise, 2023–24 onward).
// These appear in the modern variant pool alongside the team's regular court
// so cup-style designs show up as a random pick.
const CUP_TEAM = {
	cup_atlanta_hawks: "ATL",
	cup_boston_celtics: "BOS",
	cup_brooklyn_nets: "BKN",
	cup_charlotte_hornets: "CHA",
	cup_chicago_bulls: "CHI",
	cup_cleveland_cavaliers: "CLE",
	cup_dallas_mavericks: "DAL",
	cup_denver_nuggets: "DEN",
	cup_detroit_pistons: "DET",
	cup_golden_state_warriors: "GSW",
	cup_houston_rockets: "HOU",
	cup_indiana_pacers: "IND",
	cup_los_angeles_clippers: "LAC",
	cup_los_angeles_lakers: "LAL",
	cup_memphis_grizzlies: "MEM",
	cup_miami_heat: "MIA",
	cup_milwaukee_bucks: "MIL",
	cup_minnesota_timberwolves: "MIN",
	cup_new_orleans_pelicans: "NOP",
	cup_new_york_knicks: "NYK",
	cup_oklahoma_city_thunder: "OKC",
	cup_orlando_magic: "ORL",
	cup_philadelphia_76ers: "PHI",
	cup_phoenix_suns: "PHX",
	cup_portland_trail_blazers: "POR",
	cup_sacramento_kings: "SAC",
	cup_san_antonio_spurs: "SAS",
	cup_toronto_raptors: "TOR",
	cup_utah_jazz: "UTA",
	cup_washington_wizards: "WAS",
};

// ── Filename parser ───────────────────────────────────────────────────────
// Returns null for files we should skip (cup_*, all_star, detail, etc.).
function parseFilename(fn) {
	if (!fn.endsWith(".jpg")) return null;
	const base = fn.slice(0, -4);
	// NBA Cup tournament floors are garish special-event designs, not a team's
	// real home court, and they're period-incorrect for any historical season.
	// Skip them entirely so only real arenas end up in the pool. (CUP_TEAM is
	// retained above for reference but no longer feeds the manifest.)
	if (/^cup_/.test(base)) return null;
	if (/all_star|celebrity|_detail$/.test(base)) return null;
	if (
		/_rising_stars_|_shooting_stars|_skills_challenge|_saturday_night/.test(
			base,
		)
	)
		return null;
	if (/^msg-/.test(base)) return null; // legacy aliases — handled separately

	// Strip trailing __N dupe suffix.
	let core = base;
	let dupe = 0;
	const dupeM = core.match(/^(.*)__(\d+)$/);
	if (dupeM) {
		core = dupeM[1];
		dupe = parseInt(dupeM[2], 10);
	}

	// Pull trailing year(s) — supports patterns:
	//   _YYYY
	//   _YYYY_YYYY
	//   _YYYY_YYYY_and_YYYY
	//   _YYYY_YYYY_and_YYYY_YYYY
	//   _YYYY_and_YYYY[_YYYY]
	const tailRe = /_(\d{4})(?:_(\d{4}))?(?:_and_(\d{4})(?:_(\d{4}))?)?$/;
	const m = core.match(tailRe);
	if (!m) return null;
	const years = [m[1], m[2], m[3], m[4]]
		.filter(Boolean)
		.map((n) => parseInt(n, 10));
	if (years.length === 0) return null;
	const startYear = Math.min(...years);
	const endYear = Math.max(...years);
	const arena = core.slice(0, m.index);
	return { fn, arena, startYear, endYear, dupe };
}

// Return the list of (team, image-effective-range) tuples for this filename.
function teamErasFor(parsed) {
	// Cup floors short-circuit: one team, 2024+.
	if (parsed.cup) {
		const t = CUP_TEAM[parsed.arena];
		return t ? [{ team: t, start: parsed.startYear, end: parsed.endYear }] : [];
	}
	const eras = ARENA_TEAM_ERAS[parsed.arena];
	if (!eras || eras.length === 0) return [];
	const out = [];
	for (const era of eras) {
		// Overlap of [parsed.startYear, parsed.endYear] with [era.s, era.e].
		const start = Math.max(parsed.startYear, era.s);
		const end = Math.min(parsed.endYear, era.e);
		if (start > end) continue;
		out.push({ team: era.t, start, end });
	}
	return out;
}

// ── Inset detection ───────────────────────────────────────────────────────
// Find playing-surface bounding box by locating the brightest (whitest) row
// in the top half + brightest row in the bottom half (top/bottom sidelines)
// and similarly the brightest columns in left/right halves (baselines).
// White lines that bound the playing surface are the longest unbroken runs of
// white pixels in their direction — much longer than half-court / FT lines.
const DEFAULT_INSET = { left: 0.09, right: 0.91, top: 0.075, bottom: 0.925 };

async function detectInset(imagePath) {
	try {
		const W = 200,
			H = 100;
		const { data } = await sharp(imagePath)
			.resize(W, H, { fit: "fill" })
			.raw()
			.toBuffer({ resolveWithObject: true });

		const isWhite = (i) =>
			data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200;

		// Per row: max consecutive horizontal white run.
		const rowRun = new Array(H).fill(0);
		for (let y = 0; y < H; y++) {
			let run = 0,
				maxRun = 0;
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 3;
				if (isWhite(i)) {
					run++;
					if (run > maxRun) maxRun = run;
				} else run = 0;
			}
			rowRun[y] = maxRun;
		}
		// Per col: max consecutive vertical white run.
		const colRun = new Array(W).fill(0);
		for (let x = 0; x < W; x++) {
			let run = 0,
				maxRun = 0;
			for (let y = 0; y < H; y++) {
				const i = (y * W + x) * 3;
				if (isWhite(i)) {
					run++;
					if (run > maxRun) maxRun = run;
				} else run = 0;
			}
			colRun[x] = maxRun;
		}

		// Skip the outermost 2% (image borders sometimes have white frames).
		const skipY = Math.floor(H * 0.02);
		const skipX = Math.floor(W * 0.02);

		// Top sideline = strongest horizontal run in [skipY, H/2-1].
		let topY = -1,
			topRun = 0;
		for (let y = skipY; y < Math.floor(H / 2); y++) {
			if (rowRun[y] > topRun) {
				topRun = rowRun[y];
				topY = y;
			}
		}
		// Bottom sideline = strongest horizontal run in [H/2, H-1-skipY].
		let botY = -1,
			botRun = 0;
		for (let y = Math.floor(H / 2); y < H - skipY; y++) {
			if (rowRun[y] > botRun) {
				botRun = rowRun[y];
				botY = y;
			}
		}
		// Left baseline = strongest vertical run in [skipX, W/2-1].
		let lX = -1,
			lRun = 0;
		for (let x = skipX; x < Math.floor(W / 2); x++) {
			if (colRun[x] > lRun) {
				lRun = colRun[x];
				lX = x;
			}
		}
		// Right baseline = strongest vertical run in [W/2, W-1-skipX].
		let rX = -1,
			rRun = 0;
		for (let x = Math.floor(W / 2); x < W - skipX; x++) {
			if (colRun[x] > rRun) {
				rRun = colRun[x];
				rX = x;
			}
		}

		// Plausibility: sideline run should span most of the playing-surface width,
		// and the resulting aspect should be close to 94/50 = 1.88 ±25%.
		if (topY < 0 || botY < 0 || lX < 0 || rX < 0) return DEFAULT_INSET;
		if (topRun < W * 0.5 || botRun < W * 0.5) return DEFAULT_INSET;
		if (lRun < H * 0.5 || rRun < H * 0.5) return DEFAULT_INSET;
		if (rX <= lX || botY <= topY) return DEFAULT_INSET;

		const inset = {
			left: lX / W,
			right: (rX + 1) / W,
			top: topY / H,
			bottom: (botY + 1) / H,
		};
		const aspect =
			((inset.right - inset.left) * W) / ((inset.bottom - inset.top) * H);
		if (aspect < 1.4 || aspect > 2.4) return DEFAULT_INSET;
		return inset;
	} catch {
		return DEFAULT_INSET;
	}
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
	const checkOnly = process.argv.includes("--check");
	const files = fs
		.readdirSync(COURT_DIR)
		.filter((f) => f.endsWith(".jpg"))
		.filter((f) => !f.startsWith("manifest"));

	// Parse + map every file to (team, effective range).
	// team → arena → "S-E" → { range: [s,e], images: [...], inset?: {} }
	const teamArenaRange = {};
	let skipped = 0,
		mapped = 0,
		unmappedArenas = new Set();

	// Tier 1: cup_* / all_star skipped already by parseFilename.
	for (const fn of files) {
		const p = parseFilename(fn);
		if (!p) {
			skipped++;
			continue;
		}
		const eras = teamErasFor(p);
		if (eras.length === 0) {
			// No franchise mapping for this arena.
			if (!ARENA_TEAM_ERAS[p.arena]) unmappedArenas.add(p.arena);
			skipped++;
			continue;
		}
		for (const era of eras) {
			const key = `${era.start}-${era.end}`;
			teamArenaRange[era.team] ??= {};
			teamArenaRange[era.team][p.arena] ??= {};
			teamArenaRange[era.team][p.arena][key] ??= {
				range: [era.start, era.end],
				images: [],
			};
			teamArenaRange[era.team][p.arena][key].images.push(p.fn);
			mapped++;
		}
	}

	// Detect inset for one representative image per arena (all images in the
	// same arena come from the same source process; insets are consistent
	// within an arena and would otherwise mean N*1500 sharp passes).
	const arenaInset = {};
	const allArenas = new Set();
	for (const team of Object.keys(teamArenaRange))
		for (const arena of Object.keys(teamArenaRange[team])) allArenas.add(arena);

	let n = 0;
	for (const arena of allArenas) {
		// Take any one image from any range under this arena.
		let sample = null;
		for (const team of Object.keys(teamArenaRange)) {
			const byRange = teamArenaRange[team][arena];
			if (!byRange) continue;
			for (const k of Object.keys(byRange)) {
				if (byRange[k].images.length > 0) {
					sample = byRange[k].images[0];
					break;
				}
			}
			if (sample) break;
		}
		if (!sample) continue;
		arenaInset[arena] = await detectInset(path.join(COURT_DIR, sample));
		n++;
		if (n % 20 === 0)
			process.stdout.write(`  …detected ${n}/${allArenas.size} arenas\n`);
	}

	// Build final manifest. Per team, sort variants by start year ascending.
	// Strip seasonRange off the variant covering the present (end >= 2099) so
	// it acts as the modern default per the existing convention.
	const manifest = {
		_readme: [
			"Court catalog for the simcast viewer. On each gameStart the viewer looks up",
			"the HOME team's abbrev in this map. Each value is an array of variants —",
			"the variant whose seasonRange contains the game's season wins; entries with",
			"no seasonRange act as the modern default. The viewer picks a random entry",
			"from `images` when there are multiple visual duplicates for the same era.",
			"Auto-generated by scripts/build-court-manifest.mjs — do not hand-edit.",
		],
	};
	for (const team of Object.keys(teamArenaRange).sort()) {
		const variants = [];
		for (const arena of Object.keys(teamArenaRange[team])) {
			for (const key of Object.keys(teamArenaRange[team][arena])) {
				const v = teamArenaRange[team][arena][key];
				v.images.sort();
				variants.push({
					seasonRange: v.range,
					images: v.images,
					arena,
					inset: arenaInset[arena] ?? DEFAULT_INSET,
				});
			}
		}
		variants.sort((a, b) => a.seasonRange[0] - b.seasonRange[0]);
		// Cup floors: pull them out of their standalone variant FIRST (before
		// assigning modern default), so the regular last-variant becomes modern.
		const cupVariantIdx = variants.findIndex((v) =>
			v.arena?.startsWith?.("cup_"),
		);
		let cupImages = [];
		if (cupVariantIdx >= 0) {
			cupImages = variants[cupVariantIdx].images.slice();
			variants.splice(cupVariantIdx, 1);
		}
		// Last (non-cup) variant becomes "modern default" — extend to present and
		// drop seasonRange so any season ≥ the previous variant's end falls through.
		if (variants.length > 0) {
			delete variants[variants.length - 1].seasonRange;
			// Merge cup images into the modern default pool.
			variants[variants.length - 1].images.push(...cupImages);
		} else if (cupImages.length > 0) {
			// No regular variant at all — cup becomes the only entry.
			variants.push({
				images: cupImages,
				arena: "cup",
				inset: DEFAULT_INSET,
			});
		}
		manifest[team] = variants;
	}

	// Legacy MSG aliases: append to NYK as additional dupes for their ranges.
	// msg-1970-1972.jpg → 1971..1972 (BBGM convention: season-end years)
	// msg-1986-1991.jpg → 1987..1991
	if (Array.isArray(manifest.NYK)) {
		for (const v of manifest.NYK) {
			const [s, e] = v.seasonRange ?? [0, 0];
			if (s === 1971 && e === 1972) v.images.push("msg-1970-1972.jpg");
			if (s === 1987 && e === 1991) v.images.push("msg-1986-1991.jpg");
		}
	}

	if (checkOnly) {
		console.log(
			`\nParsed: ${mapped} (team,era,image) tuples; skipped: ${skipped} files.`,
		);
		console.log(
			`Unmapped arenas (no team era): ${[...unmappedArenas].sort().join(", ") || "—"}\n`,
		);
		for (const team of Object.keys(manifest)
			.filter((k) => !k.startsWith("_"))
			.sort()) {
			const vs = manifest[team];
			console.log(`${team}: ${vs.length} variants`);
			for (const v of vs) {
				const range = v.seasonRange
					? `${v.seasonRange[0]}-${v.seasonRange[1]}`
					: "modern";
				console.log(
					`  ${range.padEnd(10)} · ${v.images.length} img(s) · arena=${v.arena}`,
				);
			}
		}
		return;
	}

	fs.writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2));
	console.log(`Wrote ${OUT_PATH}`);
	console.log(`  ${mapped} (team,era,image) tuples mapped`);
	console.log(
		`  ${Object.keys(manifest).filter((k) => !k.startsWith("_")).length} teams covered`,
	);
	console.log(
		`  ${allArenas.size} arenas, insets detected for ${Object.keys(arenaInset).length}`,
	);
	if (unmappedArenas.size > 0) {
		console.log(`  Unmapped arenas: ${[...unmappedArenas].sort().join(", ")}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
