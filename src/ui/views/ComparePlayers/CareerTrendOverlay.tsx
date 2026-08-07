// Multi-player career-trend chart: one colored line per compared player over
// their own seasons, sharing a single metric selector and axis set. Mirrors the
// single-player CareerTrend on the detail card, minus the league-average line
// (which is per-player-season and would clutter an overlay).

import { useState } from "react";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Circle, LinePath } from "@visx/shape";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { useTooltip, TooltipWithBounds } from "@visx/tooltip";
import type { TrendRow } from "../Player/Analytics/CareerTrend.tsx";

export type TrendSeries = {
	name: string;
	color: string;
	rows: TrendRow[];
};

const METRICS = [
	{ stat: "per", name: "PER", format: (v: number) => v.toFixed(1) },
	{ stat: "ws", name: "Win Shares", format: (v: number) => v.toFixed(1) },
	{ stat: "ws48", name: "WS/48", format: (v: number) => v.toFixed(3) },
	{ stat: "tsp", name: "TS%", format: (v: number) => `${v.toFixed(1)}%` },
	{ stat: "bpm", name: "BPM", format: (v: number) => v.toFixed(1) },
	{ stat: "vorp", name: "VORP", format: (v: number) => v.toFixed(1) },
] as const;

type Point = { season: number; value: number };
type TooltipDatum = { name: string; season: number; value: number };

const Chart = ({
	series,
	metric,
	width,
}: {
	series: TrendSeries[];
	metric: (typeof METRICS)[number];
	width: number;
}) => {
	const HEIGHT = 280;
	const margin = { top: 12, left: 52, right: 16, bottom: 36 };
	const innerWidth = Math.max(0, width - margin.left - margin.right);

	const {
		showTooltip,
		hideTooltip,
		tooltipData,
		tooltipOpen,
		tooltipTop,
		tooltipLeft,
	} = useTooltip<TooltipDatum>();

	// Per-series points for this metric, sorted by season.
	const seriesData = series.map((s) => ({
		name: s.name,
		color: s.color,
		points: s.rows
			.map((r) => ({
				season: r.season,
				value: (r as any)[metric.stat] as number,
			}))
			.filter((d) => typeof d.value === "number" && Number.isFinite(d.value))
			.sort((a, b) => a.season - b.season) as Point[],
	}));

	const allPoints = seriesData.flatMap((s) => s.points);
	if (allPoints.length === 0) {
		return null;
	}

	const seasons = allPoints.map((d) => d.season);
	const values = allPoints.map((d) => d.value);

	const xScale = scaleLinear({
		domain: [Math.min(...seasons), Math.max(...seasons)],
		range: [0, innerWidth],
	});
	const yScale = scaleLinear({
		domain: [Math.min(0, ...values), Math.max(...values, 1)],
		range: [HEIGHT, 0],
		nice: true,
	});

	return (
		<div>
			<svg width={width} height={HEIGHT + margin.top + margin.bottom}>
				<Group transform={`translate(${margin.left},${margin.top})`}>
					<AxisLeft
						axisClassName="chart-axis"
						scale={yScale}
						numTicks={5}
						tickFormat={(v) => metric.format(v as number)}
						tickLabelProps={{ fontSize: "0.85em" }}
					/>
					<AxisBottom
						axisClassName="chart-axis"
						scale={xScale}
						top={HEIGHT}
						numTicks={Math.min(seasons.length, 8)}
						tickFormat={(v) => `${v}`}
						tickLabelProps={{ fontSize: "0.85em" }}
					/>
					{seriesData.map((s) => (
						<Group key={s.name}>
							{s.points.length > 1 ? (
								<LinePath
									data={s.points}
									x={(d) => xScale(d.season)}
									y={(d) => yScale(d.value)}
									stroke={s.color}
									strokeWidth={2.5}
								/>
							) : null}
							{s.points.map((d, i) => {
								const cx = xScale(d.season);
								const cy = yScale(d.value);
								return (
									<Circle
										key={i}
										cx={cx}
										cy={cy}
										r={4}
										fill={s.color}
										onMouseOver={() =>
											showTooltip({
												tooltipLeft: cx + margin.left,
												tooltipTop: cy + margin.top,
												tooltipData: {
													name: s.name,
													season: d.season,
													value: d.value,
												},
											})
										}
										onMouseOut={hideTooltip}
									/>
								);
							})}
						</Group>
					))}
				</Group>
			</svg>
			<div className="d-flex flex-wrap justify-content-center gap-3 small mt-1">
				{series.map((s) => (
					<span key={s.name} className="d-flex align-items-center gap-1">
						<svg width={22} height={8}>
							<line
								x1={0}
								y1={4}
								x2={22}
								y2={4}
								stroke={s.color}
								strokeWidth={2.5}
							/>
						</svg>
						{s.name}
					</span>
				))}
			</div>
			{tooltipOpen && tooltipData ? (
				<TooltipWithBounds left={tooltipLeft} top={tooltipTop}>
					<b>{tooltipData.name}</b>
					<br />
					{tooltipData.season}: {metric.format(tooltipData.value)}
				</TooltipWithBounds>
			) : null}
		</div>
	);
};

const CareerTrendOverlay = ({ series }: { series: TrendSeries[] }) => {
	const [statIndex, setStatIndex] = useState(0);
	const metric = METRICS[statIndex]!;

	const withData = series.filter((s) => s.rows.length > 0);
	if (withData.length === 0) {
		return null;
	}

	return (
		<div>
			<div className="btn-group btn-group-sm mb-2 flex-wrap" role="group">
				{METRICS.map((m, i) => (
					<button
						key={m.stat}
						type="button"
						className={`btn ${i === statIndex ? "btn-primary" : "btn-light-bordered"}`}
						onClick={() => setStatIndex(i)}
					>
						{m.name}
					</button>
				))}
			</div>
			<ParentSize>
				{({ width }) =>
					width > 0 ? (
						<Chart series={withData} metric={metric} width={width} />
					) : null
				}
			</ParentSize>
		</div>
	);
};

export default CareerTrendOverlay;
