import type { TrendRow } from "./CareerTrend.tsx";

type CardDef = {
	stat: keyof TrendRow;
	name: string;
	format: (v: number) => string;
	// "sum" stats (WS, VORP) show a career total; "peak" rate stats show career value
	kind: "total" | "rate";
};

const CARDS: CardDef[] = [
	{ stat: "per", name: "PER", format: (v) => v.toFixed(1), kind: "rate" },
	{
		stat: "ws",
		name: "Win Shares",
		format: (v) => v.toFixed(1),
		kind: "total",
	},
	{
		stat: "tsp",
		name: "TS%",
		// tsp is already stored on a 0-100 scale (helpers.percentage)
		format: (v) => `${v.toFixed(1)}%`,
		kind: "rate",
	},
	{ stat: "vorp", name: "VORP", format: (v) => v.toFixed(1), kind: "total" },
];

const StatCard = ({
	name,
	peakValue,
	peakSeason,
	subLabel,
	subValue,
}: {
	name: string;
	peakValue: string;
	peakSeason: number;
	subLabel: string;
	subValue: string;
}) => (
	<div className="col-6 col-lg-3">
		<div className="card h-100">
			<div className="card-body text-center py-3">
				<div className="text-body-secondary text-uppercase small mb-1">
					{name}
				</div>
				<div className="fs-3 fw-bold lh-1">{peakValue}</div>
				<div className="text-body-secondary small">Peak ({peakSeason})</div>
				<div className="border-top mt-2 pt-2 small">
					{subLabel}: <span className="fw-bold">{subValue}</span>
				</div>
			</div>
		</div>
	</div>
);

const Highlights = ({
	rows,
	careerStats,
}: {
	rows: TrendRow[];
	careerStats?: Record<string, number>;
}) => {
	if (rows.length === 0) {
		return null;
	}

	return (
		<div className="row g-2 mb-3">
			{CARDS.map((card) => {
				let peak = rows[0]!;
				for (const row of rows) {
					if ((row[card.stat] as number) > (peak[card.stat] as number)) {
						peak = row;
					}
				}

				const peakValue = card.format(peak[card.stat] as number);
				const careerValue = careerStats?.[card.stat];

				return (
					<StatCard
						key={card.stat}
						name={card.name}
						peakValue={peakValue}
						peakSeason={peak.season}
						subLabel={card.kind === "total" ? "Career" : "Career avg"}
						subValue={
							careerValue !== undefined ? card.format(careerValue) : "—"
						}
					/>
				);
			})}
		</div>
	);
};

export default Highlights;
