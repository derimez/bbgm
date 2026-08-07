import { useEffect, useState } from "react";
import { toWorker } from "../../util/toWorker.ts";
import type { View } from "../../../common/types.ts";

type Player = View<"roster">["players"][number];

type Vals = { min: string; target: string; max: string };

const FIELDS = [
	{ key: "min", label: "Min", title: "Minimum minutes (soft floor)" },
	{ key: "target", label: "Tgt", title: "Target minutes" },
	{ key: "max", label: "Max", title: "Maximum minutes (hard cap)" },
] as const;

const toStr = (v: number | undefined) => (v === undefined ? "" : String(v));

// Per-player hard-minutes editor: min / target / max, each with −/+ steppers.
// Steppers commit immediately; typing commits on blur. The worker clamps +
// orders the values and echoes them back, which we re-sync here.
const MinutesTarget = ({
	p,
	gameMinutes,
}: {
	p: Player;
	gameMinutes: number;
}) => {
	const mt = p.minutesTarget ?? {};
	const [vals, setVals] = useState<Vals>({
		min: toStr(mt.min),
		target: toStr(mt.target),
		max: toStr(mt.max),
	});

	useEffect(() => {
		const cur = p.minutesTarget ?? {};
		setVals({
			min: toStr(cur.min),
			target: toStr(cur.target),
			max: toStr(cur.max),
		});
		// Re-sync whenever the persisted values change.
	}, [p.minutesTarget?.min, p.minutesTarget?.target, p.minutesTarget?.max]);

	const commit = (next: Vals) => {
		const parse = (s: string) => {
			const n = Number.parseInt(s, 10);
			return s.trim() === "" || Number.isNaN(n) ? undefined : n;
		};
		void toWorker("main", "updateMinutesTarget", {
			pid: p.pid,
			min: parse(next.min),
			target: parse(next.target),
			max: parse(next.max),
		});
	};

	const step = (key: keyof Vals, delta: number) => {
		setVals((v) => {
			const cur = v[key] === "" ? 0 : Number(v[key]);
			const nextNum = Math.max(0, Math.min(gameMinutes, cur + delta));
			const next = { ...v, [key]: String(nextNum) };
			commit(next);
			return next;
		});
	};

	const nMin = vals.min === "" ? undefined : Number(vals.min);
	const nMax = vals.max === "" ? undefined : Number(vals.max);
	const invalid = nMin !== undefined && nMax !== undefined && nMin > nMax;

	return (
		<div className="d-flex flex-column gap-1">
			{FIELDS.map(({ key, label, title }) => (
				<div key={key} className="d-flex align-items-center gap-1">
					<span
						className="text-body-secondary text-end"
						style={{ width: 26, fontSize: "0.75em" }}
					>
						{label}
					</span>
					<div className="input-group input-group-sm flex-nowrap">
						<button
							type="button"
							className="btn btn-light-bordered px-1"
							title={`Decrease ${title}`}
							onClick={() => step(key, -1)}
						>
							−
						</button>
						<input
							type="number"
							min={0}
							max={gameMinutes}
							title={title}
							placeholder="–"
							className={`form-control text-center px-0${
								invalid ? " is-invalid" : ""
							}`}
							// 16px font-size avoids iOS zoom-on-focus
							style={{ width: 38, fontSize: 16 }}
							value={vals[key]}
							onChange={(event) =>
								setVals((v) => ({ ...v, [key]: event.target.value }))
							}
							onBlur={() => commit(vals)}
						/>
						<button
							type="button"
							className="btn btn-light-bordered px-1"
							title={`Increase ${title}`}
							onClick={() => step(key, 1)}
						>
							+
						</button>
					</div>
				</div>
			))}
		</div>
	);
};

export default MinutesTarget;
