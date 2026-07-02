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

const MODEL = "claude-opus-4-8";
const MAX_BUDGET_USD = 20;
const MAX_TURNS = 300;

// The GM is a personal, tailnet-only tool on a single-user box that already runs
// Claude with full permissions (the command-center engine). It needs native
// bash/jq/Read/Write to query league.json and maintain its memory file, so it
// runs with --dangerously-skip-permissions like the other local sessions. NOT
// exposed to the public internet (tailscale serve, not funnel).
const TURN_TIMEOUT_MS = 20 * 60 * 1000; // 20m hard cap per turn
// Reset the conversation after this many turns so context can't grow unbounded
// (we have no /compact loop here, unlike the command-center engine).
const MAX_SESSION_TURNS = 40;
const MAX_CRASH_RETRIES = 2;

// Per-syncId FIFO queue: two near-simultaneous sends for the same league must
// not spawn parallel `claude` invocations, or the second's --resume races the
// first's session-persist and fails with "No conversation found".
const queues = new Map();

const runOnce = (syncId, message, cwd) =>
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

		const args = [
			"-p",
			...resumeArgs,
			"--model",
			MODEL,
			"--output-format",
			"json",
			"--max-budget-usd",
			String(MAX_BUDGET_USD),
			"--max-turns",
			String(MAX_TURNS),
			"--dangerously-skip-permissions",
		];

		const env = { ...process.env };
		delete env.ANTHROPIC_API_KEY;
		env.PATH = [NODE_BIN_DIR, env.PATH].filter(Boolean).join(":");

		const child = spawn(CLAUDE_BIN, args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

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
			stdout += c.toString();
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
			if (code !== 0) {
				const tag =
					code === null ? `killed by ${signal || "signal"}` : `exited ${code}`;
				const err = new Error(
					`claude ${tag}: ${stderr.slice(0, 600) || stdout.slice(0, 300) || "(no output)"}`,
				);
				err.exitCode = code;
				err.signal = signal;
				return reject(err);
			}
			let parsed;
			try {
				parsed = JSON.parse(stdout);
			} catch (e) {
				return reject(
					new Error(`parse error: ${e.message}; head: ${stdout.slice(0, 400)}`),
				);
			}
			touchGmSession(syncId);
			resolve({
				result: parsed.result || "",
				session_id: parsed.session_id || session.session_id,
				cost_usd: parsed.total_cost_usd || 0,
				is_error: parsed.is_error === true,
				isNew,
			});
		});
	});

const runWithRetries = async (syncId, message, cwd) => {
	let lastError = null;
	for (let attempt = 0; attempt <= MAX_CRASH_RETRIES; attempt++) {
		try {
			return await runOnce(syncId, message, cwd);
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

// Public: run a GM turn, serialized per league.
export const runTurn = (syncId, message, cwd) => {
	const key = String(syncId);
	const prev = queues.get(key) || Promise.resolve();
	const next = prev
		.catch(() => {})
		.then(() => runWithRetries(syncId, message, cwd));
	queues.set(
		key,
		next.catch(() => {}),
	);
	return next;
};

export const resetSession = (syncId) => deleteGmSession(syncId);
