"""Cut a region out of a staged WAV, with optional edge fades."""

from __future__ import annotations

import io
import math

import numpy as np
import soundfile as sf

FADE_MS = 5
MIN_SLICE_S = 0.010


def _round_half_up(x: float) -> int:
    """Match JS Math.round for x >= 0 (Python round() is half-even)."""
    return math.floor(x + 0.5)


def fade_gains(n: int, sr: int) -> np.ndarray:
    """Per-frame gain for an n-frame slice: linear 5 ms fade-in and fade-out.

    F = min(floor(FADE_MS/1000 * sr + 0.5), n // 2)  (round-half-up);
    gain(i) = min(1, i / F, (n - 1 - i) / F), or all 1 when F == 0.
    The browser loop must use exactly this formula.
    """
    f = min(_round_half_up(FADE_MS / 1000 * sr), n // 2)
    if f <= 0:
        return np.ones(n, dtype=np.float64)
    i = np.arange(n, dtype=np.float64)
    return np.minimum(1.0, np.minimum(i / f, (n - 1 - i) / f))


def cut_wav(source: bytes, start: float, end: float, fade: bool = True) -> bytes:
    if not (math.isfinite(start) and math.isfinite(end)):
        raise ValueError("start/end must be finite numbers")
    if start < 0:
        raise ValueError("start must not be before the beginning of the file")
    if end <= start:
        raise ValueError("end must be after start")

    with sf.SoundFile(io.BytesIO(source)) as f:
        sr, subtype, fmt = f.samplerate, f.subtype, f.format
        total = f.frames
        if end > total / sr + 1 / sr:
            raise ValueError("end is beyond the end of the file")
        a = _round_half_up(start * sr)
        b = min(_round_half_up(end * sr), total)
        if b - a < MIN_SLICE_S * sr:
            raise ValueError("selection is shorter than 10 ms")
        # Unfaded PCM stays in integer domain so the cut is bit-identical.
        exact_int = not fade and subtype.startswith("PCM_")
        f.seek(a)
        data = f.read(b - a, dtype="int32" if exact_int else "float64", always_2d=True)

    if fade:
        data = data * fade_gains(len(data), sr)[:, None]

    out = io.BytesIO()
    sf.write(out, data, sr, subtype=subtype, format=fmt)
    return out.getvalue()
