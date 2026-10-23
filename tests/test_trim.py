import io
import math

import numpy as np
import pytest
import soundfile as sf

from samplebank.trim import FADE_MS, cut_wav, fade_gains


def _wav(data, sr=44100, subtype="PCM_16"):
    buf = io.BytesIO()
    sf.write(buf, data, sr, subtype=subtype, format="WAV")
    return buf.getvalue()


def _read(b, dtype="float64"):
    return sf.read(io.BytesIO(b), dtype=dtype, always_2d=True)


def test_cut_exact_frames():
    src = (np.arange(44100) % 30000).astype(np.int16)
    out, sr = _read(cut_wav(_wav(src), 0.25, 0.5, fade=False), dtype="int16")
    assert sr == 44100
    assert out.shape == (11025, 1)
    assert np.array_equal(out[:, 0], src[11025:22050])


def test_unfaded_pcm16_bit_identical_full_range():
    rng = np.random.default_rng(1)
    src = rng.integers(-32768, 32767, size=(20000, 2), dtype=np.int16)
    out, _ = _read(cut_wav(_wav(src), 0.0, 20000 / 44100, fade=False), dtype="int16")
    assert np.array_equal(out, src)


def test_unfaded_pcm24_bit_identical():
    rng = np.random.default_rng(2)
    src = (rng.integers(-(2**23), 2**23 - 1, size=(20000, 2)) << 8).astype(np.int32)
    raw = _wav(src, 48000, "PCM_24")
    out, _ = _read(cut_wav(raw, 0.0, 20000 / 48000, fade=False), dtype="int32")
    assert np.array_equal(out, src)


def test_keeps_sr_channels_subtype():
    data = np.random.default_rng(0).uniform(-0.5, 0.5, (48000, 2))
    out = cut_wav(_wav(data, 48000, "PCM_24"), 0.1, 0.6)
    info = sf.info(io.BytesIO(out))
    assert (info.samplerate, info.channels, info.subtype) == (48000, 2, "PCM_24")
    assert info.format == "WAV"


def test_fades_are_linear_5ms():
    sr = 44100
    out, _ = _read(cut_wav(_wav(np.ones(sr), sr, "FLOAT"), 0.2, 0.6))
    out = out[:, 0]
    f = math.floor(FADE_MS / 1000 * sr + 0.5)
    n = len(out)
    assert out[0] == 0.0
    assert out[-1] == 0.0
    assert out[f - 1] == pytest.approx((f - 1) / f, abs=1e-6)
    assert out[f] == 1.0
    assert np.all(out[f : n - f] == 1.0)
    assert out[n - 1 - (f - 1)] == pytest.approx((f - 1) / f, abs=1e-6)


def test_fade_gains_formula():
    sr = 44100
    n = 1000
    f = math.floor(0.005 * sr + 0.5)
    g = fade_gains(n, sr)
    assert g.dtype == np.float64 and g.shape == (n,)
    assert g[0] == 0.0 and g[n - 1] == 0.0
    assert g[1] == pytest.approx(1 / f)
    assert np.all(g[f : n - f] == 1.0)
    assert g[f - 1] == pytest.approx((f - 1) / f)


def test_fade_gains_clamped_to_half():
    g = fade_gains(441, 44100)  # 10 ms, F=220 == n//2
    assert g[0] == 0.0 and g[-1] == 0.0
    assert g.max() <= 1.0
    assert fade_gains(1, 44100).tolist() == [1.0]  # F == 0 -> no fade


def test_fades_all_channels():
    out, _ = _read(cut_wav(_wav(np.ones((44100, 2)), 44100, "FLOAT"), 0.0, 0.5))
    assert np.all(out[0] == 0.0) and np.all(out[-1] == 0.0)


@pytest.mark.parametrize(
    "start,end",
    [(-0.1, 0.5), (0.5, 0.4), (0.5, 0.505), (0.1, 99), (float("nan"), 1)],
)
def test_rejects_bad_ranges(start, end):
    with pytest.raises(ValueError):
        cut_wav(_wav(np.zeros(44100)), start, end)


def test_whole_range_ok():
    out, _ = _read(cut_wav(_wav(np.zeros(44100)), 0, 1.0))
    assert len(out) == 44100


@pytest.mark.parametrize("sr,f", [(44100, 221), (48000, 240)])
def test_fade_length_round_half_up(sr, f):
    g = fade_gains(10 * sr // 100 + 1000, sr)
    assert g[f] == 1.0
    assert g[f - 1] == pytest.approx((f - 1) / f)


def test_frame_conversion_round_half_up():
    src = np.arange(8, dtype=np.int16)
    raw = _wav(src, sr=2)
    out, _ = _read(cut_wav(raw, 0.25, 1.75, fade=False), dtype="int16")
    assert out[:, 0].tolist() == [1, 2, 3]  # frames [floor(.5+.5), floor(3.5+.5)) = [1, 4)


def test_min_slice_limit_is_in_frames():
    raw = _wav(np.zeros(11025), sr=11025)
    out, _ = _read(cut_wav(raw, 0.0, 110 / 11025, fade=False))
    assert len(out) == 110  # exactly 10 ms at 11025 Hz
    with pytest.raises(ValueError):
        cut_wav(raw, 0.0, 109 / 11025, fade=False)
