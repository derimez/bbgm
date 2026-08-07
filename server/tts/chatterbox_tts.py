#!/usr/bin/env python3
"""Radio broadcast — Phase 3 (Chatterbox engine): full-game renderer.

Same output contract as kokoro_tts.py (<gid>.wav/.mp3/.manifest.json with the
same per-segment schema), but voice-cloned Breen/Clyde on the RX 6800.

⚠️ This card's ROCm compute WEDGES under a ~40-min sustained job. So the render is
CHUNKED: Node spawns this script once per batch of utterances (a fresh process =
a fresh GPU context that's freed on exit), so no single process runs long enough
to hang the GPU. Three modes:

  --emit-dir D [--start N --count M]   render utterances [N,N+M) → D/u<idx>.wav
                                       (skips ones already on disk → resumable)
  --assemble --emit-dir D --out-dir O  stitch all u*.wav + gaps → final wav/mp3/
                                       manifest (NO GPU — pure audio, always safe)
  (neither)                            legacy single-shot full render (CPU/small)

Voices (clip + emotion) come from voices.json; big Breen calls are hype-boosted.
"""
import argparse
import json
import os
import re
import subprocess
import sys

import numpy as np

# NOTE: cb_core (which imports torch) is imported LAZILY inside the GPU modes
# (emit/full) only. The assemble mode must stay torch-free so it never touches
# the GPU — it has to work even when the GPU is wedged (it's the finalize step).

HERE = os.path.dirname(os.path.abspath(__file__))

GAP_UTTERANCE = 0.28
GAP_SEGMENT = 0.55
GAP_PERIOD = 1.30
LEAD_IN = 0.40
TAIL = 0.80

# Big-moment cues → bump Breen's exaggeration so highlights pop above routine
# possessions ("more enthusiasm at times"). ~4% of lines match on a real game.
HYPE_RE = re.compile(
    r"\bBANG\b|\b(dunk|slam|poster|buzzer[- ]beater|and[- ]one|from downtown|"
    r"for three|deep three|step[- ]back three|alley[- ]oop|dagger|ballgame|"
    r"oh my|are you kidding|count it|puts it away|ties it up|takes the lead)\b",
    re.IGNORECASE,
)


def write_progress(path, done, total):
    if not path:
        return
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"done": done, "total": total}, f)
    os.replace(tmp, path)


def load_voices(path):
    with open(path) as f:
        cfg = json.load(f)
    for v in cfg.get("voices", {}).values():
        if v.get("ref") and not os.path.isabs(v["ref"]):
            v["ref"] = os.path.join(HERE, v["ref"])
    return cfg["voices"]


def save_wav_mp3(audio, sr, out_no_ext, mp3_kbps=96):
    """Torch-free save (soundfile + ffmpeg) for the assemble path."""
    import soundfile as sf

    wav_path = f"{out_no_ext}.wav"
    sf.write(wav_path, audio, sr)
    mp3_path = f"{out_no_ext}.mp3"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path,
             "-codec:a", "libmp3lame", "-b:a", f"{mp3_kbps}k", mp3_path],
            check=True,
        )
        return mp3_path
    except Exception as e:  # noqa: BLE001
        print(f"[chatterbox] mp3 encode skipped: {e}", file=sys.stderr)
        return wav_path


def hype_exaggeration(text, vcfg):
    base = float(vcfg.get("exaggeration", 0.5))
    if HYPE_RE.search(text or ""):
        return min(base + float(vcfg.get("hypeBoost", 0.0)),
                   float(vcfg.get("hypeMax", 0.95)))
    return None


def build_flat(segments, voices):
    """Flatten segments → per-utterance list (deterministic, so emit and assemble
    agree on indices/params). Each item: {voice,text,gapAfter,exaggeration?}."""
    flat, seg_of, n_hype = [], [], 0
    for si, seg in enumerate(segments):
        utts = seg.get("utterances", [])
        for ui, u in enumerate(utts):
            gap = GAP_UTTERANCE
            if ui == len(utts) - 1:
                gap = GAP_PERIOD if seg.get("endsPeriod") else GAP_SEGMENT
            item = {"voice": u.get("voice"), "text": u.get("text"), "gapAfter": gap}
            if u.get("voice") == "pbp":
                boosted = hype_exaggeration(u.get("text"), voices.get("pbp", {}))
                if boosted is not None:
                    item["exaggeration"] = boosted
                    n_hype += 1
            flat.append(item)
            seg_of.append(si)
    return flat, seg_of, n_hype


def utt_path(emit_dir, idx):
    return os.path.join(emit_dir, f"u{idx:05d}.wav")


