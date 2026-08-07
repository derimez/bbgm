// Multi-player percentile radar: every compared player's polygon is drawn on
// the same set of axes so their shapes can be read against each other
// directly, instead of side by side in separate charts.

export type RadarAxis = {
	stat: string;
	name: string;
	value: number;
	percentile: number;
};

export type RadarSeries = {
	name: string;
	color: string;
	axes: RadarAxis[];
};

const SIZE = 320;
const CENTER = SIZE / 2;
const MAX_R = 110; // leaves room for labels around the edge

const pointAt = (angle: number, radius: number) => {
	return {
		x: CENTER + radius * Math.cos(angle),
		y: CENTER + radius * Math.sin(angle),
	};
};

const RadarChartOverlay = ({ series }: { series: RadarSeries[] }) => {
	// All series share the same metric set/order (RADAR_METRICS), so the first
	// series with data defines the axis labels.
	const labelAxes = series.find((s) => s.axes.length >= 3)?.axes;
	if (!labelAxes) {
		return null;
	}
	const n = labelAxes.length;

	// Start at the top (-90deg) and go clockwise
	const angles = labelAxes.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / n);

	const rings = [25, 50, 75, 100];

	return (
		<div>
			<svg
				viewBox={`0 0 ${SIZE} ${SIZE}`}
				width="100%"
				style={{ maxWidth: SIZE, display: "block", margin: "0 auto" }}
				role="img"
				aria-label="Percentile radar comparison"
			>
				{/* Grid rings — the 50% ring is highlighted as the league average. */}
				{rings.map((ring) => {
					const pts = angles
						.map((angle) => {
							const { x, y } = pointAt(angle, (ring / 100) * MAX_R);
							return `${x},${y}`;
						})
						.join(" ");
					const isLeagueAvg = ring === 50;
					return (
						<polygon
							key={ring}
							points={pts}
							fill="none"
							stroke={
								isLeagueAvg ? "var(--bs-warning)" : "var(--bs-border-color)"
							}
							strokeWidth={isLeagueAvg ? 1.5 : 1}
							strokeDasharray={isLeagueAvg ? "5 4" : undefined}
						/>
					);
				})}

				{/* Axis spokes + labels */}
				{labelAxes.map((axis, i) => {
					const angle = angles[i]!;
					const edge = pointAt(angle, MAX_R);
					const labelPos = pointAt(angle, MAX_R + 22);
					const cos = Math.cos(angle);
					const anchor =
						Math.abs(cos) < 0.3 ? "middle" : cos > 0 ? "start" : "end";
					return (
						<g key={axis.stat}>
							<line
								x1={CENTER}
								y1={CENTER}
								x2={edge.x}
								y2={edge.y}
								stroke="var(--bs-border-color)"
								strokeWidth={1}
							/>
							<text
								x={labelPos.x}
								y={labelPos.y}
								textAnchor={anchor}
								dominantBaseline="middle"
								style={{ fontSize: 12, fill: "var(--bs-body-color)" }}
							>
								{axis.name}
							</text>
						</g>
					);
				})}

				{/* One polygon per player, layered so overlaps are still readable. */}
				{series.map((s) => {
					if (s.axes.length !== n) {
						return null;
					}
					const points = s.axes
						.map((axis, i) => {
							const { x, y } = pointAt(
								angles[i]!,
								(axis.percentile / 100) * MAX_R,
							);
							return `${x},${y}`;
						})
						.join(" ");
					return (
						<g key={s.name}>
							<polygon
								points={points}
								fill={s.color}
								fillOpacity={0.15}
								stroke={s.color}
								strokeWidth={2}
							/>
							{s.axes.map((axis, i) => {
								const { x, y } = pointAt(
									angles[i]!,
									(axis.percentile / 100) * MAX_R,
								);
								return (
									<circle key={axis.stat} cx={x} cy={y} r={3} fill={s.color} />
								);
							})}
						</g>
					);
				})}
			</svg>
			<div className="d-flex flex-wrap justify-content-center gap-3 mt-1">
				{series.map((s) => (
					<div key={s.name} className="d-flex align-items-center gap-1 small">
						<span
							style={{
								width: 10,
								height: 10,
								borderRadius: "50%",
								background: s.color,
								display: "inline-block",
							}}
						/>
						{s.name}
					</div>
				))}
			</div>
		</div>
	);
};

export default RadarChartOverlay;
