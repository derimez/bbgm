import { useEffect, useRef, useState } from "react";
import { Modal } from "../Modal.tsx";
import { toWorker } from "../../util/toWorker.ts";
import { pushNow } from "../../util/bbgmSync.ts";

type Attachment = { name: string; dataUrl: string; isImage: boolean };
type Msg = { role: "user" | "gm"; text: string; atts?: Attachment[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const POLL_INTERVAL_MS = 2500;
const POLL_MAX = 500; // ~21 min, matches the server turn cap
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

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
): Promise<string> => {
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

	for (let i = 0; i < POLL_MAX; i++) {
		await sleep(POLL_INTERVAL_MS);
		const r = await fetch(`/api/gm/chat/result/${turnId}`);
		const j = await r.json().catch(() => ({}));
		if (j.status === "done") return j.reply as string;
		if (j.status === "error") throw new Error(j.error || "GM chat failed");
	}
	throw new Error("The GM took too long to respond — please try again.");
};

// One attachment preview: image thumbnail or a labeled file chip.
const AttachmentPreview = ({ att, size }: { att: Attachment; size: number }) =>
	att.isImage ? (
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
			📄 {att.name}
		</span>
	);

const AssistantGM = () => {
	const [open, setOpen] = useState(false);
	const [messages, setMessages] = useState<Msg[]>([]);
	const [input, setInput] = useState("");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [busy, setBusy] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [unread, setUnread] = useState(false);
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
	}, [messages, busy, open, attachments]);

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
		if ((!text && attachments.length === 0) || busy) return;

		const sending = attachments;
		setMessages((m) => [...m, { role: "user", text, atts: sending }]);
		setInput("");
		setAttachments([]);
		setBusy(true);

		try {
			const { syncId, pushErr } = await syncAndGetId();
			if (!syncId) {
				throw new Error(
					pushErr
						? `Couldn't sync this league (${pushErr}).`
						: "This league has no sync id yet — tap Sync once, then try again.",
				);
			}
			const reply = await askGM(syncId, text, sending);
			setMessages((m) => [...m, { role: "gm", text: reply }]);
			if (!openRef.current) setUnread(true);
		} catch (err) {
			setMessages((m) => [
				...m,
				{ role: "gm", text: `⚠️ ${(err as Error).message}` },
			]);
			if (!openRef.current) setUnread(true);
		} finally {
			setBusy(false);
		}
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	const canSend = !busy && (input.trim() !== "" || attachments.length > 0);

	return (
		<>
			{/* Pulse/glow animation for an unread GM reply */}
			<style>{`
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
			`}</style>

			{/* Floating action button */}
			<button
				type="button"
				className={`btn btn-primary rounded-circle shadow d-flex align-items-center justify-content-center${
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

			<Modal show={open} onHide={() => setOpen(false)} scrollable>
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
					className={dragOver ? "bg-body-tertiary" : undefined}
				>
					<div
						ref={bodyRef}
						style={{ maxHeight: "55vh", overflowY: "auto" }}
						className="d-flex flex-column gap-2"
					>
						{messages.length === 0 ? (
							<p className="text-body-secondary mb-1">
								Ask me anything about your league — roster, trades, the
								standings, who to start. Paste or drop a screenshot or a doc (a
								trade offer, a player card, an updated .md note) and I'll read
								it against your live data.
							</p>
						) : null}
						{messages.map((m, i) => (
							<div
								key={i}
								className={
									m.role === "user"
										? "align-self-end bg-primary text-white rounded px-3 py-2"
										: "align-self-start bg-body-secondary rounded px-3 py-2"
								}
								style={{ maxWidth: "85%", whiteSpace: "pre-wrap" }}
							>
								{m.atts && m.atts.length > 0 ? (
									<div className="d-flex flex-wrap gap-1 mb-1">
										{m.atts.map((a, j) => (
											<AttachmentPreview key={j} att={a} size={140} />
										))}
									</div>
								) : null}
								{m.text}
							</div>
						))}
						{busy ? (
							<div className="align-self-start text-body-secondary px-3 py-2">
								<span className="spinner-border spinner-border-sm me-2" />
								Thinking…
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
							disabled={busy || attachments.length >= MAX_ATTACHMENTS}
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
							disabled={busy}
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
		</>
	);
};

export default AssistantGM;
