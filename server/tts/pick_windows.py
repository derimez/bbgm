#!/usr/bin/env python3
"""Pick the best reference windows from an isolated-vocals track.

Slides a fixed-length window over the audio, scores each by RMS energy (proxy for
continuous, confident speech — and for a hype reel, the most excited calls), and
emits the top-N NON-overlapping windows as normalized mp3s for a human to pick.
"""
import argparse
import subprocess
import sys

import numpy as np
import soundfile as sf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out-prefix", required=True)
    ap.add_argument("--win", type=float, default=13.0)
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--hop", type=float, default=1.0)
    args = ap.parse_args()

    audio, sr = sf.read(args.inp)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    win = int(args.win * sr)
    hop = int(args.hop * sr)
    if len(audio) < win:
        print("audio shorter than window", file=sys.stderr)
        sys.exit(1)

    starts = list(range(0, len(audio) - win, hop))
    scores = [(np.sqrt(np.mean(audio[s:s + win] ** 2)), s) for s in starts]
    scores.sort(reverse=True)

    picked = []
    for _rms, s in scores:
        if all(abs(s - p) >= win for p in picked):  # non-overlapping
            picked.append(s)
        if len(picked) >= args.n:
            break
    picked.sort()

    for i, s in enumerate(picked, 1):
        t0 = s / sr
        wav_tmp = f"{args.out_prefix}_{i}.tmp.wav"
        sf.write(wav_tmp, audio[s:s + win], sr)
        mp3 = f"{args.out_prefix}_{i}.mp3"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_tmp,
             "-af", "loudnorm=I=-16:TP=-1.5", "-codec:a", "libmp3lame", "-b:a", "128k", mp3],
            check=True,
        )
        subprocess.run(["rm", "-f", wav_tmp])
        print(f"  window {i}: {t0:.1f}s  rms-rank  → {mp3}")


if __name__ == "__main__":
    main()
