// Radio broadcast — Phase 3: TTS audio rendering.
//
// The heavy lifting is a Python script running in a local venv — Chatterbox
// (voice-cloned, torch-ROCm on the GPU) by default, or Kokoro (torch-free ONNX,
// CPU) as a baseline. See ENGINES below. This module is the Node-side engine: it
// spawns the renderer, tracks progress via a small progress file the script
// rewrites per utterance, and exposes the output paths (stitched mp3 + timing
// manifest) the server serves to the in-app player.
//
// Output layout (data/server/broadcast-audio/):
//   <gid>.mp3            stitched two-voice broadcast
//   <gid>.wav            same, lossless (kept as the encode source)
//   <gid>.manifest.json  { durationSec, segments:[{startSec,endSec,scoreStart,
//                          scoreEnd,endsPeriod,...}] } — drives spoiler-safe reveal
//
// Mirrors the shape of broadcast-script.js (saveX/getX/hasX + a runner).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const AUDIO_DIR = path.join(
	__dirname,
	"..",
	"data",
	"server",
	"broadcast-audio",
);
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Cache dir for short one-off clips (the AGM speak button), keyed by content
// hash so re-playing the same message is instant.
export const AGM_TTS_DIR = path.join(
	__dirname,
	"..",
	"data",
	"server",
	"agm-tts",
);
fs.mkdirSync(AGM_TTS_DIR, { recursive: true });

const TTS_DIR = path.join(__dirname, "tts");
const VOICES_FILE = path.join(TTS_DIR, "voices.json");
const SYNTH_SCRIPT = path.join(TTS_DIR, "chatterbox_synth.py");

// Two rendering engines, selectable via BBGM_TTS_ENGINE:
//   chatterbox — voice-cloned Breen/Clyde (expressive), torch-ROCm on the RX 6800.
//   kokoro     — fast/offline ONNX baseline (flat prosody), CPU.
// Each has its own venv; Chatterbox needs the gfx1030 override to see the GPU.
const ENGINES = {
	chatterbox: {
		python: path.join(TTS_DIR, "venv-chatterbox", "bin", "python"),
		script: path.join(TTS_DIR, "chatterbox_tts.py"),
		env: { HSA_OVERRIDE_GFX_VERSION: "10.3.0" },
	},
	kokoro: {
		python: path.join(TTS_DIR, "venv", "bin", "python"),
		script: path.join(TTS_DIR, "kokoro_tts.py"),
		env: {},
	},
};
const DEFAULT_ENGINE = process.env.BBGM_TTS_ENGINE ?? "chatterbox";

// TTS is off. Sustained Chatterbox renders took the RX 6800 off the PCIe bus
// twice on 2026-07-09 (`ring gfx_0.1.0 timeout` → reset -ENODEV → `device lost
// from bus`), each time wedging the desktop until a hard reboot. The card cannot
// be recovered in software once that happens. Re-enable with BBGM_TTS=1 only
// after the drop-off is understood — note that renderText() below is hardwired
// to the GPU engine, so switching BBGM_TTS_ENGINE to kokoro does NOT make this
// safe on its own.
export const TTS_ENABLED = process.env.BBGM_TTS === "1";
const ttsDisabled = () =>
	Promise.reject(
		new Error("TTS disabled (GPU fault 2026-07-09); set BBGM_TTS=1"),
	);

const safeGid = (gid) => String(gid).replace(/[^\w.-]/g, "_");

export const manifestFile = (gid) =>
	path.join(AUDIO_DIR, `${safeGid(gid)}.manifest.json`);
export const audioFile = (gid, ext = "mp3") =>
	path.join(AUDIO_DIR, `${safeGid(gid)}.${ext}`);

export function hasAudio(gid) {
	return fs.existsSync(manifestFile(gid));
}

export function getManifest(gid) {
	try {
		return JSON.parse(fs.readFileSync(manifestFile(gid), "utf8"));
	} catch {
		return null;
	}
}

// Resolve the playable audio path (mp3 preferred, wav fallback) for a game.
export function resolveAudioPath(gid) {
	const manifest = getManifest(gid);
	if (manifest?.audio) {
		const p = path.join(AUDIO_DIR, manifest.audio);
		if (fs.existsSync(p)) return p;
	}
	for (const ext of ["mp3", "wav"]) {
		const p = audioFile(gid, ext);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

// Chunking config. This card's ROCm compute wedges under a long sustained job,
// so Chatterbox renders in short batches (fresh process each = fresh GPU context
// freed on exit). A per-chunk timeout catches a mid-batch hang; retries re-run a
// fresh process (which resets the GPU); per-utterance wavs make it resumable.
const CHUNK_SIZE = Number(process.env.BBGM_TTS_CHUNK ?? 40);
const CHUNK_TIMEOUT_MS = Number(
	process.env.BBGM_TTS_CHUNK_TIMEOUT_MS ?? 8 * 60 * 1000,
);
const ASSEMBLE_TIMEOUT_MS = 6 * 60 * 1000;
const CHUNK_RETRIES = 2;

// Spawn one renderer step (argv after the script path). Kills + rejects on
// timeout so a wedged GPU can't hang the whole render.
function spawnStep(engine, argv, { timeoutMs } = {}) {
	return new Promise((resolve, reject) => {
		if (!fs.existsSync(engine.python)) {
			return reject(new Error(`TTS python venv missing: ${engine.python}`));
		}
		const child = spawn(engine.python, [engine.script, ...argv], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...engine.env },
		});
		let stderr = "";
		let timedOut = false;
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.stdout.on("data", (d) => process.stdout.write(`[tts] ${d}`));
		const timer = timeoutMs
			? setTimeout(() => {
					timedOut = true;
					try {
						child.kill("SIGKILL");
					} catch {}
				}, timeoutMs)
			: null;
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (timedOut)
				return reject(new Error(`step timed out after ${timeoutMs}ms`));
			if (code === 0) resolve({ code });
			else
				reject(new Error(`step exited ${code}: ${stderr.trim().slice(-400)}`));
		});
	});
}

