// Assistant GM session runner.
//
// One persistent Claude Code CLI session per league (keyed by the stable
// syncId). Each turn resumes the prior conversation so the GM keeps context,
// and runs with cwd set to the league's working dir so it reads league.json
// and writes GM-MEMORY.md with relative paths.
//
// This deliberately mirrors the proven spawn recipe in
// command-center/scripts/claude-session.js (model pin, --resume, json output,
// budget/turn caps, ANTHROPIC_API_KEY stripped, explicit PATH) but is
// self-contained in the bbgm repo so the shared command-center engine is
// untouched. Sessions live in the bbgm leagues.db (gm_sessions table).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	getGmSession,
	createGmSession,
	touchGmSession,
	deleteGmSession,
} from "./db.js";

const CLAUDE_BIN =
	process.env.GM_CLAUDE_BIN ||
	"/home/derin/.nvm/versions/node/v24.14.1/bin/claude";
const NODE_BIN_DIR = "/home/derin/.nvm/versions/node/v24.14.1/bin";

// Two tiers: Opus for decisions/analysis, Sonnet for quick factual lookups.
// Every turn spawns a full Claude session that reads the (multi-MB) league
// export through a tool loop, so the model tier is the dominant latency lever —
// routing simple questions to Sonnet cuts most replies from ~30-60s to seconds.
const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-5";

// Signals that a question is a decision/analysis ask worth Opus. Kept broad and
// biased toward escalation: when a lookup is misread as heavy we only lose a
// little speed, but downgrading a real strategy question would cost answer
// quality — so we default-escalate on any doubt below.
const HEAVY_INTENT =
	/\b(trade|trading|sign(ing)?|waive|cut|draft(ing)?|lineup|rotation|start(er|ing)?|bench|rebuild|contend(er|ing)?|contention|strateg(y|ic)|plan|approach|philosophy|should\s+(we|i|you)|worth\s+it|evaluat|assess|analy[sz]e|compare|recommend|advi[cs]e|target|shop(ping)?|extension|extend|re-?sign|deadline|off-?season|free.?agen|depth\s*chart|minutes|develop|prospect|upgrade|weakness|improve|prioriti|deep\s*dive|think\s+hard|thoughts?\s+on|what\s+do\s+you\s+think|game\s*plan|matchup|adjust)/i;

