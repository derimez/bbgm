import { useState } from "react";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Circle, LinePath } from "@visx/shape";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { useTooltip, TooltipWithBounds } from "@visx/tooltip";

export type TrendRow = {
	season: number;
	per: number;
	ws: number;
	ws48: number;
	tsp: number;
	bpm: number;
	vorp: number;
};

// Metrics available in the trend selector. format controls tick/tooltip display.
const METRICS = [
	{ stat: "per", name: "PER", format: (v: number) => v.toFixed(1) },
	{ stat: "ws", name: "Win Shares", format: (v: number) => v.toFixed(1) },
	{ stat: "ws48", name: "WS/48", format: (v: number) => v.toFixed(3) },
	{
		stat: "tsp",
		name: "TS%",
		// tsp is already stored on a 0-100 scale (helpers.percentage)
		format: (v: number) => `${v.toFixed(1)}%`,
	},
	{ stat: "bpm", name: "BPM", format: (v: number) => v.toFixed(1) },
	{ stat: "vorp", name: "VORP", format: (v: number) => v.toFixed(1) },
] as const;

const Chart = ({
	rows,
	metric,
	width,
}: {
	rows: TrendRow[];
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
	} = useTooltip<TrendRow>();

	const data = rows.map((r) => ({
		season: r.season,
		value: (r as any)[metric.stat] as number,
	}));

	const xVals = data.map((d) => d.season);
	const yVals = data.map((d) => d.value);
	const yMin = Math.min(0, ...yVals);
	const yMax = Math.max(...yVals, 1);

	const xScale = scaleLinear({
		domain: [Math.min(...xVals), Math.max(...xVals)],
		range: [0, innerWidth],
	});
	const yScale = scaleLinear({
		domain: [yMin, yMax],
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
						numTicks={Math.min(data.length, 8)}
						tickFormat={(v) => String(v)}
						tickLabelProps={{ fontSize: "0.85em" }}
					/>
					<LinePath
						data={data}
						x={(d) => xScale(d.season)}
						y={(d) => yScale(d.value)}
						stroke="var(--bs-blue)"
						strokeWidth={2.5}
					/>
					{data.map((d, i) => {
						const cx = xScale(d.season);
						const cy = yScale(d.value);
						return (
							<Circle
								key={i}
								cx={cx}
								cy={cy}
								r={4}
								fill="var(--bs-blue)"
								onMouseOver={() =>
									showTooltip({
										tooltipLeft: cx + margin.left,
										tooltipTop: cy + margin.top,
										tooltipData: rows[i],
									})
								}
								onMouseOut={hideTooltip}
							/>
						);
					})}
				</Group>
			</svg>
			{tooltipOpen && tooltipData ? (
				<TooltipWithBounds left={tooltipLeft} top={tooltipTop}>
					<b>{tooltipData.season}</b>:{" "}
					{metric.format((tooltipData as any)[metric.stat])}
				</TooltipWithBounds>
			) : null}
		</div>
	);
};

const CareerTrend = ({ rows }: { rows: TrendRow[] }) => {
	const [statIndex, setStatIndex] = useState(0);
	const metric = METRICS[statIndex]!;

	if (rows.length < 2) {
		return (
			<p className="text-body-secondary mb-0">
				Career trends appear once a player has at least two seasons.
			</p>
		);
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
					width > 0 ? <Chart rows={rows} metric={metric} width={width} /> : null
				}
			</ParentSize>
		</div>
	);
};

export default CareerTrend;
