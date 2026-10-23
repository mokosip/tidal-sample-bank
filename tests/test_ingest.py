import shutil
import subprocess

import pytest
import soundfile as sf

from samplebank.ingest import check_bank, ingest, normalize_bank

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="no ffmpeg")


def wav_bytes(tmp_path, name="t.wav", sr=22050, ch=1):
    import numpy as np

    p = tmp_path / name
    sf.write(p, np.zeros((1000, ch)), sr, subtype="PCM_16")
    return p.read_bytes()


def mp3_bytes(tmp_path):
    p = tmp_path / "t.mp3"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
         "sine=frequency=440:duration=0.5", "-ac", "2", "-ar", "44100", str(p)],
        check=True,
    )
    return p.read_bytes()


@pytest.fixture
def roots(tmp_path):
    (tmp_path / "dirt" / "bd").mkdir(parents=True)
    (tmp_path / "dub" / "pad").mkdir(parents=True)
    (tmp_path / "own" / "mine").mkdir(parents=True)
    for d in ("dirt/bd", "dub/pad", "own/mine"):
        sf.write(tmp_path / d / "x.wav", [0.0] * 10, 8000)  # bank_names lists banks with readable audio
    return {k: tmp_path / k for k in ("dirt", "dub", "own")}


def test_normalize():
    assert normalize_bank("My Kicks-01") == "my_kicks_01"
    with pytest.raises(ValueError):
        normalize_bank("808 bd")


def test_clash_with_dirt_suggests_mine(roots):
    assert check_bank("bd", roots) == (False, "bd_mine")


def test_clash_increments(roots):
    (roots["own"] / "bd_mine").mkdir()
    sf.write(roots["own"] / "bd_mine" / "x.wav", [0.0] * 10, 8000)
    # own bank bd_mine exists -> it is a valid append target, so suggestion is it
    assert check_bank("bd", roots) == (False, "bd_mine")
    (roots["dirt"] / "bd_mine").mkdir()
    sf.write(roots["dirt"] / "bd_mine" / "x.wav", [0.0] * 10, 8000)
    assert check_bank("bd", roots) == (False, "bd_mine2")


def test_clash_with_dub(roots):
    assert check_bank("pad", roots)[0] is False


def test_existing_own_bank_ok(roots):
    assert check_bank("mine", roots) == (True, None)
    assert check_bank("brandnew", roots) == (True, None)


def test_mixed_batch(roots, tmp_path):
    if shutil.which("ffmpeg") is None:
        pytest.skip("no ffmpeg")
    res = ingest(
        [("a.wav", wav_bytes(tmp_path)), ("b.mp3", mp3_bytes(tmp_path)),
         ("c.txt", b"hello"), ("d.wav", b"")],
        "newbank", roots,
    )
    assert sorted(res.added) == ["a.wav", "b.wav"]
    assert sorted(f for f, _ in res.rejected) == ["c.txt", "d.wav"]
    assert all(reason for _, reason in res.rejected)
    assert (roots["own"] / "newbank" / "b.wav").exists()


@needs_ffmpeg
def test_corrupt_mp3_rejected(roots):
    res = ingest([("x.mp3", b"not really an mp3")], "newbank", roots)
    assert res.added == [] and res.rejected[0][0] == "x.mp3"


@needs_ffmpeg
def test_converted_keeps_rate_and_channels(roots, tmp_path):
    res = ingest([("b.mp3", mp3_bytes(tmp_path))], "newbank", roots)
    info = sf.info(roots["own"] / "newbank" / res.added[0])
    assert (info.samplerate, info.channels) == (44100, 2)


def test_collision_renamed(roots, tmp_path):
    data = wav_bytes(tmp_path)
    res = ingest([("a.wav", data), ("a.wav", data)], "newbank", roots)
    assert res.added == ["a.wav", "a_2.wav"]
    res = ingest([("a.wav", data)], "newbank", roots)
    assert res.added == ["a_3.wav"]


def test_path_traversal_sanitised(roots, tmp_path):
    res = ingest([("../../evil.wav", wav_bytes(tmp_path))], "newbank", roots)
    assert res.added == ["evil.wav"]
    assert (roots["own"] / "newbank" / "evil.wav").exists()
    assert not (roots["own"].parent / "evil.wav").exists()


def test_invalid_bank_raises(roots):
    with pytest.raises(ValueError):
        ingest([("a.wav", b"x")], "bd", roots)


def test_fake_wav_rejected(roots, tmp_path):
    res = ingest([("bad.wav", b"hello"), ("ok.wav", wav_bytes(tmp_path))], "newbank", roots)
    assert res.added == ["ok.wav"]
    assert res.rejected[0][0] == "bad.wav"
    assert not (roots["own"] / "newbank" / "bad.wav").exists()


def test_ffmpeg_timeout_rejected(roots, tmp_path, monkeypatch):
    def boom(*a, **k):
        raise subprocess.TimeoutExpired(a[0], 60)

    monkeypatch.setattr(subprocess, "run", boom)
    res = ingest([("a.mp3", b"x"), ("ok.wav", wav_bytes(tmp_path))], "newbank", roots)
    assert res.added == ["ok.wav"]
    assert res.rejected == [("a.mp3", "conversion timed out")]


def test_unsupported_ext_never_calls_ffmpeg(roots, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: calls.append(a))
    res = ingest([("x.m3u8", b"#EXTM3U"), ("notes.txt", b"hi")], "newbank", roots)
    assert calls == [] and res.added == []
    assert [r for _, r in res.rejected] == ["unsupported file type"] * 2


@pytest.mark.parametrize("name", ["a\x00b.wav", "a" * 300 + ".wav"])
def test_bad_names_do_not_crash_batch(roots, tmp_path, name):
    res = ingest([(name, wav_bytes(tmp_path)), ("ok.wav", wav_bytes(tmp_path))], "newbank", roots)
    assert res.added == ["ok.wav"]
    assert len(res.rejected) == 1


def _header_only_wav():
    import io

    import numpy as np

    b = io.BytesIO()
    sf.write(b, np.zeros(0, dtype="float32"), 44100, format="WAV")
    return b.getvalue()


def test_header_only_wav_rejected_valid_added(roots, tmp_path):
    res = ingest([("a_empty.wav", _header_only_wav()), ("b_ok.wav", wav_bytes(tmp_path))], "newbank", roots)
    assert res.added == ["b_ok.wav"]
    assert res.rejected == [("a_empty.wav", "no audio frames")]
    assert not (roots["own"] / "newbank" / "a_empty.wav").exists()


def test_converted_zero_frame_output_rejected(roots, monkeypatch):
    from samplebank import ingest as mod

    monkeypatch.setattr(mod, "_convert", lambda data, ext: _header_only_wav())
    res = ingest([("a.mp3", b"x")], "newbank", roots)
    assert res.added == [] and res.rejected == [("a.mp3", "no audio frames")]
    assert not (roots["own"] / "newbank").exists() or not list((roots["own"] / "newbank").iterdir())
