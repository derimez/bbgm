import { useEffect, useRef, useState } from "react";
import { Modal } from "../Modal.tsx";
import { toWorker } from "../../util/toWorker.ts";
import { pushNow } from "../../util/bbgmSync.ts";
import { renderMarkdown } from "./markdown.ts";

type Attachment = { name: string; dataUrl: string; isImage: boolean };
// One entry in the GM's live activity timeline (mirrors the Claude app's
// thinking + tool-step display). Sent by the server as the turn streams.
type Step =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; summary: string };
type Msg = {
	// "system" is a thin, centered divider the client inserts itself (e.g. a
	// "new session" notice) — never sent to the model.
	role: "user" | "gm" | "system";
	text: string;
	atts?: Attachment[];
	steps?: Step[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll a touch faster than before so the streamed thinking/tool steps feel live.
const POLL_INTERVAL_MS = 1200;
const POLL_MAX = 1100; // ~22 min, matches the server turn cap
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Persist the transcript across app closes/reloads until the user types /clear.
// Keyed PER LEAGUE by syncId — a single global key let one league's (or a stale
// dev) conversation bleed into another's window, and made the visible bubbles
// outlive the backend session they belonged to. Transcript now travels with the
// same identity as the GM's Claude session, so they can't show mismatched leagues.
const TRANSCRIPT_PREFIX = "bbgm-agm-transcript";
const transcriptKey = (syncId: string) => `${TRANSCRIPT_PREFIX}:${syncId}`;
// The old single-key store, wiped once on mount so its cross-league mixture
// never renders again.
const LEGACY_TRANSCRIPT_KEY = "bbgm-agm-transcript";
const UNREAD_KEY = "bbgm-agm-unread";

const loadTranscript = (syncId: string | null): Msg[] => {
	if (!syncId) return [];
	try {
		const raw = localStorage.getItem(transcriptKey(syncId));
		const parsed = raw ? JSON.parse(raw) : null;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
};

// Store the transcript, but strip attachment dataUrls first — a few base64
// images would blow the ~5MB localStorage quota. On reload they render as file
// chips instead of thumbnails.
const saveTranscript = (syncId: string | null, messages: Msg[]) => {
	if (!syncId) return; // never persist under an unknown league
	try {
		// Also trim step text — a tool-heavy turn's thinking blocks can be large,
		// and the persisted thought process only needs to be a readable summary.
		const slimSteps = (steps?: Step[]) =>
			steps?.map((s) =>
				s.kind === "tool"
					? s
					: {
							...s,
							text: s.text.length > 1200 ? `${s.text.slice(0, 1200)}…` : s.text,
						},
			);
		const slim = messages.map((m) => {
			const next: Msg = { ...m };
			if (m.atts && m.atts.length) {
				next.atts = m.atts.map((a) => ({
					name: a.name,
					isImage: a.isImage,
					dataUrl: "",
				}));
			}
			if (m.steps && m.steps.length) next.steps = slimSteps(m.steps);
			return next;
		});
		localStorage.setItem(transcriptKey(syncId), JSON.stringify(slim));
	} catch {
		// Quota exceeded or serialization failure — keep the in-memory chat going.
	}
};

// Text docs the GM can read (markdown notes, exports, etc.) alongside images.
const TEXT_EXT = ["md", "markdown", "txt", "json", "csv", "log"];
const FILE_ACCEPT = `image/*,${TEXT_EXT.map((e) => `.${e}`).join(",")}`;
const isAllowedFile = (f: File): boolean => {
	if (f.type.startsWith("image/")) return true;
	const ext = f.name.split(".").pop()?.toLowerCase();
	return !!ext && TEXT_EXT.includes(ext);
};

const fileToDataUrl = (file: File): Promise<string> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new Error("Could not read file"));
		reader.readAsDataURL(file);
	});

// Resolve a syncId for the chat. Prefer the result of a fresh push (so the
// server has current data); fall back to reading it if the push couldn't run.
const syncAndGetId = async (): Promise<{
	syncId?: string;
	pushErr?: string;
}> => {
	const push = await pushNow();
	if (push.ok && push.syncId) {
		return { syncId: push.syncId };
	}
	const info = await toWorker("main", "bbgmSyncInfo", true);
	return { syncId: info.syncId, pushErr: push.ok ? undefined : push.error };
};

