#!/usr/bin/env python3
"""Chatterbox synth core — shared by the sample CLI, the game renderer, and the
AGM speak endpoint. Loads the model once, renders a list of {voice,text}
utterances with per-voice cloned references + emotion params, and stitches them
with pauses. Runs on the RX 6800 via torch-ROCm.
"""
import os

os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "10.3.0")  # RX 6800 = gfx1030

import subprocess
import sys

import numpy as np
import torch
import torchaudio  # noqa: F401  (registers audio backends for chatterbox)
from chatterbox.tts import ChatterboxTTS


def load_model(device=None):
    device = device or os.environ.get("BBGM_TTS_DEVICE", "cuda")
    if device == "cuda" and not torch.cuda.is_available():
        print("[cb] no ROCm/CUDA device — CPU fallback", file=sys.stderr)
        device = "cpu"
    model = ChatterboxTTS.from_pretrained(device=device)
    print(f"[cb] model loaded on {device}, sr={model.sr}", file=sys.stderr)
    return model


def synth_utterances(model, spec, on_progress=None):
    """Render spec → (audio float32 ndarray, sr, durations).

    spec: { voices:{voice:{ref,exaggeration,cfg_weight}}, utterances:[{voice,text,gapAfter?}],
            gapUtterance, leadIn, tail }
    durations: [{i,voice,dur,startSec,endSec}] (silence-inclusive timeline).
    """
    sr = model.sr
    voices = spec.get("voices", {})
    utts = spec.get("utterances", [])
    gap_utt = spec.get("gapUtterance", 0.28)
    lead_in = spec.get("leadIn", 0.4)
    tail = spec.get("tail", 0.6)
    total = len(utts)

    def silence(seconds):
        return np.zeros(int(max(0.0, seconds) * sr), dtype=np.float32)

    parts = [silence(lead_in)]
    cursor = lead_in
    durations = []
    if on_progress:
        on_progress(0, total)

    for i, u in enumerate(utts):
        text = (u.get("text") or "").strip()
        vcfg = voices.get(u.get("voice")) or next(iter(voices.values()))
        if not text:
            durations.append({"i": i, "voice": u.get("voice"), "dur": 0,
                              "startSec": round(cursor, 3), "endSec": round(cursor, 3)})
            if on_progress:
                on_progress(i + 1, total)
            continue
        # Per-utterance overrides (e.g. a hype-boosted big call) fall back to the
        # voice's base params.
        wav = model.generate(
            text,
            audio_prompt_path=vcfg["ref"],
            exaggeration=float(u.get("exaggeration", vcfg.get("exaggeration", 0.5))),
            cfg_weight=float(u.get("cfg_weight", vcfg.get("cfg_weight", 0.5))),
        )
        samples = wav.squeeze(0).detach().cpu().numpy().astype(np.float32)
        start = cursor
        parts.append(samples)
        cursor += len(samples) / sr
        durations.append({"i": i, "voice": u.get("voice"),
                          "dur": round(len(samples) / sr, 3),
                          "startSec": round(start, 3), "endSec": round(cursor, 3)})
        if i < total - 1:
            g = float(u.get("gapAfter", gap_utt))
            parts.append(silence(g))
            cursor += g
        if on_progress:
            on_progress(i + 1, total)

    parts.append(silence(tail))
    cursor += tail
    audio = np.concatenate(parts)
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = audio * (0.89 / peak)
    return audio, sr, durations, round(cursor, 3)


def save_audio(audio, sr, out_no_ext, mp3=True, mp3_kbps=96):
    """Write <out>.wav and optionally <out>.mp3. Returns the served path basename."""
    import soundfile as sf
    wav_path = f"{out_no_ext}.wav"
    sf.write(wav_path, audio, sr)
    if not mp3:
        return wav_path
    mp3_path = f"{out_no_ext}.mp3"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path,
             "-codec:a", "libmp3lame", "-b:a", f"{mp3_kbps}k", mp3_path],
            check=True,
        )
        return mp3_path
    except Exception as e:  # noqa: BLE001
        print(f"[cb] mp3 encode skipped: {e}", file=sys.stderr)
        return wav_path
