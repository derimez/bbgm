import clsx from "clsx";
import {
	Component,
	type ChangeEvent,
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	memo,
	type MutableRefObject,
} from "react";
import { TeamLogoInline } from "../../components/TeamLogoInline.tsx";
import useTitleBar from "../../hooks/useTitleBar.tsx";
import { helpers } from "../../util/helpers.ts";
import { toWorker } from "../../util/toWorker.ts";
import type { View } from "../../../common/types.ts";
import { bySport, isSport } from "../../../common/sportFunctions.ts";
import useLocalStorageState from "use-local-storage-state";
import { DEFAULT_SPORT_STATE as DEFAULT_SPORT_STATE_BASEBALL } from "../../util/processLiveGameEvents.baseball.tsx";
import { DEFAULT_SPORT_STATE as DEFAULT_SPORT_STATE_FOOTBALL } from "../../util/processLiveGameEvents.football.tsx";
import { processLiveGameEvents } from "../../util/processLiveGameEvents.ts";
import {
	BoxScoreWrapper,
	HeadlineScoreLive,
} from "../../components/BoxScoreWrapper.tsx";
import { useIsStuck } from "../../hooks/useIsStuck.ts";
import { useBlocker } from "../../hooks/useBlocker.ts";
import {
	PlayPauseNext,
	type FastForward,
} from "../../components/PlayPauseNext.tsx";
import { Confetti } from "./Confetti.tsx";
import { BoxScoreRow } from "../../components/BoxScoreRow.tsx";
import { getPeriodName } from "../../../common/getPeriodName.ts";

