import { useState } from "react";
import { helpers } from "../../../util/helpers.ts";
import RadarChart from "./RadarChart.tsx";
import CareerTrend, { type TrendRow } from "./CareerTrend.tsx";
import Highlights from "./Highlights.tsx";

type PlayerAnalytics = {
	metrics: { stat: string; name: string }[];
	radarBySeason: Record<
		number,
		{ stat: string; name: string; value: number; percentile: number }[]
	>;
	trendLeagueBySeason?: Record<number, Record<string, number>>;
};

// One representative regular-season row per season (handles multi-team seasons
// by keeping the row with the most games, i.e. the merged TOT row).
const buildTrendRows = (stats: any[]): TrendRow[] => {
	const bySeason = new Map<number, any>();
	for (const row of stats) {
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

const Analytics = ({
	player,
	analytics,
}: {
	player: {
		pid: number;
		stats: any[];
		careerStats?: Record<string, number>;
	};
	analytics?: PlayerAnalytics;
}) => {
	const rows = buildTrendRows(player.stats);

	const radarSeasons = analytics
		? Object.keys(analytics.radarBySeason)
				.map(Number)
				.sort((a, b) => b - a)
		: [];

	const [radarSeason, setRadarSeason] = useState(radarSeasons[0]);

	if (rows.length === 0) {
		return <p className="text-body-secondary mb-0">No stats yet.</p>;
	}

	const selectedSeason =
		radarSeason !== undefined && analytics?.radarBySeason[radarSeason]
			? radarSeason
			: radarSeasons[0];
	const radarAxes =
		selectedSeason !== undefined
			? analytics?.radarBySeason[selectedSeason]
			: undefined;

	const compareUrl = helpers.leagueUrl([
		"compare_players",
		`${player.pid}-${rows.at(-1)!.season}-r`,
	]);

	return (
		<>
			<Highlights rows={rows} careerStats={player.careerStats} />

			<div className="row">
				<div className="col-lg-5 mb-3">
					<div className="d-flex align-items-center mb-2">
						<h3 className="mb-0 h5">Percentile Profile</h3>
						{radarSeasons.length > 1 && radarAxes ? (
							<select
								className="form-select form-select-sm w-auto ms-2"
								value={selectedSeason}
								onChange={(event) => setRadarSeason(Number(event.target.value))}
							>
								{radarSeasons.map((season) => (
									<option key={season} value={season}>
										{season}
									</option>
								))}
							</select>
						) : null}
					</div>
					{radarAxes ? (
						<>
							<RadarChart axes={radarAxes} />
							<p className="text-body-secondary small text-center mt-2 mb-0">
								Percentile rank vs qualifying players
								{selectedSeason !== undefined ? ` in ${selectedSeason}` : ""}.
								The dashed ring marks the league average (50th percentile).
							</p>
						</>
					) : (
						<p className="text-body-secondary mb-0">
							Percentile profile is only available for basketball seasons.
						</p>
					)}
				</div>
				<div className="col-lg-7 mb-3">
					<h3 className="mb-2 h5">Career Trend</h3>
					<CareerTrend
						rows={rows}
						leagueBySeason={analytics?.trendLeagueBySeason}
					/>
				</div>
			</div>

			<div className="d-flex flex-wrap gap-2">
				<a className="btn btn-sm btn-light-bordered" href={compareUrl}>
					Compare players
				</a>
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
	);
};

export default Analytics;
