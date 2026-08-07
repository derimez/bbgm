// Percentile radar: each axis is the player's percentile rank (0-100) vs all
// qualifying players that season. Pure SVG with a fixed viewBox so it scales
// responsively without a ResizeObserver.

export type RadarAxis = {
	stat: string;
	name: string;
	value: number;
	percentile: number;
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

const RadarChart = ({ axes }: { axes: RadarAxis[] }) => {
	const n = axes.length;
	if (n < 3) {
		return null;
	}

	// Start at the top (-90deg) and go clockwise
	const angles = axes.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / n);

	const rings = [25, 50, 75, 100];

	const polygonPoints = axes
		.map((axis, i) => {
			const { x, y } = pointAt(angles[i]!, (axis.percentile / 100) * MAX_R);
			return `${x},${y}`;
		})
		.join(" ");

	return (
		<svg
			viewBox={`0 0 ${SIZE} ${SIZE}`}
			width="100%"
			style={{ maxWidth: SIZE, display: "block", margin: "0 auto" }}
			role="img"
			aria-label="Percentile radar"
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
			{axes.map((axis, i) => {
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
						<text
							x={labelPos.x}
							y={labelPos.y + 13}
							textAnchor={anchor}
							dominantBaseline="middle"
							style={{ fontSize: 11, fill: "var(--bs-secondary-color)" }}
						>
							{Math.round(axis.percentile)}%
						</text>
					</g>
				);
			})}

			{/* Player polygon */}
			<polygon
				points={polygonPoints}
				fill="var(--bs-blue)"
				fillOpacity={0.25}
				stroke="var(--bs-blue)"
				strokeWidth={2}
			/>
			{axes.map((axis, i) => {
				const { x, y } = pointAt(angles[i]!, (axis.percentile / 100) * MAX_R);
				return (
					<circle key={axis.stat} cx={x} cy={y} r={3} fill="var(--bs-blue)" />
				);
			})}
		</svg>
	);
};

export default RadarChart;
