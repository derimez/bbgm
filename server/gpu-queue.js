// Global GPU work queue with a hardware circuit breaker.
//
// Everything in the broadcast pipeline that touches the RX 6800 — Chatterbox TTS
// rendering and Ollama script generation — has to go through here. The card has
// 16 GiB and one command processor: two concurrent ROCm streams don't run twice
// as fast, they time-slice the same silicon and multiply the load on the SDMA
// rings. On 2026-07-09 a long sustained render wedged the card hard enough that
// the driver could not reset it (`ring sdma0 timeout` → `Ring sdma0 reset failed`
// → `device lost from bus`, GPU reset returning -ENODEV), and only a reboot
// recovered it. So: one GPU job at a time, a cooldown between them, and a
// breaker that stops feeding work to a card that has started to fault.
//
// Recovery from a true bus loss needs a reboot — no amount of retrying helps.
// The breaker exists to make sure we notice that once, instead of twelve times.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const MAX_DEPTH = Number(process.env.BBGM_GPU_QUEUE_MAX ?? 20);
const COOLDOWN_MS = Number(process.env.BBGM_GPU_COOLDOWN_MS ?? 60_000);
// Consecutive job failures with a *healthy* GPU before we stop. A single hard
// GPU fault trips immediately regardless of this.
const FAILURE_THRESHOLD = Number(process.env.BBGM_GPU_FAILURE_THRESHOLD ?? 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── GPU health ──────────────────────────────────────────────────────────────

// Resolve the amdgpu card once. When the device drops off the PCIe bus these
// sysfs reads start failing with -ENODEV, which is our cheapest liveness probe.
function findVramNode() {
	for (const card of ["card0", "card1", "card2"]) {
		const p = `/sys/class/drm/${card}/device/mem_info_vram_used`;
		try {
			fs.readFileSync(p, "utf8");
			return p;
		} catch {}
	}
	return null;
}
const VRAM_NODE = findVramNode();

export function gpuHealthy() {
	if (!VRAM_NODE) return true; // no sysfs to read — don't block on a probe we can't do
	try {
		fs.readFileSync(VRAM_NODE, "utf8");
		return true;
	} catch {
		return false;
	}
}

// Scan the kernel ring buffer for the specific amdgpu faults that precede a
// wedge. Best-effort: if journalctl isn't readable we just say "no faults" and
// fall back to the sysfs probe.
function gpuFaultsSince(sinceIso) {
	try {
		const out = execFileSync(
			"journalctl",
			["-k", "-b", "0", "--since", sinceIso, "--no-pager"],
			{ encoding: "utf8", timeout: 5000 },
		);
		// `qcm fence wait loop timeout` is the earliest symptom — it preceded the
		// reset storm by several seconds in the 2026-07-09 wedge. The rest are the
		// escalation: preemption fails, KFD won't quiesce, reset fails, bus drops.
		return /device lost from bus|GPU reset|ring \w+ timeout|reset failed|Failed to quiesce KFD|fence wait loop timeout/i.test(
			out,
		);
	} catch {
		return false;
	}
}

// ── Breaker + queue state ───────────────────────────────────────────────────

const breaker = { open: false, reason: null, trippedAt: null };
let consecutiveFailures = 0;

let pending = [];
let active = null;
let draining = false;

export class QueueFullError extends Error {}
export class BreakerOpenError extends Error {}

function trip(reason) {
	breaker.open = true;
	breaker.reason = reason;
	breaker.trippedAt = Date.now();
	console.error(`[gpu-queue] CIRCUIT BREAKER OPEN — ${reason}`);
	console.error("[gpu-queue] halting all GPU work; a bus loss needs a reboot");
}

function blockPending(reason) {
	const blocked = pending;
	pending = [];
	for (const item of blocked) {
		try {
			item.onBlocked?.(reason);
		} catch {}
	}
	if (blocked.length) {
		console.error(`[gpu-queue] blocked ${blocked.length} queued job(s)`);
	}
}

export function queueState() {
	return {
		breaker: { ...breaker },
		gpuHealthy: gpuHealthy(),
		active: active ? { kind: active.kind, gid: active.gid } : null,
		pending: pending.map((i) => ({ kind: i.kind, gid: i.gid })),
		depth: pending.length + (active ? 1 : 0),
		maxDepth: MAX_DEPTH,
		cooldownMs: COOLDOWN_MS,
		consecutiveFailures,
	};
}

// Manual reset — call after a reboot, or once you've confirmed the card is back.
export function resetBreaker() {
	const was = { ...breaker };
	breaker.open = false;
	breaker.reason = null;
	breaker.trippedAt = null;
	consecutiveFailures = 0;
	console.log("[gpu-queue] breaker reset");
	return was;
}

// ── Drain loop ──────────────────────────────────────────────────────────────

async function drain() {
	if (draining) return;
	draining = true;
	try {
		while (pending.length) {
			if (breaker.open) {
				blockPending(breaker.reason);
				break;
			}
			if (!gpuHealthy()) {
				trip("GPU sysfs unreadable — device may be off the bus");
				blockPending(breaker.reason);
				break;
			}

			const item = pending.shift();
			active = item;
			const startedIso = new Date().toISOString();
			let failed = false;

			try {
				console.log(`[gpu-queue] start ${item.kind} gid=${item.gid}`);
				await item.run();
				consecutiveFailures = 0;
				console.log(`[gpu-queue] done ${item.kind} gid=${item.gid}`);
			} catch (err) {
				failed = true;
				console.error(
					`[gpu-queue] fail ${item.kind} gid=${item.gid}: ${err.message}`,
				);
			} finally {
				active = null;
			}

			if (failed) {
				// A job can fail for boring reasons (bad script, missing venv). Only
				// treat it as a hardware fault if the GPU actually looks sick.
				const hardFault = !gpuHealthy() || gpuFaultsSince(startedIso);
				if (hardFault) {
					trip(`GPU fault during ${item.kind} gid=${item.gid}`);
					blockPending(breaker.reason);
					break;
				}
				consecutiveFailures++;
				if (consecutiveFailures >= FAILURE_THRESHOLD) {
					trip(`${consecutiveFailures} consecutive job failures`);
					blockPending(breaker.reason);
					break;
				}
			}

			// Let the card idle before the next sustained burst.
			if (pending.length && COOLDOWN_MS > 0) {
				console.log(`[gpu-queue] cooldown ${COOLDOWN_MS}ms`);
				await sleep(COOLDOWN_MS);
			}
		}
	} finally {
		draining = false;
	}
}

/**
 * Submit GPU work. `run` must throw on failure so the breaker can see it.
 * `onBlocked(reason)` fires if the breaker trips while this job is still queued.
 * @returns {{position:number}} 0 = running next (or now)
 */
export function enqueue({ kind, gid, run, onBlocked }) {
	if (breaker.open) {
		throw new BreakerOpenError(breaker.reason ?? "GPU circuit breaker is open");
	}
	const key = `${kind}:${gid}`;
	if (active && `${active.kind}:${active.gid}` === key) return { position: 0 };
	const at = pending.findIndex((i) => `${i.kind}:${i.gid}` === key);
	if (at >= 0) return { position: at + (active ? 1 : 0) };

	if (pending.length >= MAX_DEPTH) {
		throw new QueueFullError(`GPU queue is full (${MAX_DEPTH} waiting)`);
	}
	pending.push({ kind, gid, run, onBlocked });
	const position = pending.length - 1 + (active ? 1 : 0);
	drain(); // fire-and-forget; drain() is re-entrant-safe
	return { position };
}