function countUtterances(scriptPath) {
	const s = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
	return (s.segments ?? []).reduce(
		(n, seg) => n + (seg.utterances?.length ?? 0),
		0,
	);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ollama shares the RX 6800's 16 GiB and runs with OLLAMA_KEEP_ALIVE=-1, so
// models it has loaded stay resident indefinitely (GM chat answers fast). Two
// resident models leave well under a GiB free — not enough for Chatterbox's
// torch-ROCm context, and the allocation wedges the card's compute rather than
// failing cleanly. Evict before a long render; Ollama reloads on its next call.
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

async function evictOllamaModels() {
	if (process.env.BBGM_TTS_EVICT_OLLAMA === "0") return;
	try {
		const res = await fetch(`${OLLAMA_HOST}/api/ps`, {
			signal: AbortSignal.timeout(5000),
		});
		const { models = [] } = await res.json();
		for (const m of models) {
			const name = m.model ?? m.name;
			console.log(`[broadcast-audio] evicting ollama model ${name}`);
			await fetch(`${OLLAMA_HOST}/api/generate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: name, keep_alive: 0 }),
				signal: AbortSignal.timeout(30000),
			});
		}
		if (models.length) await sleep(2000); // let the driver reclaim the VRAM
	} catch (err) {
		// Best effort — a busy or absent Ollama must never block a render.
		console.error(`[broadcast-audio] ollama evict skipped: ${err.message}`);
	}
}

// Chunked, resumable Chatterbox render: emit per-utterance wavs in batches
// (retrying a batch on GPU hang), then assemble (no GPU) into the final file.
async function renderChunked(
	gid,
	scriptPath,
	engine,
	progressPath,
	onProgress,
) {
	const emitDir = path.join(AUDIO_DIR, `${safeGid(gid)}.utts`);
	fs.mkdirSync(emitDir, { recursive: true });
	const total = countUtterances(scriptPath);

	const poll = setInterval(() => {
		try {
			const p = JSON.parse(fs.readFileSync(progressPath, "utf8"));
			onProgress({ done: p.done ?? 0, total: p.total ?? total });
		} catch {}
	}, 1000);

	try {
		await evictOllamaModels();
		for (let start = 0; start < total; start += CHUNK_SIZE) {
			let ok = false;
			let lastErr;
			for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
				try {
					await spawnStep(
						engine,
						[
							"--script",
							scriptPath,
							"--emit-dir",
							emitDir,
							"--start",
							String(start),
							"--count",
							String(CHUNK_SIZE),
							"--progress-file",
							progressPath,
						],
						{ timeoutMs: CHUNK_TIMEOUT_MS },
					);
					ok = true;
					break;
				} catch (err) {
					lastErr = err;
					console.error(
						`[broadcast-audio] gid=${gid} chunk@${start} attempt ${attempt + 1}/${CHUNK_RETRIES + 1}: ${err.message}`,
					);
					// A wedge is most often VRAM starvation — reclaim before retrying.
					await evictOllamaModels();
					await sleep(4000); // let the GPU settle before a fresh process
				}
			}
			if (!ok) {
				throw new Error(
					`chunk@${start} failed after retries: ${lastErr?.message}`,
				);
			}
		}
		// Assemble is pure audio work — no GPU, always safe.
		await spawnStep(
			engine,
			[
				"--script",
				scriptPath,
				"--assemble",
				"--emit-dir",
				emitDir,
				"--out-dir",
				AUDIO_DIR,
				"--gid",
				String(gid),
				"--progress-file",
				progressPath,
			],
			{ timeoutMs: ASSEMBLE_TIMEOUT_MS },
		);
	} finally {
		clearInterval(poll);
	}
	// Success → drop the per-utterance scratch wavs.
	try {
		fs.rmSync(emitDir, { recursive: true, force: true });
	} catch {}
	return { ok: true };
}

/**
 * Render a game's script to audio. Chatterbox renders in resilient chunks;
 * Kokoro (CPU, no hang risk) runs as a single pass. `onProgress({done,total})`
 * fires as utterances render (from the renderer's progress file).
 * @returns {Promise<{ok:boolean}>}
 */
export function renderAudio(gid, scriptPath, opts = {}) {
	if (!TTS_ENABLED) return ttsDisabled();
	const onProgress = opts.onProgress ?? (() => {});
	const engineName = opts.engine ?? DEFAULT_ENGINE;
	const engine = ENGINES[engineName] ?? ENGINES.chatterbox;
	const progressPath = path.join(
		os.tmpdir(),
		`bbgm-tts-${safeGid(gid)}.progress.json`,
	);
	try {
		fs.rmSync(progressPath, { force: true });
	} catch {}

	if (engineName === "chatterbox") {
		return renderChunked(gid, scriptPath, engine, progressPath, onProgress);
	}

	// Kokoro: single pass (CPU, no GPU-hang risk).
	const poll = setInterval(() => {
		try {
			const { done, total } = JSON.parse(fs.readFileSync(progressPath, "utf8"));
			onProgress({ done, total });
		} catch {}
	}, 1000);
	return spawnStep(
		engine,
		[
			"--script",
			scriptPath,
			"--out-dir",
			AUDIO_DIR,
			"--gid",
			String(gid),
			"--progress-file",
			progressPath,
		],
		{ timeoutMs: 30 * 60 * 1000 },
	)
		.then(() => ({ ok: true }))
		.finally(() => clearInterval(poll));
}

// ── One-off text → speech (the AGM speak button) ────────────────────────────

function loadVoices() {
	const cfg = JSON.parse(fs.readFileSync(VOICES_FILE, "utf8"));
	for (const v of Object.values(cfg.voices)) {
		if (v.ref && !path.isAbs(v.ref)) v.ref = path.join(TTS_DIR, v.ref);
	}
	return cfg.voices;
}

// Content-hash path for a one-off clip. Split out from renderText so callers can
// answer "is this already rendered?" without touching the GPU — a cache hit must
// stay serveable even while a broadcast render owns the card.
function textCacheKey(text, voiceKey) {
	const voices = loadVoices();
	const vcfg = voices[voiceKey] ?? voices.pbp ?? Object.values(voices)[0];
	const clean = String(text ?? "").trim();
	if (!clean) return null;
	const key = crypto
		.createHash("sha1")
		.update(`${voiceKey}|${JSON.stringify(vcfg)}|${clean}`)
		.digest("hex")
		.slice(0, 16);
	return { vcfg, clean, outNoExt: path.join(AGM_TTS_DIR, key) };
}

/** @returns {string|null} path to an already-rendered clip, or null. */
export function cachedTextPath(text, voiceKey = "pbp") {
	const k = textCacheKey(text, voiceKey);
	if (!k) return null;
	const mp3 = `${k.outNoExt}.mp3`;
	return fs.existsSync(mp3) ? mp3 : null;
}

/**
 * Render arbitrary text to speech in a cloned voice (default Breen). Cached by
 * content hash so replaying the same message is instant. Spawns the Chatterbox
 * synth per request (model load ~10s cold) — fine for a click-to-listen button;
 * a warm worker is a future speed upgrade.
 *
 * This puts a second process on the GPU, so callers must not invoke it while a
 * broadcast render is active (see gpu-queue.js).
 * @returns {Promise<string>} absolute path to the mp3
 */
export function renderText(text, voiceKey = "pbp") {
	const k = textCacheKey(text, voiceKey);
	if (!k) return Promise.reject(new Error("empty text"));
	const { vcfg, clean, outNoExt } = k;
	const mp3 = `${outNoExt}.mp3`;
	// Already-rendered clips are just files on disk, so keep serving those.
	// Only block work that would spawn a new ROCm process.
	if (fs.existsSync(mp3)) return Promise.resolve(mp3);
	if (!TTS_ENABLED) return ttsDisabled();

	const engine = ENGINES.chatterbox;
	const spec = {
		voices: { [voiceKey]: vcfg },
		utterances: [{ voice: voiceKey, text: clean }],
		leadIn: 0.15,
		tail: 0.25,
	};
	const specPath = `${outNoExt}.spec.json`;
	fs.writeFileSync(specPath, JSON.stringify(spec));

	return new Promise((resolve, reject) => {
		if (!fs.existsSync(engine.python)) {
			return reject(new Error(`TTS venv missing: ${engine.python}`));
		}
		const child = spawn(
			engine.python,
			[SYNTH_SCRIPT, "--lines", specPath, "--out", outNoExt, "--mp3"],
			{
				stdio: ["ignore", "ignore", "pipe"],
				env: { ...process.env, ...engine.env },
			},
		);
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			try {
				fs.rmSync(specPath, { force: true });
			} catch {}
			if (code === 0 && fs.existsSync(mp3)) resolve(mp3);
			else
				reject(new Error(`tts exited ${code}: ${stderr.trim().slice(-300)}`));
		});
	});
}