// Pick the model for a turn from the user's message. Attachments (image/file
// analysis) and any heavy-intent or long, multi-part question get Opus;
// everything else — records, stats, "who is X", simple lookups — gets Sonnet.
const pickModel = (message) => {
	const text = String(message || "");
	if (/\[The user attached a file/.test(text)) return OPUS;
	if (HEAVY_INTENT.test(text)) return OPUS;
	if (text.length > 600) return OPUS; // long asks skew multi-part/strategic
	return SONNET;
};

const MAX_BUDGET_USD = 20;
const MAX_TURNS = 300;

// Advisory-only sandbox. The GM is a personal, tailnet-only tool, but it must
// stay in its lane: read the league export + maintain its own memory docs, and
// nothing else. It runs default-deny (an explicit allow-list; anything not
// listed is auto-blocked headless without hanging) instead of the old
// --dangerously-skip-permissions, which once let it wander out of ~/bbgm-gm/,
// edit repo source, and offer to restart the server. Writes are path-scoped to
// the workdir (cwd); the read toolkit is jq + the usual text utilities; service
// control / networking / code execution / repo edits are denied outright.
// Verified headless: allowed ops run, denied ops fail cleanly (no prompt hang).
const GM_ALLOWED_TOOLS = [
	"Read",
	"Glob",
	"Grep",
	"Write(./**)", // GM-MEMORY.md and the living docs — workdir only
	"Edit(./**)",
	// Read-only query toolkit over league.json / boxscores.json.
	"Bash(jq:*)",
	"Bash(cat:*)",
	"Bash(ls:*)",
	"Bash(head:*)",
	"Bash(tail:*)",
	"Bash(grep:*)",
	"Bash(egrep:*)",
	"Bash(wc:*)",
	"Bash(sort:*)",
	"Bash(uniq:*)",
	"Bash(cut:*)",
	"Bash(tr:*)",
	"Bash(awk:*)",
	"Bash(sed:*)",
	"Bash(find:*)",
	"Bash(echo:*)",
	"Bash(printf:*)",
	"Bash(date:*)",
	"Bash(bc:*)",
	"Bash(column:*)",
	"Bash(basename:*)",
	"Bash(dirname:*)",
	"Bash(realpath:*)",
	"Bash(pwd:*)",
	"Bash(stat:*)",
	"Bash(diff:*)",
	"Bash(seq:*)",
	"Bash(test:*)",
	"Bash(true:*)",
];
// Belt-and-suspenders: with a default-deny allow-list these are already blocked,
// but naming the escape hatches (nested shells / interpreters) and the
// destructive/service/network verbs explicitly guards compound-command edges and
// documents intent. This is what a "restart the server" attempt hits now.
const GM_DENIED_TOOLS = [
	"Bash(bash:*)",
	"Bash(sh:*)",
	"Bash(zsh:*)",
	"Bash(env:*)",
	"Bash(xargs:*)",
	"Bash(eval:*)",
	"Bash(node:*)",
	"Bash(python:*)",
	"Bash(python3:*)",
	"Bash(npm:*)",
	"Bash(npx:*)",
	"Bash(pnpm:*)",
	"Bash(yarn:*)",
	"Bash(pm2:*)",
	"Bash(systemctl:*)",
	"Bash(service:*)",
	"Bash(git:*)",
	"Bash(docker:*)",
	"Bash(rm:*)",
	"Bash(rmdir:*)",
	"Bash(mv:*)",
	"Bash(dd:*)",
	"Bash(chmod:*)",
	"Bash(chown:*)",
	"Bash(kill:*)",
	"Bash(pkill:*)",
	"Bash(killall:*)",
	"Bash(sudo:*)",
	"Bash(reboot:*)",
	"Bash(shutdown:*)",
	"Bash(curl:*)",
	"Bash(wget:*)",
	"Bash(ssh:*)",
	"Bash(scp:*)",
	"Bash(nc:*)",
	"Bash(tee:*)",
	"WebFetch",
	"WebSearch",
];

const TURN_TIMEOUT_MS = 20 * 60 * 1000; // 20m hard cap per turn
// Reset the conversation after this many turns so context can't grow unbounded
// (we have no /compact loop here, unlike the command-center engine).
const MAX_SESSION_TURNS = 40;
const MAX_CRASH_RETRIES = 2;

// Per-syncId FIFO queue: two near-simultaneous sends for the same league must
// not spawn parallel `claude` invocations, or the second's --resume races the
// first's session-persist and fails with "No conversation found".
const queues = new Map();

// Condense a tool_use input into a one-line label for the activity timeline
// (e.g. the file being read, the command being run) — mirrors the compact tool
// lines the Claude app shows as it steps through a task.
const toolSummary = (input) => {
	if (!input || typeof input !== "object") return "";
	const pick =
		input.file_path ||
		input.path ||
		input.command ||
		input.pattern ||
		input.url ||
		input.query ||
		input.description ||
		input.prompt;
	const s =
		typeof pick === "string"
			? pick
			: (() => {
					try {
						return JSON.stringify(input);
					} catch {
						return "";
					}
				})();
	return s.length > 140 ? `${s.slice(0, 140)}…` : s;
};

const runOnce = (syncId, message, cwd, onEvent) =>
	new Promise((resolve, reject) => {
		let session = getGmSession(syncId);

		// Bound context by recycling the session after a while.
		if (session && session.turns >= MAX_SESSION_TURNS) {
			deleteGmSession(syncId);
			session = undefined;
		}

		const isNew = !session;
		if (isNew) {
			session = createGmSession(syncId, randomUUID());
		}

		const resumeArgs = isNew
			? ["--session-id", session.session_id]
			: ["--resume", session.session_id];

		// stream-json (NDJSON) instead of a single final blob so we can surface the
		// GM's thinking + tool steps live as they land, the way the Claude app does.
		// --verbose is required by the CLI to emit the per-step events.
		const model = pickModel(message);
		console.log(
			`[gm-session] syncId=${String(syncId).slice(0, 8)} model=${model} len=${String(message || "").length}`,
		);

		const args = [
			"-p",
			...resumeArgs,
			"--model",
			model,
			"--output-format",
			"stream-json",
			"--verbose",
			"--max-budget-usd",
			String(MAX_BUDGET_USD),
			"--max-turns",
			String(MAX_TURNS),
			// Advisory-only sandbox (see GM_ALLOWED_TOOLS above): default-deny with a
			// workdir-scoped write allow-list, replacing the old blanket
			// --dangerously-skip-permissions. --disallowedTools must come last so the
			// variadic --allowedTools stops collecting at the right boundary.
			"--allowedTools",
			...GM_ALLOWED_TOOLS,
			"--disallowedTools",
			...GM_DENIED_TOOLS,
		];

		const env = { ...process.env };
		delete env.ANTHROPIC_API_KEY;
		env.PATH = [NODE_BIN_DIR, env.PATH].filter(Boolean).join(":");

		const child = spawn(CLAUDE_BIN, args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// NDJSON line buffer + accumulated final answer. The final `result` event
		// carries the answer string; interim `assistant` events carry thinking,
		// tool_use and narration blocks which we forward to onEvent as steps.
		let lineBuf = "";
		let finalResult = "";
		let resultSessionId = session.session_id;
		let costUsd = 0;
		let isError = false;
		let stderr = "";

		const emit = (ev) => {
			try {
				onEvent?.(ev);
			} catch {
				// A misbehaving listener must never break the turn.
			}
		};

		const handleLine = (line) => {
			let j;
			try {
				j = JSON.parse(line);
			} catch {
				return; // partial/non-JSON line — ignore
			}
			if (j.type === "system") {
				if (j.session_id) resultSessionId = j.session_id;
				return;
			}
			if (j.type === "assistant" && Array.isArray(j.message?.content)) {
				for (const b of j.message.content) {
					if (b.type === "thinking" && b.thinking) {
						emit({ kind: "thinking", text: b.thinking });
					} else if (b.type === "text" && b.text) {
						emit({ kind: "text", text: b.text });
					} else if (b.type === "tool_use") {
						emit({
							kind: "tool",
							name: b.name || "tool",
							summary: toolSummary(b.input),
						});
					}
				}
				return;
			}
			if (j.type === "result") {
				if (typeof j.result === "string") finalResult = j.result;
				if (j.session_id) resultSessionId = j.session_id;
				costUsd = j.total_cost_usd || 0;
				isError = j.is_error === true;
			}
		};

		const timeout = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			// A wedged --resume target poisons every future turn; drop it so the
			// next message starts fresh.
			try {
				deleteGmSession(syncId);
			} catch {}
			const err = new Error("[gm-session] turn timeout");
			err.timedOut = true;
			reject(err);
		}, TURN_TIMEOUT_MS);

		child.stdin.write(message);
		child.stdin.end();

		child.stdout.on("data", (c) => {
			lineBuf += c.toString();
			let idx;
			while ((idx = lineBuf.indexOf("\n")) >= 0) {
				const line = lineBuf.slice(0, idx).trim();
				lineBuf = lineBuf.slice(idx + 1);
				if (line) handleLine(line);
			}
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString();
		});

		child.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			// Flush any trailing line that arrived without a newline.
			const tail = lineBuf.trim();
			if (tail) handleLine(tail);
			if (code !== 0) {
				const tag =
					code === null ? `killed by ${signal || "signal"}` : `exited ${code}`;
				const err = new Error(
					`claude ${tag}: ${stderr.slice(0, 600) || finalResult.slice(0, 300) || "(no output)"}`,
				);
				err.exitCode = code;
				err.signal = signal;
				return reject(err);
			}
			touchGmSession(syncId);
			resolve({
				result: finalResult || "",
				session_id: resultSessionId || session.session_id,
				cost_usd: costUsd,
				is_error: isError,
				isNew,
			});
		});
	});