def done_count(flat, emit_dir):
    # An utterance is "done" if it's empty (no audio needed) or its wav exists.
    return sum(
        1 for i, u in enumerate(flat)
        if not (u.get("text") or "").strip() or os.path.exists(utt_path(emit_dir, i))
    )


# ── Mode: emit a slice of per-utterance wavs (GPU) ──────────────────────────

def run_emit(args):
    import soundfile as sf

    script = json.load(open(args.script))
    voices = load_voices(args.voices)
    flat, _seg_of, _ = build_flat(script.get("segments", []), voices)
    total = len(flat)
    os.makedirs(args.emit_dir, exist_ok=True)

    start = args.start or 0
    end = min(start + args.count, total) if args.count is not None else total
    todo = [
        i for i in range(start, end)
        if (flat[i].get("text") or "").strip() and not os.path.exists(utt_path(args.emit_dir, i))
    ]
    write_progress(args.progress_file, done_count(flat, args.emit_dir), total)
    if not todo:
        print(f"[chatterbox] emit [{start},{end}): nothing to do")
        return

    from cb_core import load_model  # lazy: only the GPU modes import torch

    model = load_model(args.device)
    for i in todo:
        u = flat[i]
        vcfg = voices.get(u["voice"]) or next(iter(voices.values()))
        wav = model.generate(
            u["text"],
            audio_prompt_path=vcfg["ref"],
            exaggeration=float(u.get("exaggeration", vcfg.get("exaggeration", 0.5))),
            cfg_weight=float(vcfg.get("cfg_weight", 0.5)),
        )
        samples = wav.squeeze(0).detach().cpu().numpy().astype(np.float32)
        # Write atomically so a kill mid-write can't leave a truncated wav that a
        # resume would treat as done. The .tmp suffix hides the extension, so the
        # format has to be explicit.
        tmp = utt_path(args.emit_dir, i) + ".tmp"
        sf.write(tmp, samples, model.sr, format="WAV")
        os.replace(tmp, utt_path(args.emit_dir, i))
        write_progress(args.progress_file, done_count(flat, args.emit_dir), total)
    print(f"[chatterbox] emit [{start},{end}): rendered {len(todo)} utts")


# ── Mode: assemble final audio + manifest from per-utterance wavs (no GPU) ───

def run_assemble(args):
    import soundfile as sf

    script = json.load(open(args.script))
    voices = load_voices(args.voices)
    segments = script.get("segments", [])
    flat, seg_of, n_hype = build_flat(segments, voices)
    total = len(flat)
    gid = args.gid or str(script.get("gid", "game"))

    # Sample rate from the first existing utterance wav.
    sr = 24000
    for i in range(total):
        p = utt_path(args.emit_dir, i)
        if os.path.exists(p):
            sr = sf.info(p).samplerate
            break

    def silence(seconds):
        return np.zeros(int(max(0.0, seconds) * sr), dtype=np.float32)

    missing = [
        i for i, u in enumerate(flat)
        if (u.get("text") or "").strip() and not os.path.exists(utt_path(args.emit_dir, i))
    ]
    if missing:
        print(f"[chatterbox] assemble: {len(missing)} utt(s) missing (e.g. {missing[:5]})",
              file=sys.stderr)
        sys.exit(4)

    parts = [silence(LEAD_IN)]
    cursor = LEAD_IN
    durations = []
    for i in range(total):
        u = flat[i]
        p = utt_path(args.emit_dir, i)
        if (u.get("text") or "").strip() and os.path.exists(p):
            s, _ = sf.read(p)
            s = np.asarray(s, dtype=np.float32)
            start = cursor
            parts.append(s)
            cursor += len(s) / sr
            durations.append({"i": i, "startSec": round(start, 3), "endSec": round(cursor, 3)})
        else:
            durations.append({"i": i, "startSec": round(cursor, 3), "endSec": round(cursor, 3)})
        if i < total - 1:
            g = float(u.get("gapAfter", GAP_UTTERANCE))
            parts.append(silence(g))
            cursor += g
    parts.append(silence(TAIL))
    cursor += TAIL

    audio = np.concatenate(parts)
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = audio * (0.89 / peak)

    os.makedirs(args.out_dir, exist_ok=True)
    out_no_ext = os.path.join(args.out_dir, gid)
    served = save_wav_mp3(audio, sr, out_no_ext, mp3_kbps=96)
    have_mp3 = served.endswith(".mp3")

    seg_bounds = {}
    for d in durations:
        si = seg_of[d["i"]]
        b = seg_bounds.setdefault(si, {"start": d["startSec"], "end": d["endSec"]})
        b["start"] = min(b["start"], d["startSec"])
        b["end"] = max(b["end"], d["endSec"])
    manifest_segments = []
    for si, seg in enumerate(segments):
        b = seg_bounds.get(si)
        if not b:
            continue
        manifest_segments.append({
            "i": seg.get("i", si),
            "period": seg.get("period"),
            "endsPeriod": bool(seg.get("endsPeriod")),
            "scoreStart": seg.get("scoreStart"),
            "scoreEnd": seg.get("scoreEnd"),
            "startSec": round(b["start"], 3),
            "endSec": round(b["end"], 3),
        })

    manifest = {
        "gid": gid,
        "engine": "chatterbox",
        "sampleRate": sr,
        "durationSec": round(cursor, 3),
        "voices": {k: {"ref": os.path.basename(v.get("ref", "")),
                       "exaggeration": v.get("exaggeration"),
                       "cfg_weight": v.get("cfg_weight")} for k, v in voices.items()},
        "audio": os.path.basename(served),
        "hasMp3": have_mp3,
        "numUtterances": total,
        "hypeBoosted": n_hype,
        "segments": manifest_segments,
    }
    with open(f"{out_no_ext}.manifest.json", "w") as f:
        json.dump(manifest, f)
    write_progress(args.progress_file, total, total)
    print(f"[chatterbox] assembled gid={gid}: {total} lines ({n_hype} hype) → "
          f"{cursor/60:.1f} min → {served}")


