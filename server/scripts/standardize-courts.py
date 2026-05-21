#!/usr/bin/env python3
"""Standardize NBA court diagrams so every image maps 1:1 to simcast world coords.

The raw court database (server/public/courts/*.jpg) has wildly varying canvas
sizes and apron widths, so no single inset fits them all. But two facts hold
across the whole database:

  1. The playing surface is perfectly CENTERED in the canvas (verified: center
     offset < 1 px across 200+ images).
  2. The playing surface aspect ratio is exactly 94:50 (a real NBA court).

So a court is fully described by ONE number per image: its height as a fraction
of the canvas height. For the dominant template that fraction is ~0.8276; some
eras differ slightly. We detect it per canvas-size group (images that share a
size share a template) by taking the median of wood-region detections, and fall
back to 0.8276 when a group has too few clean detections (e.g. red "cup" courts).

Every image is then re-cropped + resized to ONE canonical layout:

    canonical image == simcast world rect (-APRON_FT,-APRON_FT)..(94+APRON_FT,50+APRON_FT)

so the viewer blits each standardized court at a single fixed transform with the
baskets guaranteed on the rims. Output goes to courts/std/.
"""
import sys, os, json, collections
import numpy as np
from PIL import Image

COURTS = os.path.join(os.path.dirname(__file__), "..", "public", "courts")
OUT = os.path.join(COURTS, "std")
APRON_FT = 6.0
COURT_L, COURT_W = 94.0, 50.0
COURT_ASPECT = COURT_L / COURT_W            # 1.88
DEFAULT_RATIO = 0.8276                      # courtHeight / canvasHeight, dominant template
# Canonical output: playing surface 1600 px wide.
PXPF = 1600.0 / COURT_L
CANON_W = int(round((COURT_L + 2 * APRON_FT) * PXPF))   # 1804
CANON_H = int(round((COURT_W + 2 * APRON_FT) * PXPF))   # 1055


def wood_mask(a):
    """Warm light-wood pixels — the bare playing surface."""
    r = a[:, :, 0].astype(int); g = a[:, :, 1].astype(int); b = a[:, :, 2].astype(int)
    return ((r > g - 8) & (g >= b - 8) & ((r - b) > 22) & ((r - b) < 155)
            & (r > 115) & (r < 248) & (g > 80))


def detect_ratio(a):
    """Detect courtHeight/canvasHeight via the wood region. None if not clean."""
    w = wood_mask(a)
    H, W = w.shape
    if w.sum() < 2000:
        return None
    rr = np.where(w.mean(1) > 0.30)[0]
    cc = np.where(w.mean(0) > 0.30)[0]
    if len(rr) < 10 or len(cc) < 10:
        return None
    y0, y1, x0, x1 = rr.min(), rr.max(), cc.min(), cc.max()
    for _ in range(4):
        cp = w[y0:y1 + 1, :].mean(0)
        rp = w[:, x0:x1 + 1].mean(1)
        cc = np.where(cp > 0.55)[0]
        rr = np.where(rp > 0.55)[0]
        if len(rr) < 10 or len(cc) < 10:
            return None
        y0, y1, x0, x1 = rr.min(), rr.max(), cc.min(), cc.max()
    ch, cw = y1 - y0, x1 - x0
    if ch < 40 or cw < 60:
        return None
    if not (1.86 <= cw / ch <= 1.90):     # must look like a 94:50 court
        return None
    return ch / H


def group_ratios():
    """Median height ratio per canvas-size group, with formula fallback."""
    files = sorted(f for f in os.listdir(COURTS)
                   if f.lower().endswith(".jpg") and f != "msg-1986-1991.jpg")
    by_size = collections.defaultdict(list)
    for f in files:
        with Image.open(os.path.join(COURTS, f)) as im:
            by_size[im.size].append(f)
    ratios = {}
    for sz, fs in by_size.items():
        det = []
        for n in fs:
            a = np.asarray(Image.open(os.path.join(COURTS, n)).convert("RGB"))
            r = detect_ratio(a)
            if r is not None:
                det.append(r)
        # Trust a group's own median only when its detections agree tightly —
        # a small inter-quartile spread is the proof the detector locked on.
        # Otherwise fall back to the dominant-template ratio.
        ok = False
        if len(det) >= 5:
            spread = np.percentile(det, 75) - np.percentile(det, 25)
            med = float(np.median(det))
            if spread < 0.03 and 0.60 <= med <= 0.89:
                ok = True
        if ok:
            ratios[sz] = (round(med, 4), len(fs), len(det), True)
        else:
            ratios[sz] = (DEFAULT_RATIO, len(fs), len(det), False)
    return by_size, ratios


def standardize(name, ratio):
    """Crop to playing surface + APRON_FT apron, resize to the canonical canvas."""
    im = Image.open(os.path.join(COURTS, name)).convert("RGB")
    W, H = im.size
    ch = ratio * H
    cw = ch * COURT_ASPECT
    # Playing-surface rect, centered in the canvas.
    x0 = (W - cw) / 2.0
    y0 = (H - ch) / 2.0
    # Expand by APRON_FT of apron on every side.
    ax = cw / COURT_L * APRON_FT
    ay = ch / COURT_W * APRON_FT
    cx0, cy0 = x0 - ax, y0 - ay
    cx1, cy1 = x0 + cw + ax, y0 + ch + ay
    crop = Image.new("RGB", (int(round(cx1 - cx0)), int(round(cy1 - cy0))), (0, 0, 0))
    crop.paste(im, (int(round(-cx0)), int(round(-cy0))))
    crop.resize((CANON_W, CANON_H), Image.LANCZOS).save(
        os.path.join(OUT, name), quality=88)


if __name__ == "__main__":
    by_size, ratios = group_ratios()
    detected = sum(1 for v in ratios.values() if v[3])
    fallback = sum(1 for v in ratios.values() if not v[3])
    print(f"canvas-size groups: {len(ratios)}  detected={detected}  fallback={fallback}")
    print(f"canonical output: {CANON_W}x{CANON_H} px  ({PXPF:.3f} px/ft)")
    for sz, (r, nf, nd, ok) in sorted(ratios.items(), key=lambda x: -x[1][1]):
        if not ok or nf >= 40:
            print(f"  {str(sz):14s} n={nf:3d} det={nd:3d} ratio={r:.4f} {'' if ok else '<- fallback'}")

    if len(sys.argv) > 1 and sys.argv[1] == "write":
        os.makedirs(OUT, exist_ok=True)
        done = 0
        for sz, fs in by_size.items():
            r = ratios[sz][0]
            for n in fs:
                try:
                    standardize(n, r)
                    done += 1
                except Exception as e:
                    print("  FAIL", n, e)
        print(f"standardized {done} images -> {OUT}")