const askGM = async (
	syncId: string,
	prompt: string,
	attachments: Attachment[],
	onProgress: (steps: Step[]) => void,
): Promise<{ reply: string; steps: Step[]; isNew: boolean }> => {
	const res = await fetch("/api/gm/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ syncId, prompt, attachments }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(body.error || `HTTP ${res.status}`);
	}
	const { turnId } = body;

	let latest: Step[] = [];
	// The server registers the turn before returning turnId, so `unknown` means
	// the turn was lost — a server restart or crash mid-flight dropped it from the
	// in-memory map. Without this, the UI polls a ghost turn until POLL_MAX (~22m).
	// A small tolerance guards against a one-off blip before we give up.
	let unknownStreak = 0;
	for (let i = 0; i < POLL_MAX; i++) {
		await sleep(POLL_INTERVAL_MS);
		const r = await fetch(`/api/gm/chat/result/${turnId}`);
		const j = await r.json().catch(() => ({}));
		if (Array.isArray(j.steps)) {
			latest = j.steps as Step[];
			onProgress(latest);
		}
		if (j.status === "done")
			return {
				reply: j.reply as string,
				steps: latest,
				isNew: j.isNew === true,
			};
		if (j.status === "error") throw new Error(j.error || "GM chat failed");
		if (j.status === "unknown") {
			if (++unknownStreak >= 2) {
				throw new Error(
					"The GM session was interrupted — please try asking again.",
				);
			}
		} else {
			unknownStreak = 0;
		}
	}
	throw new Error("The GM took too long to respond — please try again.");
};

// Short label for the spinner based on what the GM is doing right now.
const activityLabel = (steps: Step[]): string => {
	const last = steps[steps.length - 1];
	if (!last) return "Thinking…";
	if (last.kind === "tool") return `Using ${last.name}…`;
	if (last.kind === "thinking") return "Thinking…";
	return "Writing…";
};

// One attachment preview: image thumbnail or a labeled file chip.
const AttachmentPreview = ({ att, size }: { att: Attachment; size: number }) =>
	att.isImage && att.dataUrl ? (
		<img
			src={att.dataUrl}
			alt={att.name}
			style={{
				width: size,
				height: size,
				objectFit: "cover",
				borderRadius: 4,
			}}
		/>
	) : (
		<span className="badge text-bg-light border" title={att.name}>
			{att.isImage ? "🖼️" : "📄"} {att.name}
		</span>
	);

// One line in the activity timeline: a tool-use chip, or a thinking/narration
// block (thinking is dimmed + italic, like the Claude app's thought stream).
const StepView = ({ s }: { s: Step }) => {
	if (s.kind === "tool") {
		return (
			<div className="small text-body-secondary my-1 d-flex align-items-baseline gap-1">
				<span className="badge text-bg-light border flex-shrink-0">
					🔧 {s.name}
				</span>
				{s.summary ? (
					<code style={{ overflowWrap: "anywhere" }}>{s.summary}</code>
				) : null}
			</div>
		);
	}
	const thinking = s.kind === "thinking";
	return (
		<div
			className="small my-1"
			style={{
				whiteSpace: "pre-wrap",
				overflowWrap: "anywhere",
				color: thinking ? "var(--bs-secondary-color)" : undefined,
				fontStyle: thinking ? "italic" : undefined,
			}}
		>
			{thinking ? "💭 " : ""}
			{s.text}
		</div>
	);
};

const StepList = ({ steps }: { steps: Step[] }) => (
	<>
		{steps.map((s, i) => (
			<StepView key={i} s={s} />
		))}
	</>
);

