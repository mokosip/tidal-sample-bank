import json
import logging
import os
import tempfile
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

from . import config
from .library import Sample

log = logging.getLogger(__name__)

SR = 22050
MAX_SECONDS = 10
N_PEAKS = 64
N_FFT = 2048
HOP = 512

_LOCK = threading.Lock()


@dataclass
class Features:
    duration: float
    rms: float
    centroid: float
    attack: float
    vector: list[float]
    peaks: list[float]


def _peaks(y: np.ndarray) -> list[float]:
    if len(y) == 0:
        return [0.0] * N_PEAKS
    edges = np.linspace(0, len(y), N_PEAKS + 1).astype(int)
    a = np.abs(y)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        lo = min(lo, len(y) - 1)
        out.append(float(a[lo : max(hi, lo + 1)].max()))
    return [min(max(p, 0.0), 1.0) for p in out]


def analyse(path: Path) -> Features:
    with sf.SoundFile(path) as f:
        sr = f.samplerate
        duration = f.frames / sr
        y = f.read(frames=int(MAX_SECONDS * sr), dtype="float32", always_2d=True).mean(axis=1)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    y = np.nan_to_num(y)
    peaks = _peaks(y)
    padded = np.pad(y, (0, max(0, N_FFT - len(y))))  # STFT needs at least one full frame

    rms_env = librosa.feature.rms(y=padded, frame_length=N_FFT, hop_length=HOP)[0]
    attack = float(np.argmax(rms_env) * HOP / SR)
    rms = float(np.sqrt(np.mean(y**2))) if len(y) else 0.0
    centroid = float(librosa.feature.spectral_centroid(y=padded, sr=SR, n_fft=N_FFT, hop_length=HOP).mean())
    mfcc = librosa.feature.mfcc(y=padded, sr=SR, n_mfcc=13, n_fft=N_FFT, hop_length=HOP)
    vector = [*mfcc.mean(axis=1), *mfcc.std(axis=1), np.log1p(centroid), np.log1p(duration), attack]
    vector = [float(v) for v in np.nan_to_num(np.array(vector))]
    return Features(duration=float(duration), rms=rms, centroid=centroid, attack=attack,
                    vector=vector, peaks=peaks)


class AnalysisCache:
    """Features keyed by (id, mtime_ns, size), plus the stored 2D map layout, in one JSON file."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._entries: dict[str, dict] = {}
        self._layout: dict[str, list[float]] = {}
        self._lock = threading.RLock()  # guards _entries/_layout against concurrent callers
        try:
            data = json.loads(self.path.read_text())
            self._entries = data.get("entries", {})
            self._layout = data.get("layout", {})
        except FileNotFoundError:
            pass
        except (json.JSONDecodeError, AttributeError):
            log.warning("analysis cache unreadable, starting empty: %s", self.path)

    @property
    def layout(self) -> dict[str, list[float]]:
        return self._layout

    @layout.setter
    def layout(self, value: dict[str, list[float]]) -> None:
        with self._lock:
            self._layout = value

    def get_or_compute(self, sample: Sample) -> Features | None:
        try:
            st = sample.path.stat()
            key = [st.st_mtime_ns, st.st_size]
            with self._lock:
                hit = self._entries.get(sample.id)
            if hit and hit["key"] == key:
                return Features(**hit["features"])
            feats = analyse(sample.path)
        except Exception as e:  # unreadable/corrupt audio must never break a scan
            log.warning("cannot analyse %s: %s", sample.path, e)
            return None
        with self._lock:
            self._entries[sample.id] = {"key": key, "features": asdict(feats)}
        return feats

    def save(self) -> None:
        with self._lock:  # snapshot, so serialising never races with writers
            snapshot = {"entries": dict(self._entries), "layout": dict(self._layout)}
        with _LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name + ".", suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(snapshot, f)
                os.replace(tmp, self.path)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise


def main() -> None:
    from .library import scan

    t0 = time.perf_counter()
    samples = scan(config.ROOTS)
    cache = AnalysisCache(config.CACHE_PATH)
    failed = [s.id for s in samples if cache.get_or_compute(s) is None]
    cache.save()
    print(f"{len(samples)} samples, {len(failed)} unreadable, {time.perf_counter() - t0:.1f}s")
    for id in failed:
        print("  failed:", id)


if __name__ == "__main__":
    main()
