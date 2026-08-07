#!/usr/bin/env python3
"""Chatterbox voice-clone synthesizer — the shared TTS primitive.

Loads Chatterbox once, then renders a list of {voice, text} utterances using a
per-voice cloned reference + emotion params, and stitches them into one file.
Used for: A/B samples, the full-game broadcast renderer, and the AGM speak
endpoint (single utterance). Runs on the RX 6800 via torch-ROCm.

Input JSON (--lines):
  {
    "voices": {
      "pbp":   {"ref": "refs/breen.wav",   "exaggeration": 0.7, "cfg_weight": 0.4},
      "color": {"ref": "refs/frazier.wav", "exaggeration": 0.5, "cfg_weight": 0.5}
    },
    "utterances": [{"voice": "pbp", "text": "..."}, ...],
    "gapUtterance": 0.28, "gapSegmentEnd": 1.3, "leadIn": 0.4, "tail": 0.6
  }
Utterances may carry "gapAfter" (seconds) to override the pause after that line
(e.g. a period break). Writes <out>.wav (+ <out>.mp3 with --mp3) and, next to it,
<out>.durations.json = [{i, voice, dur, startSec, endSec}] so callers can build a
timing manifest without re-measuring audio.
"""
import argparse
import json
import os
import subprocess
import sys

os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "10.3.0")  # RX 6800 = gfx1030

import numpy as np
import torch
import torchaudio  # noqa: F401  (registers audio backends)
from chatterbox.tts import ChatterboxTTS


def write_progress(path, done, total):
    if not path:
        return
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"done": done, "total": total}, f)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lines", required=True)
    ap.add_argument("--out", required=True)  # path without extension
    ap.add_argument("--mp3", action="store_true")
    ap.add_argument("--progress-file")
    ap.add_argument("--device", default=os.environ.get("BBGM_TTS_DEVICE", "cuda"))
    args = ap.parse_args()

    with open(args.lines) as f:
        spec = json.load(f)
    voices = spec.get("voices", {})
    utts = spec.get("utterances", [])
    gap_utt = spec.get("gapUtterance", 0.28)
    lead_in = spec.get("leadIn", 0.4)
    tail = spec.get("tail", 0.6)
    total = len(utts)
    if total == 0:
        print("[chatterbox] no utterances", file=sys.stderr)
        sys.exit(2)

    device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        print("[chatterbox] no ROCm/CUDA device — falling back to CPU", file=sys.stderr)
        device = "cpu"
    model = ChatterboxTTS.from_pretrained(device=device)
    sr = model.sr
    print(f"[chatterbox] model loaded on {device}, sr={sr}", file=sys.stderr)

    def silence(seconds):
        return np.zeros(int(seconds * sr), dtype=np.float32)

    parts = [silence(lead_in)]
    cursor = lead_in
    durations = []
    write_progress(args.progress_file, 0, total)

    for i, u in enumerate(utts):
        text = (u.get("text") or "").strip()
        vcfg = voices.get(u.get("voice")) or next(iter(voices.values()))
        if not text:
            durations.append({"i": i, "voice": u.get("voice"), "dur": 0,
                              "startSec": round(cursor, 3), "endSec": round(cursor, 3)})
            write_progress(args.progress_file, i + 1, total)
            continue
        wav = model.generate(
            text,
            audio_prompt_path=vcfg["ref"],
            exaggeration=float(vcfg.get("exaggeration", 0.5)),
            cfg_weight=float(vcfg.get("cfg_weight", 0.5)),
        )
        samples = wav.squeeze(0).detach().cpu().numpy().astype(np.float32)
        start = cursor
        parts.append(samples)
        cursor += len(samples) / sr
        durations.append({"i": i, "voice": u.get("voice"),
                          "dur": round(len(samples) / sr, 3),
                          "startSec": round(start, 3), "endSec": round(cursor, 3)})
        # Pause after this line (per-utterance override, else default gap; skip last).
        if i < total - 1:
            g = float(u.get("gapAfter", gap_utt))
            parts.append(silence(g))
            cursor += g
        write_progress(args.progress_file, i + 1, total)

    parts.append(silence(tail))
    cursor += tail
    audio = np.concatenate(parts)
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = audio * (0.89 / peak)

    import soundfile as sf
    wav_path = f"{args.out}.wav"
    sf.write(wav_path, audio, sr)

    out_audio = wav_path
    if args.mp3:
        mp3_path = f"{args.out}.mp3"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path,
                 "-codec:a", "libmp3lame", "-b:a", "96k", mp3_path],
                check=True,
            )
            out_audio = mp3_path
        except Exception as e:  # noqa: BLE001
            print(f"[chatterbox] mp3 encode skipped: {e}", file=sys.stderr)

    with open(f"{args.out}.durations.json", "w") as f:
        json.dump({"sampleRate": sr, "durationSec": round(cursor, 3),
                   "audio": os.path.basename(out_audio), "utterances": durations}, f)

    write_progress(args.progress_file, total, total)
    print(f"[chatterbox] {total} lines → {cursor/60:.1f} min → {out_audio}")


if __name__ == "__main__":
    main()