// Speak a GM reply aloud in Mike Breen's cloned voice via /api/tts. First click
// on a given message renders (server caches by text), later clicks replay
// instantly. Click again while playing to stop.
const SpeakButton = ({ text }: { text: string }) => {
	const [status, setStatus] = useState<"idle" | "loading" | "playing">("idle");
	const audioRef = useRef<HTMLAudioElement | null>(null);

	useEffect(
		() => () => {
			audioRef.current?.pause();
			if (audioRef.current?.src) URL.revokeObjectURL(audioRef.current.src);
		},
		[],
	);

	const onClick = async () => {
		if (status === "playing") {
			audioRef.current?.pause();
			setStatus("idle");
			return;
		}
		setStatus("loading");
		try {
			const resp = await fetch("/api/tts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, voice: "pbp" }),
			});
			if (!resp.ok) throw new Error(`tts ${resp.status}`);
			const blob = await resp.blob();
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			audioRef.current = audio;
			audio.onended = () => setStatus("idle");
			audio.onpause = () => setStatus((s) => (s === "playing" ? "idle" : s));
			await audio.play();
			setStatus("playing");
		} catch (err) {
			console.error("speak failed", err);
			setStatus("idle");
		}
	};

	return (
		<button
			type="button"
			className="btn btn-sm btn-link p-0 text-body-secondary text-decoration-none"
			title="Play in Mike Breen's voice"
			onClick={onClick}
			disabled={status === "loading"}
		>
			{status === "loading" ? (
				<span
					className="spinner-border spinner-border-sm"
					style={{ width: "0.8rem", height: "0.8rem" }}
				/>
			) : status === "playing" ? (
				"⏸ Stop"
			) : (
				"🔊 Breen"
			)}
		</button>
	);
};

