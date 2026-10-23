import os
import time

import numpy as np
import pytest
import soundfile as sf

from samplebank import analysis
from samplebank.analysis import AnalysisCache, analyse
from samplebank.library import Sample

SR = 22050


def write(path, data, sr=SR):
    sf.write(path, data.astype("float32"), sr)
    return path


def sine(freq, secs):
    t = np.arange(int(SR * secs)) / SR
    return 0.5 * np.sin(2 * np.pi * freq * t)


def sample_for(path, id="own/t/x.wav"):
    return Sample(id=id, source="own", bank="t", n=0, path=path, filename=path.name)


def test_sine_vs_noise_centroid(tmp_path):
    s = analyse(write(tmp_path / "s.wav", sine(1000, 1)))
    rng = np.random.default_rng(0)
    n = analyse(write(tmp_path / "n.wav", 0.5 * rng.uniform(-1, 1, SR)))
    assert s.centroid < n.centroid
    assert len(s.vector) == 29 and len(s.peaks) == 64


def test_silent_file_is_finite(tmp_path):
    f = analyse(write(tmp_path / "z.wav", np.zeros(SR)))
    assert all(np.isfinite(f.vector))
    assert np.isfinite(f.rms) and np.isfinite(f.centroid) and np.isfinite(f.attack)
    assert f.peaks == [0.0] * 64


def test_ultra_short_10ms(tmp_path):
    f = analyse(write(tmp_path / "s.wav", sine(440, 0.01)))
    assert all(np.isfinite(f.vector))
    assert len(f.peaks) == 64 and len(f.vector) == 29
    assert f.duration == pytest.approx(0.01, abs=1e-3)


def test_long_file_reads_10s(tmp_path):
    # 10 s of digital silence, then 50 s of loud tone: only the silent head may be analysed
    p = write(tmp_path / "l.wav", np.concatenate([np.zeros(10 * SR), sine(220, 50)]))
    t0 = time.perf_counter()
    f = analyse(p)
    assert time.perf_counter() - t0 < 3
    assert f.duration == pytest.approx(60, abs=0.01)
    assert f.rms == 0
    assert f.peaks == [0.0] * 64


def test_attack_is_time_of_rms_peak(tmp_path):
    d = np.zeros(SR)
    d[SR // 2 :] = sine(500, 0.5)
    f = analyse(write(tmp_path / "a.wav", d))
    assert f.attack == pytest.approx(0.5, abs=0.1)


def test_cache_hits_and_invalidates(tmp_path, monkeypatch):
    p = write(tmp_path / "a.wav", sine(440, 0.5))
    calls = []
    real = analysis.analyse
    monkeypatch.setattr(analysis, "analyse", lambda path: calls.append(path) or real(path))
    s = sample_for(p)
    cache = AnalysisCache(tmp_path / "cache.json")
    first = cache.get_or_compute(s)
    assert cache.get_or_compute(s) == first
    assert len(calls) == 1
    cache.save()
    cache2 = AnalysisCache(tmp_path / "cache.json")
    assert cache2.get_or_compute(s) == first
    assert len(calls) == 1
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    cache2.get_or_compute(s)
    assert len(calls) == 2


def test_corrupt_file_returns_none(tmp_path):
    p = tmp_path / "bad.wav"
    p.write_bytes(b"not audio at all")
    cache = AnalysisCache(tmp_path / "cache.json")
    assert cache.get_or_compute(sample_for(p)) is None
    assert cache.get_or_compute(sample_for(tmp_path / "missing.wav", "own/t/m.wav")) is None
    cache.save()


def test_layout_persists(tmp_path):
    cache = AnalysisCache(tmp_path / "cache.json")
    assert cache.layout == {}
    cache.layout = {"own/t/a.wav": [0.1, 0.2]}
    cache.save()
    assert AnalysisCache(tmp_path / "cache.json").layout == {"own/t/a.wav": [0.1, 0.2]}
