// Advanced-analytics section for the Compare Players screen: a single
// overlaid percentile radar (all compared players on one chart) plus a
// career-trend chart per player, reusing the same visualizations as the
// player detail card's Analytics section.

import { useState } from "react";
import RadarChartOverlay, { type RadarSeries } from "./RadarChartOverlay.tsx";
import CareerTrendOverlay, { type TrendSeries } from "./CareerTrendOverlay.tsx";
import { type TrendRow } from "../Player/Analytics/CareerTrend.tsx";
import CollapseArrow from "../../components/CollapseArrow.tsx";
import { helpers } from "../../util/helpers.ts";

type PlayerAnalytics = {
	radarBySeason: Record<
		number,
		{ stat: string; name: string; value: number; percentile: number }[]
	>;
	trendLeagueBySeason?: Record<number, Record<string, number>>;
};

type ComparePlayer = {
	p: any;
	season: number | "career";
	analytics?: PlayerAnalytics;
	statsAll?: any[];
};

const RADAR_COLORS = [
	"var(--bs-blue)",
	"var(--bs-danger)",
	"var(--bs-success)",
	"var(--bs-orange, #fd7e14)",
	"var(--bs-purple, #6f42c1)",
	"var(--bs-teal, #20c997)",
];

// One representative regular-season row per season (keeps the row with the most
// games so multi-team seasons collapse to their merged TOT row).
const buildTrendRows = (stats: any[] | undefined): TrendRow[] => {
	const bySeason = new Map<number, any>();
	for (const row of stats ?? []) {
		if (row.playoffs || !row.gp) {
			continue;
		}
		const existing = bySeason.get(row.season);
		if (!existing || row.gp > existing.gp) {
			bySeason.set(row.season, row);
		}
	}

	return Array.from(bySeason.values())
		.sort((a, b) => a.season - b.season)
		.map((row) => ({
			season: row.season,
			per: row.per ?? 0,
			ws: row.ws ?? 0,
			ws48: row.ws48 ?? 0,
			tsp: row.tsp ?? 0,
			bpm: row.bpm ?? 0,
			vorp: row.vorp ?? 0,
		}));
};

const playerName = (p: any) => `${p.firstName} ${p.lastName}`;

const ComparePlayersAnalytics = ({ players }: { players: ComparePlayer[] }) => {
	const [open, setOpen] = useState(true);

	const radarPlayers = players
		.map((pl, i) => ({ pl, i }))
		.filter(({ pl }) => pl.analytics !== undefined);

	const [radarSeasons, setRadarSeasons] = useState<Record<number, number>>(
		() => {
			const initial: Record<number, number> = {};
			for (const { pl, i } of radarPlayers) {
				const seasons = Object.keys(pl.analytics!.radarBySeason)
					.map(Number)
					.sort((a, b) => b - a);
				const def =
					typeof pl.season === "number" &&
					pl.analytics!.radarBySeason[pl.season]
						? pl.season
						: seasons[0];
				if (def !== undefined) {
					initial[i] = def;
				}
			}
			return initial;
		},
	);

	const trendSeries: TrendSeries[] = players
		.map((pl, i) => ({
			name: playerName(pl.p),
			color: RADAR_COLORS[i % RADAR_COLORS.length]!,
			rows: buildTrendRows(pl.statsAll),
		}))
		.filter((s) => s.rows.length > 1);
	const hasTrend = trendSeries.length > 0;

	if (radarPlayers.length === 0 && !hasTrend) {
		return null;
	}

	const series: RadarSeries[] = radarPlayers
		.map(({ pl, i }) => {
			const season = radarSeasons[i];
			const axes =
				season !== undefined ? pl.analytics!.radarBySeason[season] : undefined;
			if (!axes) {
				return undefined;
			}
			return {
				name: playerName(pl.p),
				color: RADAR_COLORS[i % RADAR_COLORS.length]!,
				axes,
			};
		})
		.filter((s): s is RadarSeries => s !== undefined);

	return (
		<div className="mt-3">
			<a
				className="compare-players-heading d-inline-flex align-items-center fw-bold"
				onClick={(event) => {
					event.preventDefault();
					setOpen((prev) => !prev);
				}}
			>
				<CollapseArrow open={open} /> Analytics
			</a>
			{open ? (
				<>
					{series.length > 0 ? (
						<div className="mt-2">
							<div className="d-flex flex-wrap justify-content-center align-items-center gap-3 mb-1">
								<h3 className="mb-0 h5">Percentile Profile</h3>
								{radarPlayers.map(({ pl, i }) => {
									const seasons = Object.keys(pl.analytics!.radarBySeason)
										.map(Number)
										.sort((a, b) => b - a);
									if (seasons.length <= 1 || radarSeasons[i] === undefined) {
										return null;
									}
									return (
										<label
											key={i}
											className="d-flex align-items-center gap-1 small mb-0"
										>
											<span
												style={{
													width: 10,
													height: 10,
													borderRadius: "50%",
													background: RADAR_COLORS[i % RADAR_COLORS.length],
													display: "inline-block",
												}}
											/>
											{playerName(pl.p)}
											<select
												className="form-select form-select-sm w-auto"
												value={radarSeasons[i]}
												onChange={(event) =>
													setRadarSeasons((prev) => ({
														...prev,
														[i]: Number(event.target.value),
													}))
												}
											>
												{seasons.map((s) => (
													<option key={s} value={s}>
														{s}
													</option>
												))}
											</select>
										</label>
									);
								})}
							</div>
							<RadarChartOverlay series={series} />
							<p className="text-body-secondary small text-center mt-2 mb-0">
								Percentile rank vs qualifying players that season. The dashed
								ring marks the league average (50th percentile).
							</p>
						</div>
					) : (
						<p className="text-body-secondary small mt-2 mb-0">
							Percentile profile is only available for basketball seasons.
						</p>
					)}

					{hasTrend ? (
						<div className="mt-3">
							<h3 className="mb-2 h5 text-center">Career Trend</h3>
							<CareerTrendOverlay series={trendSeries} />
						</div>
					) : null}

					<div className="d-flex flex-wrap gap-2 mt-2">
						<a
							className="btn btn-sm btn-light-bordered"
							href={helpers.leagueUrl(["player_graphs"])}
						>
							Player graphs
						</a>
						<a
							className="btn btn-sm btn-light-bordered"
							href={helpers.leagueUrl(["leaders"])}
						>
							League leaders
						</a>
					</div>
				</>
			) : null}
		</div>
	);
};

export default ComparePlayersAnalytics;