const AssistantGM = () => {
	const [open, setOpen] = useState(false);
	// The league this transcript belongs to. Resolved on mount (and refreshed on
	// each send); the transcript is loaded/saved under it so leagues never share
	// a thread. Null until known — we render empty rather than guess.
	const [syncId, setSyncId] = useState<string | null>(null);
	const [messages, setMessages] = useState<Msg[]>([]);
	const [input, setInput] = useState("");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	// Number of replies currently in flight. The server serializes turns per
	// league (FIFO), so the user can fire off follow-ups without waiting.
	const [pending, setPending] = useState(0);
	// Live thinking/tool timeline for the in-flight turn (cleared once it lands).
	const [liveSteps, setLiveSteps] = useState<Step[]>([]);
	// When set, the GM reply shown full-screen for easy table/markdown reading.
	const [expanded, setExpanded] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const [unread, setUnread] = useState(() => {
		try {
			return localStorage.getItem(UNREAD_KEY) === "1";
		} catch {
			return false;
		}
	});
	const bodyRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// Read the live `open` value inside the long-running send() closure so a
	// reply that lands after the modal is closed can flag itself unread.
	const openRef = useRef(open);
	openRef.current = open;

	useEffect(() => {
		if (bodyRef.current) {
			bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
		}
	}, [messages, pending, open, attachments, liveSteps]);

	// Esc closes the full-screen reader.
	useEffect(() => {
		if (expanded === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setExpanded(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [expanded]);

	// Resolve which league we're in (once on mount) and drop the legacy global
	// transcript so its cross-league mixture can't render. A read-only sync info
	// lookup — no push, so opening the modal is cheap.
	useEffect(() => {
		try {
			localStorage.removeItem(LEGACY_TRANSCRIPT_KEY);
		} catch {
			// ignore
		}
		let cancelled = false;
		void (async () => {
			try {
				const info = await toWorker("main", "bbgmSyncInfo", true);
				if (!cancelled && info?.syncId) setSyncId(info.syncId);
			} catch {
				// No league open / worker unavailable — stays null, transcript empty.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Load this league's saved transcript whenever the active league changes
	// (mount-resolve, or a restore/switch that mints a new syncId while open).
	useEffect(() => {
		if (!syncId) return;
		setMessages(loadTranscript(syncId));
	}, [syncId]);

	// Persist the transcript + unread flag so both survive an app close/reload.
	// Keyed by the active league; skipped until syncId is known so we never
	// clobber a league's stored thread with the empty mount state.
	useEffect(() => {
		saveTranscript(syncId, messages);
	}, [syncId, messages]);
	useEffect(() => {
		try {
			localStorage.setItem(UNREAD_KEY, unread ? "1" : "0");
		} catch {
			// ignore — pulse just won't survive a reload
		}
	}, [unread]);

	// Auto-grow the input with its content (like the Claude app): shrink to fit,
	// grow per line, cap at MAX and scroll beyond. minHeight (CSS) holds the
	// 3-row floor when empty.
	const TEXTAREA_MAX_PX = 200;
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_PX)}px`;
	}, [input, open]);

	// Pull allowed files (images + text docs) out of a paste / drop / pick.
	const addFiles = async (files: File[]) => {
		const allowed = files.filter(
			(f) => isAllowedFile(f) && f.size <= MAX_ATTACHMENT_BYTES,
		);
		if (allowed.length === 0) return;
		const items = await Promise.all(
			allowed.map(async (f) => ({
				name: f.name || "attachment",
				dataUrl: await fileToDataUrl(f),
				isImage: f.type.startsWith("image/"),
			})),
		);
		setAttachments((prev) => [...prev, ...items].slice(0, MAX_ATTACHMENTS));
	};

	const onPaste = (e: React.ClipboardEvent) => {
		const files = Array.from(e.clipboardData.files || []);
		// Only intercept when actual files are on the clipboard; plain text paste
		// should still land in the textarea.
		if (files.length > 0 && files.some(isAllowedFile)) {
			e.preventDefault();
			void addFiles(files);
		}
	};

	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setDragOver(false);
		void addFiles(Array.from(e.dataTransfer.files || []));
	};

	const removeAttachment = (i: number) => {
		setAttachments((prev) => prev.filter((_, idx) => idx !== i));
	};

	const send = async () => {
		const text = input.trim();
		if (!text && attachments.length === 0) return;

		// Explicit wipe — clears the persisted transcript, like /clear in a chat.
		// Also reset the server-side GM session so the next turn starts a fresh
		// Claude conversation (re-reads CLAUDE.md/SCHEMA.md, sheds stale framing)
		// rather than --resume-ing the one we just visually cleared.
		if (text === "/clear") {
			setMessages([]);
			setAttachments([]);
			setInput("");
			setUnread(false);
			try {
				if (syncId) localStorage.removeItem(transcriptKey(syncId));
			} catch {
				// ignore
			}
			void (async () => {
				try {
					const { syncId } = await syncAndGetId();
					if (syncId) {
						await fetch("/api/gm/reset", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ syncId }),
						});
					}
				} catch {
					// Best-effort — the transcript is already cleared locally.
				}
			})();
			return;
		}

		// Was there a visible thread before this turn? Drives the "new session"
		// divider below — only meaningful if there's prior context to have lost.
		const hadHistory = messages.length > 0;
		const sending = attachments;
		setMessages((m) => [...m, { role: "user", text, atts: sending }]);
		setInput("");
		setAttachments([]);
		setPending((n) => n + 1);
		setLiveSteps([]);

		try {
			const { syncId: resolvedSyncId, pushErr } = await syncAndGetId();
			if (!resolvedSyncId) {
				throw new Error(
					pushErr
						? `Couldn't sync this league (${pushErr}).`
						: "This league has no sync id yet — tap Sync once, then try again.",
				);
			}
			// Keep the transcript bound to the live league: a restore can mint a new
			// syncId mid-session, and this rebinds save/load to the right one.
			const leagueChanged = resolvedSyncId !== syncId;
			if (leagueChanged) setSyncId(resolvedSyncId);
			const { reply, steps, isNew } = await askGM(
				resolvedSyncId,
				text,
				sending,
				setLiveSteps,
			);
			setMessages((m) => [
				...m,
				// The GM's Claude session was rebuilt (reset / timeout / server
				// restart) and can't see anything above. Surface it instead of
				// letting the full-looking transcript imply memory it doesn't have.
				// Skip on a league switch, where a fresh session is expected.
				...(isNew && hadHistory && !leagueChanged
					? [
							{
								role: "system",
								text: "New session — the GM lost the thread above (its saved memory is intact)",
							} as Msg,
						]
					: []),
				{ role: "gm", text: reply, steps },
			]);
			if (!openRef.current) setUnread(true);
		} catch (err) {
			setMessages((m) => [
				...m,
				{ role: "gm", text: `⚠️ ${(err as Error).message}` },
			]);
			if (!openRef.current) setUnread(true);
		} finally {
			setPending((n) => Math.max(0, n - 1));
			setLiveSteps([]);
		}
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	const canSend = input.trim() !== "" || attachments.length > 0;

	return (
		<>
			{/* Pulse/glow animation for an unread GM reply.
			    NB: the resting shadow lives here (not Bootstrap's `.shadow`, which
			    is `!important` and would out-cascade the keyframe box-shadow). */}
			<style>{`
				.gm-fab { box-shadow: 0 .5rem 1rem rgba(0, 0, 0, 0.15); }
				@keyframes gmFabPulse {
					0%   { box-shadow: 0 0 0 0 rgba(13, 110, 253, 0.7); }
					70%  { box-shadow: 0 0 0 16px rgba(13, 110, 253, 0); }
					100% { box-shadow: 0 0 0 0 rgba(13, 110, 253, 0); }
				}
				.gm-fab-unread {
					animation: gmFabPulse 1.6s ease-out infinite;
				}
				@media (prefers-reduced-motion: reduce) {
					.gm-fab-unread { animation: none; box-shadow: 0 0 0 4px rgba(13, 110, 253, 0.5); }
				}
				.gm-thought > summary { cursor: pointer; list-style-position: outside; }
				.gm-thought[open] > summary { margin-bottom: .25rem; }
				/* Keep rendered-markdown bubbles tight and self-contained. */
				.gm-markdown { line-height: 1.5; }
				.gm-markdown > :last-child { margin-bottom: 0 !important; }
				.gm-markdown pre { white-space: pre-wrap; overflow-x: auto; }
				.gm-markdown code { overflow-wrap: anywhere; }
				.gm-markdown a { overflow-wrap: anywhere; }
				.gm-markdown h1, .gm-markdown h2, .gm-markdown h3 { line-height: 1.3; }
				/* Pretty tables: horizontally scrollable, zebra rows, clear header. */
				.gm-table-wrap {
					overflow-x: auto;
					margin: .5rem 0;
					border: 1px solid var(--bs-border-color);
					border-radius: .375rem;
				}
				.gm-markdown table.gm-table {
					width: 100%;
					margin: 0;
					border-collapse: collapse;
					font-size: .875rem;
					white-space: nowrap;
				}
				.gm-table th, .gm-table td {
					padding: .375rem .625rem;
					border-bottom: 1px solid var(--bs-border-color);
					vertical-align: top;
				}
				.gm-table thead th {
					background: var(--bs-tertiary-bg);
					font-weight: 600;
					position: sticky;
					top: 0;
				}
				/* Zebra tint that adapts to light/dark on its own (ZenGM swaps whole
				   CSS bundles rather than toggling data-bs-theme, so we key off the
				   theme's own text colour instead of a fixed rgba). */
				.gm-table tbody tr:nth-of-type(odd) {
					background: color-mix(in srgb, var(--bs-body-color) 5%, transparent);
				}
				.gm-table tbody tr:last-child td { border-bottom: 0; }

				/* Full-screen reader overlay for a single GM reply. */
				.gm-fs-overlay {
					position: fixed;
					inset: 0;
					z-index: 2000;
					background: rgba(0,0,0,.55);
					display: flex;
					align-items: stretch;
					justify-content: center;
					padding: env(safe-area-inset-top, 0) 0 0;
				}
				.gm-fs-panel {
					background: var(--bs-body-bg);
					color: var(--bs-body-color);
					width: min(900px, 100%);
					max-height: 100%;
					display: flex;
					flex-direction: column;
					overflow: hidden;
					box-shadow: 0 0 2rem rgba(0,0,0,.4);
				}
				@media (min-width: 576px) {
					.gm-fs-overlay { padding: 2.5vh 1rem; }
					.gm-fs-panel { border-radius: .5rem; max-height: 95vh; }
				}
				.gm-fs-head {
					display: flex;
					align-items: center;
					justify-content: space-between;
					padding: .75rem 1rem;
					border-bottom: 1px solid var(--bs-border-color);
					flex: 0 0 auto;
				}
				.gm-markdown-lg {
					padding: 1rem 1.25rem calc(1rem + env(safe-area-inset-bottom, 0));
					overflow-y: auto;
					font-size: 1.05rem;
					line-height: 1.6;
				}
				/* In the roomy reader let tables wrap/breathe instead of scroll. */
				.gm-markdown-lg table.gm-table { font-size: .95rem; white-space: normal; }
			`}</style>

			{/* Floating action button */}
			<button
				type="button"
				className={`btn btn-primary rounded-circle gm-fab d-flex align-items-center justify-content-center${
					unread ? " gm-fab-unread" : ""
				}`}
				title={unread ? "Assistant GM — new reply" : "Assistant GM"}
				aria-label={unread ? "Assistant GM, new reply" : "Assistant GM"}
				onClick={() => {
					setUnread(false);
					setOpen(true);
				}}
				style={{
					position: "fixed",
					right: 16,
					bottom: 16,
					width: 56,
					height: 56,
					fontSize: 24,
					lineHeight: 1,
					zIndex: 1030,
				}}
			>
				🏀
			</button>

			<Modal
				show={open}
				onHide={() => setOpen(false)}
				size="lg"
				fullscreen="md-down"
			>
				<Modal.Header closeButton>
					<Modal.Title>Assistant GM</Modal.Title>
				</Modal.Header>
				<Modal.Body
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={onDrop}
					className={`d-flex flex-column${dragOver ? " bg-body-tertiary" : ""}`}
				>
					<div
						ref={bodyRef}
						style={{
							flex: 1,
							minHeight: 0,
							maxHeight: "85vh",
							overflowY: "auto",
						}}
						className="d-flex flex-column gap-2"
					>
						{messages.length === 0 ? (
							<p className="text-body-secondary mb-1">
								Ask me anything about your league — roster, trades, the
								standings, who to start. Paste or drop a screenshot or a doc (a
								trade offer, a player card, an updated .md note) and I'll read
								it against your live data. Your conversation is saved until you
								send <code>/clear</code>.
							</p>
						) : null}
						{messages.map((m, i) =>
							m.role === "system" ? (
								<div
									key={i}
									className="align-self-center text-body-secondary small my-1 text-center"
									style={{ maxWidth: "90%", opacity: 0.85 }}
								>
									— {m.text} —
								</div>
							) : (
								<div
									key={i}
									className={
										m.role === "user"
											? "align-self-end bg-primary text-white rounded px-3 py-2"
											: "align-self-start bg-body-secondary rounded px-3 py-2"
									}
									style={{
										maxWidth: "85%",
										// GM replies are rendered HTML (block elements handle their
										// own wrapping); user text keeps literal newlines.
										whiteSpace: m.role === "user" ? "pre-wrap" : undefined,
										overflowWrap: "anywhere",
									}}
								>
									{m.atts && m.atts.length > 0 ? (
										<div className="d-flex flex-wrap gap-1 mb-1">
											{m.atts.map((a, j) => (
												<AttachmentPreview key={j} att={a} size={140} />
											))}
										</div>
									) : null}
									{m.role === "gm" ? (
										<>
											{(() => {
												// Collapsible record of how the GM got here. Drop the final
												// text block (it's the answer shown below, not a "step").
												const thought = (m.steps || []).filter(
													(s) =>
														!(
															s.kind === "text" &&
															s.text.trim() === m.text.trim()
														),
												);
												return thought.length > 0 ? (
													<details className="gm-thought mb-2">
														<summary className="small text-body-secondary">
															Thought process ({thought.length})
														</summary>
														<div className="mt-1">
															<StepList steps={thought} />
														</div>
													</details>
												) : null;
											})()}
											<div
												className="gm-markdown"
												// Safe: renderMarkdown escapes input and DOMPurify-sanitizes.
												dangerouslySetInnerHTML={{
													__html: renderMarkdown(m.text),
												}}
											/>
											<div className="d-flex justify-content-end align-items-center gap-3 mt-1">
												<SpeakButton text={m.text} />
												{/* Full-screen reader for anything with a table or enough
											    text that it's awkward inside the bubble. */}
												{/\|.*\|/.test(m.text) || m.text.length > 240 ? (
													<button
														type="button"
														className="btn btn-sm btn-link p-0 text-body-secondary text-decoration-none"
														title="Open full screen"
														onClick={() => setExpanded(m.text)}
													>
														⤢ Full screen
													</button>
												) : null}
											</div>
										</>
									) : (
										m.text
									)}
								</div>
							),
						)}
						{pending > 0 ? (
							<div
								className="align-self-start bg-body-secondary rounded px-3 py-2"
								style={{ maxWidth: "85%" }}
							>
								{liveSteps.length > 0 ? <StepList steps={liveSteps} /> : null}
								<div className="text-body-secondary d-flex align-items-center mt-1">
									<span className="spinner-border spinner-border-sm me-2" />
									{activityLabel(liveSteps)}
									{pending > 1 ? ` (${pending})` : ""}
								</div>
							</div>
						) : null}
					</div>
				</Modal.Body>
				<Modal.Footer className="d-block">
					{/* Staged attachments awaiting send */}
					{attachments.length > 0 ? (
						<div className="d-flex flex-wrap gap-2 mb-2 align-items-center">
							{attachments.map((a, i) => (
								<div key={i} className="position-relative d-inline-flex">
									<AttachmentPreview att={a} size={56} />
									<button
										type="button"
										className="btn btn-sm btn-dark rounded-circle p-0 position-absolute top-0 end-0"
										style={{ width: 18, height: 18, lineHeight: "16px" }}
										title="Remove"
										onClick={() => removeAttachment(i)}
									>
										×
									</button>
								</div>
							))}
						</div>
					) : null}

					<div className="d-flex w-100 gap-2">
						<input
							ref={fileInputRef}
							type="file"
							accept={FILE_ACCEPT}
							multiple
							className="d-none"
							onChange={(e) => {
								void addFiles(Array.from(e.target.files || []));
								e.target.value = "";
							}}
						/>
						<button
							type="button"
							className="btn btn-light-bordered"
							title="Attach image or file"
							disabled={attachments.length >= MAX_ATTACHMENTS}
							onClick={() => fileInputRef.current?.click()}
						>
							📎
						</button>
						<textarea
							ref={textareaRef}
							className="form-control"
							rows={3}
							placeholder="Ask the GM…"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={onKeyDown}
							onPaste={onPaste}
							style={{
								resize: "none",
								// 16px avoids iOS auto-zoom on focus
								fontSize: 16,
								lineHeight: 1.4,
								minHeight: 76, // ~3 rows
								maxHeight: TEXTAREA_MAX_PX,
								overflowY: "auto",
							}}
						/>
						<button
							type="button"
							className="btn btn-primary"
							onClick={send}
							disabled={!canSend}
						>
							Send
						</button>
					</div>
				</Modal.Footer>
			</Modal>

			{/* Full-screen reader — renders one GM reply large and roomy so wide
			    tables and long breakdowns are easy to read. Its own fixed overlay
			    (not a nested modal) so it reliably stacks above the chat. */}
			{expanded !== null ? (
				<div
					className="gm-fs-overlay"
					role="dialog"
					aria-modal="true"
					onClick={() => setExpanded(null)}
				>
					<div className="gm-fs-panel" onClick={(e) => e.stopPropagation()}>
						<div className="gm-fs-head">
							<span className="fw-bold">Assistant GM</span>
							<button
								type="button"
								className="btn btn-sm btn-light-bordered"
								title="Close (Esc)"
								onClick={() => setExpanded(null)}
							>
								✕ Close
							</button>
						</div>
						<div
							className="gm-markdown gm-markdown-lg"
							// Safe: renderMarkdown escapes input and DOMPurify-sanitizes.
							dangerouslySetInnerHTML={{ __html: renderMarkdown(expanded) }}
						/>
					</div>
				</div>
			) : null}
		</>
	);
};

export default AssistantGM;