const runWithRetries = async (syncId, message, cwd, onEvent) => {
	let lastError = null;
	for (let attempt = 0; attempt <= MAX_CRASH_RETRIES; attempt++) {
		try {
			return await runOnce(syncId, message, cwd, onEvent);
		} catch (err) {
			lastError = err;
			// Stale session id (crash mid-turn / never persisted) → fresh retry.
			if (
				err.exitCode === 1 &&
				/No conversation found/i.test(err.message || "") &&
				attempt < MAX_CRASH_RETRIES
			) {
				deleteGmSession(syncId);
				await new Promise((r) => setTimeout(r, 100));
				continue;
			}
			const isCrash =
				err.exitCode === null ||
				(typeof err.exitCode === "number" && err.exitCode > 128);
			if (!isCrash || attempt >= MAX_CRASH_RETRIES) throw err;
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
	throw lastError;
};

// Public: run a GM turn, serialized per league. `onEvent(step)` fires for each
// interim thinking / tool_use / narration block as it streams in.
export const runTurn = (syncId, message, cwd, onEvent) => {
	const key = String(syncId);
	const prev = queues.get(key) || Promise.resolve();
	const next = prev
		.catch(() => {})
		.then(() => runWithRetries(syncId, message, cwd, onEvent));
	queues.set(
		key,
		next.catch(() => {}),
	);
	return next;
};

export const resetSession = (syncId) => deleteGmSession(syncId);