// Phase 3 simcast: inline iframe of the live court view. The simcast page is
// fully self-contained (loads its own Pixi, listens to /api/simcast WS for the
// gameStart packet that processLiveGameEvents fires when this view mounts).
//
// Fullscreen: tries native Fullscreen API; falls back to a CSS-based fake-FS
// (fixed-position cover) because iOS Safari restricts the real API to <video>
// elements — and Add-to-Home-Screen PWAs there have no API at all.
const SimcastPanel = () => {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	// Collapsed (hidden) by default, and the choice persists — so it stays
	// hidden across live games instead of needing to be collapsed every time.
	const [collapsed, setCollapsed] = useLocalStorageState("simcastCollapsed", {
		defaultValue: true,
	});
	const [fakeFs, setFakeFs] = useState(false);

	const toggleFullscreen = useCallback(() => {
		const el = wrapRef.current;
		if (!el) return;
		// If we're in fake-FS, exit out.
		if (fakeFs) {
			setFakeFs(false);
			return;
		}
		// If real FS is active, exit out.
		if (document.fullscreenElement) {
			document.exitFullscreen().catch(() => {});
			return;
		}
		// Try real FS first. On iOS Safari this will reject (or be missing
		// entirely) — fall back to CSS fake-FS in that case.
		const req = el.requestFullscreen?.bind(el);
		if (req) {
			req().catch(() => setFakeFs(true));
		} else {
			setFakeFs(true);
		}
	}, [fakeFs]);

	// Keep React state in sync if user exits real FS via Esc / system gesture.
	useEffect(() => {
		const onChange = () => {
			if (!document.fullscreenElement && fakeFs) setFakeFs(false);
		};
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, [fakeFs]);

	const wrapStyle: CSSProperties = fakeFs
		? {
				position: "fixed",
				inset: 0,
				zIndex: 9999,
				margin: 0,
				borderRadius: 0,
				background: "#0c0e12",
				display: "flex",
				flexDirection: "column",
				// Respect iOS notch / home indicator in fake-FS PWA mode.
				paddingTop: "env(safe-area-inset-top)",
				paddingBottom: "env(safe-area-inset-bottom)",
			}
		: {};
	const iframeStyle: CSSProperties = fakeFs
		? {
				display: "block",
				flex: "1 1 auto",
				width: "100%",
				height: "100%",
				border: 0,
			}
		: {
				display: "block",
				width: "100%",
				aspectRatio: "94 / 50",
				border: 0,
			};

	return (
		<div className="card mb-3" ref={wrapRef} style={wrapStyle}>
			<div className="card-header py-1 px-2 d-flex align-items-center">
				<span className="fw-bold text-body-secondary small">Simcast</span>
				<div className="ms-auto btn-group btn-group-sm">
					<button
						type="button"
						className="btn btn-light-bordered"
						title={collapsed ? "Expand" : "Collapse"}
						onClick={() => setCollapsed((c) => !c)}
					>
						{collapsed ? "Show" : "Hide"}
					</button>
					<button
						type="button"
						className="btn btn-light-bordered"
						title={fakeFs ? "Exit full screen" : "Full screen"}
						onClick={toggleFullscreen}
					>
						{fakeFs ? "✕" : "⛶"}
					</button>
				</div>
			</div>
			{collapsed && !fakeFs ? null : (
				<iframe src="/simcast?embedded=1" title="Simcast" style={iframeStyle} />
			)}
		</div>
	);
};

type PlayerRowProps = {
	exhibition?: boolean;
	forceUpdate?: boolean;
	i: number;
	liveGameInProgress?: boolean;
	p: any;
	season: number;
};

class PlayerRow extends Component<PlayerRowProps> {
	prevInGame: boolean | undefined;

	// Can't just switch to hooks and React.memo because p is mutated, so there is no way to access the previous value of inGame in the memo callback function
	override shouldComponentUpdate(nextProps: PlayerRowProps) {
		return bySport({
			baseball: true,
			basketball: !!(
				this.prevInGame ||
				nextProps.p.inGame ||
				nextProps.forceUpdate
			),
			football: true,
			hockey: !!(
				this.prevInGame ||
				nextProps.p.inGame ||
				nextProps.p.inPenaltyBox ||
				nextProps.forceUpdate
			),
		});
	}

	override render() {
		const { p, ...props } = this.props;

		// Needed for shouldComponentUpdate because state is mutated so we need to explicitly store the last value
		this.prevInGame = p.inGame;

		const classes = bySport({
			baseball: undefined,
			basketball: clsx({
				"table-warning": p.inGame,
			}),
			football: undefined,
			hockey: clsx({
				"table-warning": p.inGame,
				"table-danger": p.inPenaltyBox,
			}),
		});

		return <BoxScoreRow className={classes} p={p} {...props} />;
	}
}

const onLiveSimOver = () => {
	// Send to worker, rather than doing `localActions.update({ liveGameInProgress: false });`, so it works in all tabs
	toWorker("main", "onLiveSimOver", undefined);
};

const getSeconds = (time: string | undefined) => {
	if (!time) {
		return 0;
	}

	const parts = time.split(":").map((x) => Number.parseInt(x));
	if (parts.length === 0) {
		return 0;
	}
	if (parts.length === 1) {
		// Seconds only being displayed
		return Number.parseFloat(time);
	}
	const [min, sec] = parts as [number, number];
	return min * 60 + sec;
};

const DEFAULT_SPORT_STATE = bySport<any>({
	baseball: DEFAULT_SPORT_STATE_BASEBALL,
	basketball: undefined,
	football: DEFAULT_SPORT_STATE_FOOTBALL,
	hockey: undefined,
});

type PlayByPlayEntryInfo = {
	key: number;
	score: ReactNode | undefined;
	scoreDiff: number;
	scoreType: string | undefined;
	outs: number | undefined;
	t: 0 | 1 | undefined;
	text: ReactNode;
	textOnly: boolean;
	time: string;
};

const PlayByPlayEntry = memo(
	({ boxScore, entry }: { boxScore: any; entry: PlayByPlayEntryInfo }) => {
		let scoreBlock = null;
		if (entry.score) {
			if (isSport("basketball")) {
				scoreBlock = entry.score;
			} else {
				scoreBlock = (
					<>
						<span
							className={`fw-bold ${
								entry.scoreDiff >= 0 &&
								(!isSport("football") || entry.scoreType !== "Safety")
									? "text-success"
									: "text-danger"
							}`}
						>
							{bySport({
								baseball: boxScore.shootout
									? "Home run!"
									: `${entry.scoreDiff} ${helpers.plural(
											"run scores",
											entry.scoreDiff,
											"runs score",
										)}!`,
								basketball: "",
								football: boxScore.shootout
									? "It's good!"
									: `${entry.scoreType ?? "???"}!`,
								hockey: "Goal!",
							})}
						</span>{" "}
						{entry.score}
					</>
				);
			}
		}

		return (
			<div className="d-flex">
				{entry.t !== undefined ? (
					<TeamLogoInline
						alt={boxScore.teams[entry.t].abbrev}
						className={clsx("flex-shrink-0", {
							// If there is a time line, then add some margin to the top, looks better.
							// If it's just score and no time, then that's football, and no margin looks more consistent. So don't check score here.
							"mt-1": !entry.textOnly && entry.time,
						})}
						imgURL={boxScore.teams[entry.t].imgURL}
						imgURLSmall={boxScore.teams[entry.t].imgURLSmall}
						includePlaceholderIfNoLogo
					/>
				) : null}
				<div
					className={clsx(
						"flex-grow-1 align-self-center me-2",
						entry.textOnly ? "fw-bold" : undefined,
						entry.t !== undefined ? "ms-2" : undefined,
					)}
				>
					{!entry.textOnly ? (
						<div className="d-flex">
							{entry.time ? (
								<div className="text-body-secondary me-auto">{entry.time}</div>
							) : null}
							{isSport("basketball") ? scoreBlock : null}
						</div>
					) : null}
					{isSport("hockey") ? scoreBlock : null}
					{entry.text}
					{!isSport("basketball") && !isSport("hockey") ? (
						<div>{scoreBlock}</div>
					) : null}
					{entry.outs !== undefined ? (
						<div className="fw-bold text-danger">
							{entry.outs} {helpers.plural("out", entry.outs)}
						</div>
					) : null}
				</div>
			</div>
		);
	},
	() => true,
);

const PlayByPlay = ({
	boxScore,
	entries,
	playByPlayDivRef,
}: {
	boxScore: any;
	entries: PlayByPlayEntryInfo[];
	playByPlayDivRef: MutableRefObject<HTMLDivElement | null>;
}) => {
	useEffect(() => {
		const setPlayByPlayDivHeight = () => {
			if (playByPlayDivRef.current) {
				// Keep in sync with .live-game-affix
				if (window.matchMedia("(min-width:768px)").matches) {
					playByPlayDivRef.current.style.height = `${
						window.innerHeight - 113
					}px`;
				} else if (playByPlayDivRef.current.style.height !== "") {
					playByPlayDivRef.current.style.removeProperty("height");
				}
			}
		};

		// Keep height of plays list equal to window
		setPlayByPlayDivHeight();
		window.addEventListener("optimizedResize", setPlayByPlayDivHeight);

		return () => {
			window.removeEventListener("optimizedResize", setPlayByPlayDivHeight);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div
			className="live-game-playbyplay d-flex flex-column gap-3"
			ref={playByPlayDivRef}
			style={{
				scrollMarginTop: 174,
			}}
		>
			{entries.map((entry) => (
				<PlayByPlayEntry key={entry.key} boxScore={boxScore} entry={entry} />
			))}
		</div>
	);
};

const DEFAULT_SPEED = 7;

const speedToMs = (speed: number) => {
	return 4000 / 1.2 ** speed;
};

// ── Simcast playback sync (basketball only) ──────────────────────────────────
// The live court view at /simcast is a rendering slave to THIS playback loop.
// We POST a lightweight control frame to the local sync server on every play
// advance (carrying the current game clock) and on pause/play, so the simcast
// derives its speed from our cadence and freezes when we pause. Fire-and-forget:
// no simcast open → the broadcast fans out to nobody, harmless.
const emitSimControl = (payload: Record<string, unknown>) => {
	if (typeof fetch === "undefined" || !isSport("basketball")) {
		return;
	}
	try {
		fetch("/api/sim-control", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			keepalive: true,
		}).catch(() => {});
	} catch {}
};

// Throttle per-advance clock ticks — fast-forward calls processToNextPause in a
// tight loop, but ~13 ticks/sec is plenty for the simcast to track pace. A final
// gameOver tick always goes through.
let lastSimTickMs = 0;
const emitSimTick = (gameClock: number, gameOver: boolean, period: number) => {
	const t = typeof performance !== "undefined" ? performance.now() : Date.now();
	if (!gameOver && t - lastSimTickMs < 75) {
		return;
	}
	lastSimTickMs = t;
	emitSimControl({ gameClock, gameOver, period });
};

// ── Live coach mode ───────────────────────────────────────────────────────────
// Pause the game, hand out new orders (force players onto the floor or the
// bench, playing time up/down), and the worker re-sims the REST of the game
// from the pause point. Same seed + same inputs means everything already
// watched stays canon — only the future changes. The new tail is spliced into
// the local playback queue and pushed to the simcast so the court view diverges
// in lockstep. Basketball league games only (exhibitions don't go through the
// seeded live-sim stash).

// Broadcast the coached game to the simcast. Same filtering as the gameStart
// packet in processLiveGameEvents.basketball: drop the leading init event and
// the per-stat increments. Fire-and-forget, like emitSimControl.
const emitSimSplice = (gid: number, newEvents: any[]) => {
	if (typeof fetch === "undefined" || !isSport("basketball")) {
		return;
	}
	try {
		fetch("/api/sim-splice", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				gid,
				events: newEvents.slice(1).filter((ev: any) => ev?.type !== "stat"),
			}),
			keepalive: true,
		}).catch(() => {});
	} catch {}
};