# ── Mode: legacy single-shot full render (CPU/small) ────────────────────────

def run_full(args):
    from cb_core import load_model, save_audio, synth_utterances

    script = json.load(open(args.script))
    voices = load_voices(args.voices)
    segments = script.get("segments", [])
    flat, seg_of, n_hype = build_flat(segments, voices)
    total = len(flat)
    if total == 0:
        print("[chatterbox] no utterances", file=sys.stderr)
        sys.exit(2)
    gid = args.gid or str(script.get("gid", "game"))
    spec = {"voices": voices, "utterances": flat,
            "gapUtterance": GAP_UTTERANCE, "leadIn": LEAD_IN, "tail": TAIL}
    model = load_model(args.device)
    write_progress(args.progress_file, 0, total)
    audio, sr, durations, duration_sec = synth_utterances(
        model, spec, on_progress=lambda d, t: write_progress(args.progress_file, d, t)
    )
    os.makedirs(args.out_dir, exist_ok=True)
    out_no_ext = os.path.join(args.out_dir, gid)
    served = save_audio(audio, sr, out_no_ext, mp3=True, mp3_kbps=96)
    seg_bounds = {}
    for d in durations:
        si = seg_of[d["i"]]
        b = seg_bounds.setdefault(si, {"start": d["startSec"], "end": d["endSec"]})
        b["start"] = min(b["start"], d["startSec"])
        b["end"] = max(b["end"], d["endSec"])
    manifest_segments = [
        {"i": seg.get("i", si), "period": seg.get("period"),
         "endsPeriod": bool(seg.get("endsPeriod")), "scoreStart": seg.get("scoreStart"),
         "scoreEnd": seg.get("scoreEnd"), "startSec": round(seg_bounds[si]["start"], 3),
         "endSec": round(seg_bounds[si]["end"], 3)}
        for si, seg in enumerate(segments) if si in seg_bounds
    ]
    manifest = {
        "gid": gid, "engine": "chatterbox", "sampleRate": sr,
        "durationSec": duration_sec, "audio": os.path.basename(served),
        "hasMp3": served.endswith(".mp3"), "numUtterances": total,
        "hypeBoosted": n_hype, "segments": manifest_segments,
    }
    with open(f"{out_no_ext}.manifest.json", "w") as f:
        json.dump(manifest, f)
    write_progress(args.progress_file, total, total)
    print(f"[chatterbox] gid={gid}: {total} lines ({n_hype} hype) → "
          f"{duration_sec/60:.1f} min → {served}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--out-dir")
    ap.add_argument("--gid")
    ap.add_argument("--voices", default=os.path.join(HERE, "voices.json"))
    ap.add_argument("--progress-file")
    ap.add_argument("--device")
    ap.add_argument("--emit-dir", help="chunked mode: per-utterance wav dir")
    ap.add_argument("--start", type=int, help="emit: first utterance index")
    ap.add_argument("--count", type=int, help="emit: number of utterances")
    ap.add_argument("--assemble", action="store_true", help="stitch emit-dir → final")
    args = ap.parse_args()

    if args.assemble:
        if not args.emit_dir or not args.out_dir:
            ap.error("--assemble needs --emit-dir and --out-dir")
        run_assemble(args)
    elif args.emit_dir:
        run_emit(args)
    else:
        if not args.out_dir:
            ap.error("full render needs --out-dir")
        run_full(args)


if __name__ == "__main__":
    main()
