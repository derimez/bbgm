// claude-llm.js — the BBGM server's only LLM path.
//
// Replaces the local Ollama calls (qwen3:8b) retired with the Mac mini
// migration on 2026-09-05. Shells out to the Claude CLI under the
// Max-subscription OAuth login, matching the pattern in
// command-center/scripts/heartbeat.js.

import { spawn } from "node:child_process";

const CLAUDE_BIN =
	process.env.CLAUDE_BIN ?? "/Users/derin/.nvm/versions/node/v24.14.1/bin/claude";

// Tier names mirror MODEL_MAP in command-center/scripts/claude-session.js.
export const MODELS = {
	haiku: "claude-haiku-4-5-20251001",
	sonnet: "claude-sonnet-5",
	opus: "claude-opus-5",
};

/**
 * One-shot `claude -p`. Resolves with the assistant text; rejects on non-zero
 * exit, empty output, or timeout — callers decide whether that is fatal.
 *
 * @param {string} prompt
 * @param {{model?: string, timeoutMs?: number, budgetUsd?: number, system?: string}} opts
 * @returns {Promise<string>}
 */
export function claudeText(prompt, opts = {}) {
	const {
		model = "haiku",
		timeoutMs = 60_000,
		budgetUsd = 0.1,
		system,
	} = opts;

	return new Promise((resolve, reject) => {
		const env = { ...process.env };
		delete env.ANTHROPIC_API_KEY; // force Max-sub OAuth, never metered API billing
		// An inherited value hijacks transcript handling when this runs from
		// inside another Claude session (2026-08-20 amnesia bug).
		delete env.CLAUDE_CODE_CHILD_SESSION;

		const args = [
			"-p",
			"--model", MODELS[model] ?? model,
			"--output-format", "text",
			"--max-budget-usd", String(budgetUsd),
			// Pure text generation — a stray tool call burns the turn budget.
			"--tools", "",
			"--max-turns", "4",
		];
		if (system) args.push("--append-system-prompt", system);

		const child = spawn(CLAUDE_BIN, args, {
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			env,
		});

		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`claude timeout after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on("data", (c) => { out += c.toString(); });
		child.stderr.on("data", (c) => { err += c.toString(); });
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
			const text = out.trim();
			if (!text) return reject(new Error("claude returned empty output"));
			resolve(text);
		});

		child.stdin.write(prompt);
		child.stdin.end();
	});
}