type CoachOrder = {
	force?: "on" | "off";
	pt?: number;
};

type CoachOrders = {
	pt: Record<number, number>;
	forceOn: number[];
	forceOff: number[];
};

const CoachPanel = ({
	boxScore,
	onApply,
	onOpenPause,
	paused,
}: {
	boxScore: any;
	onApply: (orders: CoachOrders) => Promise<string>;
	onOpenPause: () => void;
	paused: boolean;
}) => {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [orders, setOrders] = useState<Record<number, CoachOrder>>({});
	const [status, setStatus] = useState<string | undefined>();

	const setForce = (pid: number, force: CoachOrder["force"]) => {
		setOrders((prev) => ({ ...prev, [pid]: { ...prev[pid], force } }));
	};
	const setPt = (pid: number, pt: number | undefined) => {
		setOrders((prev) => ({ ...prev, [pid]: { ...prev[pid], pt } }));
	};

	const disabled =
		busy ||
		!paused ||
		boxScore.gameOver ||
		boxScore.shootout ||
		boxScore.elamTarget !== undefined;

	const apply = async () => {
		const pt: Record<number, number> = {};
		const forceOn: number[] = [];
		const forceOff: number[] = [];
		for (const [pidStr, order] of Object.entries(orders)) {
			const pid = Number(pidStr);
			if (order.pt !== undefined) {
				pt[pid] = order.pt;
			}
			if (order.force === "on") {
				forceOn.push(pid);
			} else if (order.force === "off") {
				forceOff.push(pid);
			}
		}

		setBusy(true);
		setStatus("Re-simming the rest of the game…");
		try {
			setStatus(await onApply({ pt, forceOn, forceOff }));
		} catch (error) {
			setStatus(`Re-sim failed: ${(error as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card mb-3">
			<div className="card-header py-1 px-2 d-flex align-items-center">
				<span className="fw-bold text-body-secondary small">Coach mode</span>
				<div className="ms-auto btn-group btn-group-sm">
					<button
						type="button"
						className="btn btn-light-bordered"
						onClick={() => {
							if (!open) {
								// Coaching happens from a dead ball — pause on open.
								onOpenPause();
							}
							setOpen((o) => !o);
						}}
					>
						{open ? "Hide" : "Coach"}
					</button>
				</div>
			</div>
			{open ? (
				<div className="card-body p-2">
					{boxScore.gameOver ? (
						<p className="text-body-secondary mb-2">
							Game over — nothing left to coach.
						</p>
					) : !paused ? (
						<p className="text-body-secondary mb-2">
							Pause the game to make changes.
						</p>
					) : null}
					<div className="row">
						{([0, 1] as const).map((t) => (
							<div className="col-12 col-xl-6" key={t}>
								<h5>
									{boxScore.teams[t].region} {boxScore.teams[t].name}
								</h5>
								<div className="table-responsive">
									<table className="table table-sm align-middle mb-2">
										<thead>
											<tr>
												<th>Player</th>
												<th className="text-end">MIN</th>
												<th className="text-end">PTS</th>
												<th>Floor</th>
												<th>PT</th>
											</tr>
										</thead>
										<tbody>
											{boxScore.teams[t].players.map((p: any) => {
												const order = orders[p.pid] ?? {};
												const injured = p.injury?.gamesRemaining === -1;
												return (
													<tr
														key={p.pid}
														className={p.inGame ? "table-warning" : undefined}
													>
														<td>
															{p.name}
															<span className="text-body-secondary">
																{" "}
																{p.pos}
															</span>
															{injured ? (
																<span className="text-danger"> (injured)</span>
															) : null}
														</td>
														<td className="text-end">{Math.round(p.min)}</td>
														<td className="text-end">{p.pts}</td>
														<td>
															<div className="btn-group btn-group-sm">
																{(
																	[
																		["Auto", undefined],
																		["On", "on"],
																		["Bench", "off"],
																	] as const
																).map(([label, value]) => (
																	<button
																		key={label}
																		type="button"
																		className={`btn ${
																			order.force === value
																				? "btn-primary"
																				: "btn-light-bordered"
																		}`}
																		disabled={
																			disabled || (injured && value === "on")
																		}
																		onClick={() => setForce(p.pid, value)}
																	>
																		{label}
																	</button>
																))}
															</div>
														</td>
														<td>
															<select
																className="form-select form-select-sm"
																style={{ width: 90 }}
																disabled={disabled}
																value={
																	order.pt === undefined ? "" : String(order.pt)
																}
																onChange={(event) => {
																	const { value } = event.target;
																	setPt(
																		p.pid,
																		value === "" ? undefined : Number(value),
																	);
																}}
															>
																<option value="">Auto</option>
																<option value="0">0</option>
																<option value="0.75">−</option>
																<option value="1">Normal</option>
																<option value="1.25">+</option>
																<option value="1.75">++</option>
															</select>
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							</div>
						))}
					</div>
					<div className="d-flex align-items-center">
						<button
							type="button"
							className="btn btn-primary"
							disabled={disabled}
							onClick={apply}
						>
							{busy ? "Re-simming…" : "Apply — re-sim rest of game"}
						</button>
						{status ? <div className="ms-3">{status}</div> : null}
					</div>
					{boxScore.shootout || boxScore.elamTarget !== undefined ? (
						<p className="text-body-secondary mt-2 mb-0">
							Coaching changes aren't available during a shootout or Elam
							Ending.
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
};

const getNavigateWarning = (exhibition: boolean | undefined) => {
	return exhibition
		? "If you navigate away from this page, you won't be able to see this box score again."
		: "If you navigate away from this page, you won't be able to see these play-by-play results again. The results of this game are already final, though.";
};

export const LiveGame = (props: View<"liveGame">) => {
	const [paused, setPaused] = useState(false);
	const pausedRef = useRef(paused);
	const [speed, setSpeed] = useLocalStorageState("live-game-speed", {
		defaultValue: String(DEFAULT_SPEED),
	});
	const speedRef = useRef(Number.parseInt(speed));
	const [playIndex, setPlayIndex] = useState(-1);
	const [started, setStarted] = useState(false);
	const [confetti, setConfetti] = useState<{
		colors?: [string, string, string];
		display: boolean;
	}>({
		display: false,
	});

	const boxScore = useRef<any>(
		props.initialBoxScore ? props.initialBoxScore : {},
	);

	const overtimes = useRef(0);
	const playByPlayDiv = useRef<HTMLDivElement | null>(null);
	const quarters = useRef([]);
	const possessionChange = useRef<boolean | undefined>(undefined);
	const componentIsMounted = useRef(false);
	const events = useRef<any[] | undefined>(undefined);

	// Live coach mode: events.current is consumed destructively as plays render,
	// so keep the FULL event list of the current timeline too — consumed count =
	// allEvents.length − events.length, which is where a re-simmed game gets
	// spliced in. Every accepted coaching change accumulates in the schedule
	// because each re-sim replays the whole game from the tip-off.
	const allEvents = useRef<any[] | undefined>(undefined);
	const coachingScheduleRef = useRef<any[]>([]);
	const sportState = useRef(
		DEFAULT_SPORT_STATE ? { ...DEFAULT_SPORT_STATE } : undefined,
	);

	const playByPlayEntries = useRef<PlayByPlayEntryInfo[]>([]);

	const navigateWarning = getNavigateWarning(boxScore.current.exhibition);

	const { setDirty } = useBlocker({
		message: navigateWarning,
		initialDirty: true,
	});

	// Make sure to call setPlayIndex after calling this! Can't be done inside because React is not always smart enough to batch renders
	const processToNextPause = useCallback(
		(force?: boolean): number => {
			if (
				!componentIsMounted.current ||
				(pausedRef.current && !force) ||
				!events.current
			) {
				return 0;
			}

			const startSeconds = getSeconds(boxScore.current.time);

			const shootout = !!boxScore.current.shootout;
			const ptsKey = shootout ? "sPts" : "pts";

			// Save here since it is mutated in processLiveGameEvents
			const prevOuts = sportState.current?.outs;
			const prevPts =
				boxScore.current.teams[0][ptsKey] + boxScore.current.teams[1][ptsKey];

			const output = processLiveGameEvents({
				boxScore: boxScore.current,
				events: events.current,
				overtimes: overtimes.current,
				quarters: quarters.current,
				sportState: sportState.current,
			});
			const text = output.text;
			const currentPts =
				boxScore.current.teams[0][ptsKey] + boxScore.current.teams[1][ptsKey];
			const scoreDiff = currentPts - prevPts;

			overtimes.current = output.overtimes;
			quarters.current = output.quarters;
			possessionChange.current = output.possessionChange;
			sportState.current = output.sportState;

			if (text !== undefined) {
				let outs;
				if (isSport("baseball") && output.sportState.outs > prevOuts) {
					outs = output.sportState.outs;
				}

				// For baseball, always show logo of the batting team, since t is not always sent in output (or maybe never sent)
				const t = isSport("baseball") ? sportState.current.o : output.t;

				let score;
				let scoreType;
				if (scoreDiff !== 0) {
					// Swap team for safety
					const scoreT =
						isSport("football") &&
						sportState.current.plays.at(-1)?.scoreInfo?.type === "SF"
							? t === 0
								? 1
								: 0
							: t;

					score =
						scoreT === 0 ? (
							<>
								<b>{boxScore.current.teams[0][ptsKey]}</b>-
								<span className="text-body-secondary">
									{boxScore.current.teams[1][ptsKey]}
								</span>
							</>
						) : scoreT === 1 ? (
							<>
								<span className="text-body-secondary">
									{boxScore.current.teams[0][ptsKey]}
								</span>
								-<b>{boxScore.current.teams[1][ptsKey]}</b>
							</>
						) : undefined;

					if (isSport("football")) {
						// If no score type, then it must be a penalty overturning a score
						scoreType =
							sportState.current.plays.at(-1)?.scoreInfo?.long ??
							"Penalty overturned score";
					}
				}

				let time;
				// Baseball has no time, football it's displayed with down/distance before play. In both cases, skip showing time for individual entries.
				if (
					bySport({
						baseball: false,
						basketball: true,
						football: false,
						hockey: true,
					})
				) {
					if (shootout && t !== undefined) {
						time = `Attempt ${boxScore.current.teams[t].sAtt}`;
					} else if (
						isSport("basketball") &&
						boxScore.current.elamTarget !== undefined
					) {
						time = `Target: ${boxScore.current.elamTarget}`;
					} else {
						time = boxScore.current.time;
					}
				}

				playByPlayEntries.current.unshift({
					key: playByPlayEntries.current.length,
					score,
					scoreDiff,
					scoreType,
					outs,
					text,
					textOnly: output.textOnly,
					t,
					time,
				});
			}

			if (events.current && events.current.length > 0) {
				if (!pausedRef.current) {
					setTimeout(() => {
						processToNextPause();
						setPlayIndex((prev) => prev + 1);
					}, speedToMs(speedRef.current));
				}
			} else {
				boxScore.current.time = "0:00";
				boxScore.current.gameOver = true;
				boxScore.current.possession = undefined;

				// Update team records with result of game
				// Keep in sync with liveGame.ts
				if (!boxScore.current.exhibition) {
					for (const t of boxScore.current.teams) {
						if (boxScore.current.playoffs) {
							if (t.playoffs) {
								if (boxScore.current.won.tid === t.tid) {
									t.playoffs.won += 1;

									if (props.confetti) {
										setConfetti({
											display: true,
											colors: t.colors,
										});
									}
								} else if (boxScore.current.lost.tid === t.tid) {
									t.playoffs.lost += 1;
								}
							}
						} else {
							if (
								boxScore.current.won.pts === boxScore.current.lost.pts &&
								boxScore.current.won.sPts === boxScore.current.lost.sPts
							) {
								// Tied!
								if (t.tied !== undefined) {
									t.tied += 1;
								}
							} else if (boxScore.current.won.tid === t.tid) {
								t.won += 1;
							} else if (boxScore.current.lost.tid === t.tid) {
								if (boxScore.current.overtimes > 0 && props.otl) {
									t.otl += 1;
								} else {
									t.lost += 1;
								}
							}
						}
					}
				}

				if (!boxScore.current.exhibition) {
					setDirty(false);
				}
				onLiveSimOver();
			}

			const endSeconds = getSeconds(boxScore.current.time);

			// Heartbeat to the simcast: current game clock, period, and end-of-game flag.
			emitSimTick(
				endSeconds,
				!!boxScore.current.gameOver,
				Math.max(1, quarters.current.length),
			);

			// This is negative when rolling over to a new quarter
			const elapsedSeconds = startSeconds - endSeconds;
			return elapsedSeconds;
		},
		[props.confetti, props.otl, setDirty],
	);

	useEffect(() => {
		componentIsMounted.current = true;

		return () => {
			componentIsMounted.current = false;
			onLiveSimOver();
		};
	}, []);

	const startLiveGame = useCallback(
		(events2: any[]) => {
			events.current = events2;
			allEvents.current = events2.slice();
			setTimeout(() => {
				processToNextPause();
				setPlayIndex((prev) => prev + 1);
			}, speedToMs(DEFAULT_SPEED));
		},
		[processToNextPause],
	);

	useEffect(() => {
		if (props.events && !started) {
			boxScore.current = props.initialBoxScore;
			setStarted(true);
			startLiveGame(props.events.slice());
		}
	}, [props.events, props.initialBoxScore, started, startLiveGame]);

	const handleSpeedChange = (event: ChangeEvent<HTMLInputElement>) => {
		const speed = event.target.value;
		setSpeed(speed);
		speedRef.current = Number.parseInt(speed);
	};

	const handlePause = useCallback(() => {
		setPaused(true);
		pausedRef.current = true;
		emitSimControl({ paused: true });
	}, []);

	const handlePlay = useCallback(() => {
		setPaused(false);
		emitSimControl({ paused: false });

		// Without pausedRef check, this was a race condition and could lead to incorrect post-game records (counting as 2 or more wins)
		if (pausedRef.current) {
			pausedRef.current = false;
			processToNextPause();
		}

		setPlayIndex((prev) => prev + 1);
	}, [processToNextPause]);

	const handleNextPlay = useCallback(() => {
		processToNextPause(true);
		setPlayIndex((prev) => prev + 1);
	}, [processToNextPause]);

	// Live coach mode: re-sim the rest of the game with the new orders and splice
	// the new tail into the playback queue. Runs while paused, so no setTimeout
	// playback callback can be consuming events.current concurrently (they no-op
	// on pausedRef). Returns a status string for the coach panel.
	const applyCoaching = useCallback(
		async (orders: CoachOrders): Promise<string> => {
			const all = allEvents.current;
			if (!all || !events.current) {
				return "Game events not available yet.";
			}
			const gid = boxScore.current.gid;
			// ptsQtrs grows one entry per period INCLUDING overtimes, matching the
			// sim's own period counter (quarters.current does not grow in OT).
			const period = Math.max(1, boxScore.current.teams[0].ptsQtrs.length);
			const clockNow = getSeconds(boxScore.current.time);
			const consumed = all.length - events.current.length;

			// The change fires at the first possession whose game clock has reached
			// (period, clock). The displayed clock can sit mid-possession, so a
			// trigger keyed exactly to it can (rarely) fire one possession EARLY in
			// the re-sim and rewrite a play that was already shown. Verify the
			// consumed prefix is untouched; on mismatch retry with a later trigger.
			for (const backoff of [0, 2, 6]) {
				const change = {
					period,
					clock: clockNow - backoff,
					pt: orders.pt,
					forceOn: orders.forceOn,
					forceOff: orders.forceOff,
					// Each apply is a full snapshot of the standing orders, so releasing
					// a toggle in the UI genuinely releases the player in the engine.
					clearForce: true,
				};
				const schedule = [...coachingScheduleRef.current, change];
				const newEvents = await toWorker("main", "resimFromCoaching", {
					gid,
					coachingSchedule: schedule,
				});
				if (!newEvents) {
					return "Re-sim unavailable — the live game is no longer stashed in the worker.";
				}

				// [0] is the init event, which embeds the FINAL box score — it always
				// differs between outcomes and was consumed before anything displayed.
				let prefixIntact = newEvents.length >= consumed;
				if (prefixIntact) {
					for (let i = 1; i < consumed; i++) {
						if (JSON.stringify(newEvents[i]) !== JSON.stringify(all[i])) {
							prefixIntact = false;
							break;
						}
					}
				}
				if (!prefixIntact) {
					continue;
				}

				coachingScheduleRef.current = schedule;
				allEvents.current = newEvents;
				events.current = newEvents.slice(consumed);

				// Push the coached game to the simcast so the court view diverges too.
				emitSimSplice(gid, newEvents);

				return `New orders in — the rest of the game has been re-simmed from ${boxScore.current.quarterShort} ${boxScore.current.time} (${newEvents.length - consumed} events rewritten).`;
			}
			return "The change kept landing on a play that already happened — advance one play and try again.";
		},
		[],
	);

	const fastForwardMenuItems = useMemo(() => {
		// Plays up to `cutoffs` seconds, or until end of quarter
		const playSeconds = (cutoff: number) => {
			let seconds = 0;
			let numPlays = 0;

			// Stop at shootout, unless we're already in a shootout
			const initialShootout = boxScore.current.shootout;

			while (
				seconds < cutoff &&
				!boxScore.current.gameOver &&
				(initialShootout || !boxScore.current.shootout)
			) {
				const elapsedSeconds = processToNextPause(true);
				numPlays += 1;
				if (elapsedSeconds > 0) {
					seconds += elapsedSeconds;
				} else if (elapsedSeconds < 0) {
					// End of quarter, always stop
					break;
				}
			}
			setPlayIndex((prev) => prev + numPlays);
		};

		const playUntilLastTwoMinutes = () => {
			// quarters.current.length can be 0 early in the game
			const initialQuarter = Math.max(1, quarters.current.length);

			const quartersToPlay =
				initialQuarter >= boxScore.current.numPeriods
					? 0
					: boxScore.current.numPeriods - initialQuarter;
			for (let i = 0; i < quartersToPlay; i++) {
				playSeconds(Infinity);
			}

			const currentSeconds = getSeconds(boxScore.current.time);
			const targetSeconds = 125; // 2 minutes plus 5 seconds, cause can't always be exact
			const secoundsToPlay = currentSeconds - targetSeconds;
			if (secoundsToPlay > 0) {
				playSeconds(secoundsToPlay);
			}
		};

		const playUntilElamEnding = () => {
			let numPlays = 0;
			while (
				boxScore.current.elamTarget === undefined &&
				!boxScore.current.gameOver
			) {
				processToNextPause(true);
				numPlays += 1;
			}
			setPlayIndex((prev) => prev + numPlays);
		};

		const playUntilNextScore = () => {
			const initialPts =
				boxScore.current.teams[0].pts + boxScore.current.teams[1].pts;
			let currentPts = initialPts;
			let numPlays = 0;
			while (
				initialPts === currentPts &&
				!boxScore.current.gameOver &&
				!boxScore.current.shootout
			) {
				processToNextPause(true);
				currentPts =
					boxScore.current.teams[0].pts + boxScore.current.teams[1].pts;
				numPlays += 1;
			}
			setPlayIndex((prev) => prev + numPlays);
		};

		const playUntilChangeOfPossession = () => {
			let numPlays = 0;

			// If currently on one, play through it
			if (possessionChange.current) {
				while (possessionChange.current && !boxScore.current.gameOver) {
					processToNextPause(true);
					numPlays += 1;
				}
			}

			// Find next one
			while (!possessionChange.current && !boxScore.current.gameOver) {
				processToNextPause(true);
				numPlays += 1;
			}

			setPlayIndex((prev) => prev + numPlays);
		};

		// elamTarget check is because clock is set to Infinity in Elam ending, so we can't skip ahead minutes
		let skipMinutes =
			isSport("baseball") ||
			boxScore.current.elamTarget !== undefined ||
			boxScore.current.shootout
				? []
				: [
						{
							minutes: 1,
							keyboardShortcut: "o",
						},
						{
							minutes: helpers.bound(
								Math.round(props.quarterLength / 4),
								1,
								Infinity,
							),
							keyboardShortcut: "t",
						},
						{
							minutes: helpers.bound(
								Math.round(props.quarterLength / 2),
								1,
								Infinity,
							),
							keyboardShortcut: "s",
						},
					];

		// Dedupe
		const skipMinutesValues = new Set();
		skipMinutes = skipMinutes.filter(({ minutes }) => {
			if (skipMinutesValues.has(minutes)) {
				return false;
			}

			skipMinutesValues.add(minutes);
			return true;
		});

		const getNumSidesSoFar = () =>
			boxScore.current.teams === undefined
				? 0
				: boxScore.current.teams[0].ptsQtrs.length +
					boxScore.current.teams[1].ptsQtrs.length;

		const menuItems: FastForward[] = [
			...skipMinutes.map(
				({ minutes, keyboardShortcut }) =>
					({
						label: `${minutes} ${helpers.plural("minute", minutes)}`,
						keyboardShortcut,
						onClick: () => {
							playSeconds(60 * minutes);
						},
					}) as FastForward,
			),
			...(isSport("baseball")
				? !boxScore.current.shootout
					? ([
							{
								label: "Next batter",
								keyboardShortcut: "o",
								onClick: () => {
									let numPlays = 0;

									const initialBatter = sportState.current?.batterPid;
									while (!boxScore.current.gameOver) {
										processToNextPause(true);
										numPlays += 1;

										const currentBatter = sportState.current?.batterPid;
										if (
											currentBatter !== undefined &&
											currentBatter >= 0 &&
											initialBatter !== currentBatter
										) {
											break;
										}
									}

									setPlayIndex((prev) => prev + numPlays);
								},
							},
							{
								label: "Next baserunner",
								keyboardShortcut: "t",
								onClick: () => {
									const sportStateBaseball =
										sportState.current as typeof DEFAULT_SPORT_STATE_BASEBALL;
									const initialBases = sportStateBaseball.bases ?? [];
									const initialBaserunners = new Set(
										initialBases.filter((pid) => pid !== undefined),
									);

									const initialHR =
										boxScore.current.teams[0].hr + boxScore.current.teams[1].hr;

									let numPlays = 0;

									while (!boxScore.current.gameOver) {
										processToNextPause(true);
										numPlays += 1;

										// Any new baserunner -> stop
										const baserunners = (sportStateBaseball.bases ?? []).filter(
											(pid) => pid !== undefined,
										);
										if (baserunners.length === 0) {
											// Handle case where it's a new inning and the same guy gets on base
											initialBaserunners.clear();
										}
										if (
											baserunners.some((pid) => !initialBaserunners.has(pid))
										) {
											break;
										}

										// Home run counts as new baserunner
										const currentHR =
											boxScore.current.teams[0].hr +
											boxScore.current.teams[1].hr;
										if (initialHR !== currentHR) {
											break;
										}
									}

									setPlayIndex((prev) => prev + numPlays);
								},
							},
							{
								label: "Side is retired",
								keyboardShortcut: "c",
								onClick: () => {
									let numPlays = 0;

									const numSidesSoFar = getNumSidesSoFar();
									while (
										!boxScore.current.gameOver &&
										!boxScore.current.shootout
									) {
										processToNextPause(true);
										numPlays += 1;

										if (numSidesSoFar !== getNumSidesSoFar()) {
											break;
										}
									}

									setPlayIndex((prev) => prev + numPlays);
								},
							},
							{
								label: "End of inning",
								keyboardShortcut: "q",
								onClick: () => {
									let numPlays = 0;

									const numSidesSoFar = getNumSidesSoFar();
									while (
										!boxScore.current.gameOver &&
										!boxScore.current.shootout
									) {
										processToNextPause(true);
										numPlays += 1;

										const newNum = getNumSidesSoFar();
										if (numSidesSoFar !== newNum && newNum % 2 === 1) {
											break;
										}
									}

									setPlayIndex((prev) => prev + numPlays);
								},
							},
							...(getNumSidesSoFar() <= (boxScore.current.numPeriods - 1) * 2
								? [
										{
											label: `${helpers.ordinal(boxScore.current.numPeriods)} inning`,
											keyboardShortcut: "u",
											onClick: () => {
												let numPlays = 0;

												while (
													getNumSidesSoFar() <=
														(boxScore.current.numPeriods - 1) * 2 &&
													!boxScore.current.gameOver
												) {
													processToNextPause(true);
													numPlays += 1;
												}

												setPlayIndex((prev) => prev + numPlays);
											},
										},
									]
								: []),
						] as FastForward[])
					: ([
							{
								label: "End of shootout",
								keyboardShortcut: "q",
								onClick: () => {
									playSeconds(Infinity);
								},
							},
						] as FastForward[])
				: ([
						{
							label: `End of ${
								boxScore.current.elamTarget !== undefined
									? "game"
									: boxScore.current.shootout
										? "shootout"
										: boxScore.current.overtime
											? "period"
											: getPeriodName(boxScore.current.numPeriods)
							}`,
							keyboardShortcut: "q",
							onClick: () => {
								playSeconds(Infinity);
							},
						},
					] as FastForward[])),
		];

		if (
			!boxScore.current.elam &&
			!boxScore.current.shootout &&
			!isSport("baseball")
		) {
			menuItems.push({
				label: "Last 2 minutes",
				keyboardShortcut: "u",
				onClick: () => {
					playUntilLastTwoMinutes();
				},
			});
		}

		if (
			bySport({
				baseball: false,
				basketball: false,
				football: true,
				hockey: false,
			}) &&
			!boxScore.current.shootout
		) {
			menuItems.push({
				label: "Change of possession",
				keyboardShortcut: "c",
				onClick: () => {
					playUntilChangeOfPossession();
				},
			});
		}

		if (
			bySport({
				baseball: true,
				basketball: false,
				football: true,
				hockey: true,
			}) &&
			!boxScore.current.shootout
		) {
			menuItems.push({
				label: `Next ${bySport({
					hockey: "goal",
					default: "score",
				})}`,
				keyboardShortcut: "g",
				onClick: () => {
					playUntilNextScore();
				},
			});
		}

		if (
			boxScore.current.elam &&
			!boxScore.current.elamOvertime &&
			boxScore.current.elamTarget === undefined
		) {
			menuItems.push({
				label: "Elam Ending",
				keyboardShortcut: "u",
				onClick: () => {
					playUntilElamEnding();
				},
			});
		}

		return menuItems;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		boxScore.current.elam,
		boxScore.current.elamTarget,
		boxScore.current.overtime,
		boxScore.current.shootout,
		quarters.current.length,
		processToNextPause,
	]);

	const scrollTop = useRef<HTMLDivElement>(null);

	const [showWarning, setShowWarning] = useLocalStorageState(
		"showLiveSimWarning",
		{
			defaultValue: true,
		},
	);

	const [liveGameStickyDiv, setLiveGameStickyDiv] =
		useState<HTMLElement | null>(null);
	const isStuck = useIsStuck(liveGameStickyDiv);

	// Needs to return actual div, not fragment, for AutoAffix!!!
	return (
		<div>
			{confetti.display ? <Confetti colors={confetti.colors} /> : null}

			{showWarning ? (
				<p className="text-danger">
					{navigateWarning}
					<>
						{" "}
						<button
							className="btn btn-link p-0 border-0"
							onClick={() => {
								setShowWarning(false);
							}}
						>
							(Dismiss)
						</button>
					</>
				</p>
			) : null}

			<div
				className="row"
				ref={scrollTop}
				style={{
					scrollMarginTop: 174,
				}}
			>
				<div className="col-md-9">
					{boxScore.current.gid >= 0 ? (
						<div className="live-game-sticky mb-3" ref={setLiveGameStickyDiv}>
							<div className="pt-1 pt-md-0 live-game-score-wrapper">
								<HeadlineScoreLive
									boxScore={boxScore.current}
									isStuck={isStuck}
								/>
								<div className="d-flex align-items-center d-md-none pt-2">
									<PlayPauseNext
										className="me-2"
										disabled={boxScore.current.gameOver}
										fastForwardAlignRight
										fastForwards={fastForwardMenuItems}
										onPlay={handlePlay}
										onPause={handlePause}
										onNext={handleNextPlay}
										paused={paused}
										titlePlay="Resume Simulation"
										titlePause="Pause Simulation"
										titleNext="Show Next Play"
										// Since we have two PlayPauseNexts rendered, ignore shortcuts on one
										ignoreKeyboardShortcuts
									/>
									<input
										type="range"
										className="form-range flex-grow-1"
										min="1"
										max="33"
										step="1"
										value={speed}
										onChange={handleSpeedChange}
										title="Speed"
									/>
								</div>
							</div>
							<div className="d-flex d-md-none">
								<div className="ms-auto btn-group">
									<button
										className="btn btn-light-bordered"
										onClick={() => {
											scrollTop.current?.scrollIntoView();
										}}
									>
										Top
									</button>
									{!isSport("football") ? (
										<>
											<button
												className="btn btn-light-bordered"
												onClick={() => {
													document
														.getElementById("scroll-team-1")
														?.scrollIntoView();
												}}
											>
												{boxScore.current.teams[0].abbrev}
											</button>
											<button
												className="btn btn-light-bordered"
												onClick={() => {
													document
														.getElementById("scroll-team-2")
														?.scrollIntoView();
												}}
											>
												{boxScore.current.teams[1].abbrev}
											</button>
										</>
									) : null}
									<button
										className="btn btn-light-bordered"
										onClick={() => {
											playByPlayDiv.current?.scrollIntoView();
										}}
									>
										Plays
									</button>
								</div>
							</div>
						</div>
					) : null}
					{boxScore.current.gid >= 0 && isSport("basketball") ? (
						<SimcastPanel />
					) : null}
					{boxScore.current.gid >= 0 &&
					isSport("basketball") &&
					!boxScore.current.exhibition ? (
						<CoachPanel
							boxScore={boxScore.current}
							onApply={applyCoaching}
							onOpenPause={handlePause}
							paused={paused}
						/>
					) : null}
					{boxScore.current.gid >= 0 ? (
						<BoxScoreWrapper
							Row={PlayerRow}
							boxScore={boxScore.current}
							live
							playIndex={playIndex}
							sportState={sportState.current}
						/>
					) : (
						<h2>Loading...</h2>
					)}
				</div>
				<div className="col-md-3">
					<div className="live-game-affix">
						<div className="d-none d-md-flex align-items-center mb-3 pt-md-2">
							<PlayPauseNext
								className="me-2"
								disabled={boxScore.current.gameOver}
								fastForwardAlignRight
								fastForwards={fastForwardMenuItems}
								onPlay={handlePlay}
								onPause={handlePause}
								onNext={handleNextPlay}
								paused={paused}
								titlePlay="Resume Simulation"
								titlePause="Pause Simulation"
								titleNext="Show Next Play"
							/>
							<input
								type="range"
								className="form-range flex-grow-1"
								min="1"
								max="33"
								step="1"
								value={speed}
								onChange={handleSpeedChange}
								title="Speed"
							/>
						</div>
						<PlayByPlay
							boxScore={boxScore.current}
							entries={playByPlayEntries.current}
							playByPlayDivRef={playByPlayDiv}
						/>
					</div>
				</div>
			</div>
		</div>
	);
};

const LiveGameWrapper = (props: View<"liveGame">) => {
	useTitleBar({ title: "Live Game Simulation", hideNewWindow: true });

	return <LiveGame {...props} />;
};

export default LiveGameWrapper;
