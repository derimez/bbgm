#!/usr/bin/env python3
"""Radio broadcast — Phase 3: Kokoro-82M TTS renderer.

Reads a Phase-2 two-voice script (server/broadcast-script.js output) and renders
it to a single stitched audio file, plus a timing manifest the in-app player uses
to drive progressive, spoiler-free score reveal.

  BREEN  (voice 'pbp')   → play-by-play  → am_michael  (clear, energetic)
  CLYDE  (voice 'color') → color analyst → am_onyx     (deeper, smoother)

Two distinct Kokoro voices so the listener always knows who's talking. Utterances
are separated by short pauses; a longer pause lands at every period break (where
BREEN has just read the quarter's closing score) so the game breathes like a real
broadcast. Everything is offline/CPU via kokoro-onnx — no network, no torch.

Usage:
  kokoro_tts.py --script <script.json> --out-dir <dir> [--gid N]
                [--pbp-voice am_michael] [--color-voice am_onyx]
                [--progress-file <path>]

Writes into --out-dir:
  <gid>.wav            stitched 24kHz mono broadcast
  <gid>.mp3            same, mp3 (if ffmpeg present) — what the player streams
  <gid>.manifest.json  { gid, sampleRate, durationSec, segments:[{i,period,
                         endsPeriod,scoreStart,scoreEnd,startSec,endSec}] }

Progress: if --progress-file is given, a JSON {done,total} is rewritten as each
utterance renders, so the Node job can poll it.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")

SAMPLE_RATE = 24000  # Kokoro native
LANG = "en-us"

# Pause lengths (seconds) inserted as silence between spoken clips.
GAP_UTTERANCE = 0.28   # between consecutive lines within a segment
GAP_SEGMENT = 0.55     # between segments (same period)
GAP_PERIOD = 1.30      # after a segment that closes a quarter/OT
LEAD_IN = 0.40         # silence before the very first word
TAIL = 0.80            # silence after the last word

# Speaker delivery: Breen calls a touch quicker/hotter; Clyde is measured.
SPEED = {"pbp": 1.06, "color": 0.96}


def silence(seconds):
    return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)


def write_progress(path, done, total):
    if not path:
        return
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"done": done, "total": total}, f)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--gid")
    ap.add_argument("--pbp-voice", default=os.environ.get("BBGM_TTS_PBP_VOICE", "am_michael"))
    ap.add_argument("--color-voice", default=os.environ.get("BBGM_TTS_COLOR_VOICE", "am_onyx"))
    ap.add_argument("--progress-file")
    args = ap.parse_args()

    with open(args.script) as f:
        script = json.load(f)
    gid = args.gid or str(script.get("gid", "game"))
    voices = {"pbp": args.pbp_voice, "color": args.color_voice}

    segments = script.get("segments", [])
    total = sum(len(s.get("utterances", [])) for s in segments)
    if total == 0:
        print(f"[tts] gid={gid}: script has no utterances", file=sys.stderr)
        sys.exit(2)

    model_path = os.path.join(MODELS, "kokoro-v1.0.onnx")
    voices_path = os.path.join(MODELS, "voices-v1.0.bin")
    for p in (model_path, voices_path):
        if not os.path.exists(p):
            print(f"[tts] missing model file: {p}", file=sys.stderr)
            sys.exit(3)

    kokoro = Kokoro(model_path, voices_path)

    os.makedirs(args.out_dir, exist_ok=True)
    write_progress(args.progress_file, 0, total)

    audio_parts = [silence(LEAD_IN)]
    cursor = LEAD_IN  # running time (sec) at the point new audio is appended
    manifest_segments = []
    done = 0

    for si, seg in enumerate(segments):
        utts = seg.get("utterances", [])
        seg_start = cursor
        for ui, utt in enumerate(utts):
            text = (utt.get("text") or "").strip()
            voice = voices.get(utt.get("voice"), args.pbp_voice)
            if not text:
                done += 1
                continue
            samples, sr = kokoro.create(
                text, voice=voice, speed=SPEED.get(utt.get("voice"), 1.0), lang=LANG
            )
            samples = np.asarray(samples, dtype=np.float32)
            if sr != SAMPLE_RATE:
                # Kokoro is fixed at 24k; guard anyway.
                print(f"[tts] unexpected sample rate {sr}", file=sys.stderr)
            audio_parts.append(samples)
            cursor += len(samples) / SAMPLE_RATE
            done += 1
            write_progress(args.progress_file, done, total)
            # Pause after each line except the segment's last (handled below).
            if ui < len(utts) - 1:
                audio_parts.append(silence(GAP_UTTERANCE))
                cursor += GAP_UTTERANCE

        seg_end = cursor
        manifest_segments.append({
            "i": seg.get("i", si),
            "period": seg.get("period"),
            "endsPeriod": bool(seg.get("endsPeriod")),
            "scoreStart": seg.get("scoreStart"),
            "scoreEnd": seg.get("scoreEnd"),
            "startSec": round(seg_start, 3),
            "endSec": round(seg_end, 3),
        })
        # Inter-segment pause: a longer breath when a quarter just ended.
        gap = GAP_PERIOD if seg.get("endsPeriod") else GAP_SEGMENT
        if si < len(segments) - 1:
            audio_parts.append(silence(gap))
            cursor += gap

    audio_parts.append(silence(TAIL))
    cursor += TAIL

    audio = np.concatenate(audio_parts)
    # Gentle peak-normalize to -1 dBFS so voices sit at a consistent level.
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = audio * (0.89 / peak)

    wav_path = os.path.join(args.out_dir, f"{gid}.wav")
    sf.write(wav_path, audio, SAMPLE_RATE)

    mp3_path = os.path.join(args.out_dir, f"{gid}.mp3")
    have_mp3 = False
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path,
             "-codec:a", "libmp3lame", "-b:a", "96k", mp3_path],
            check=True,
        )
        have_mp3 = True
    except Exception as e:  # noqa: BLE001
        print(f"[tts] mp3 encode skipped: {e}", file=sys.stderr)

    manifest = {
        "gid": gid,
        "sampleRate": SAMPLE_RATE,
        "durationSec": round(cursor, 3),
        "voices": voices,
        "audio": os.path.basename(mp3_path if have_mp3 else wav_path),
        "hasMp3": have_mp3,
        "numUtterances": total,
        "segments": manifest_segments,
    }
    with open(os.path.join(args.out_dir, f"{gid}.manifest.json"), "w") as f:
        json.dump(manifest, f)

    write_progress(args.progress_file, total, total)
    mins = cursor / 60.0
    print(f"[tts] gid={gid}: {total} lines → {mins:.1f} min, "
          f"{'mp3+wav' if have_mp3 else 'wav'} written to {args.out_dir}")


if __name__ == "__main__":
    main()
