import io
import shutil
import subprocess
import time

import numpy as np
import pytest
import soundfile as sf

from samplebank import config
from samplebank.staging import Staging

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="no ffmpeg")


def wav(seconds, sr=44100, ch=1, fmt="WAV", subtype="PCM_16"):
    buf = io.BytesIO()
    sf.write(buf, np.zeros((int(seconds * sr), ch)), sr, format=fmt, subtype=subtype)
    return buf.getvalue()


def m4a(tmp_path, seconds):
    p = tmp_path / "t.m4a"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
         f"sine=frequency=440:duration={seconds}", "-ac", "2", "-ar", "44100", str(p)],
        check=True,
    )
    return p.read_bytes()


@needs_ffmpeg
def test_stage_mixed_batch(tmp_path):
    st = Staging(tmp_path / "stage")
    files = [
        ("notes.txt", b"hello"),
        ("bad.mp3", b"not really an mp3" * 50),
        ("long.m4a", m4a(tmp_path, 40)),
        ("short.wav", wav(1.0)),
    ]
    batch, staged, rejected = st.create(files)
    assert [s.filename for s in staged] == ["long.m4a", "short.wav"]
    assert staged[0].duration == pytest.approx(40.0, abs=0.1)
    assert staged[1].duration == pytest.approx(1.0, abs=0.001)
    assert dict(rejected) == {
        "notes.txt": "unsupported file type",
        "bad.mp3": "not a decodable audio file",
    }
    for s in staged:
        assert s.original.exists() and s.source.exists()
        assert sf.info(s.source).format == "WAV"
        assert st.get(batch, s.token) == s


def test_aif_source_is_wav(tmp_path):
    st = Staging(tmp_path / "stage")
    data = wav(0.5, sr=48000, ch=2, fmt="AIFF", subtype="PCM_24")
    _, staged, rejected = st.create([("a.aif", data)])
    assert not rejected
    info = sf.info(staged[0].source)
    assert (info.format, info.samplerate, info.channels, info.subtype) == ("WAV", 48000, 2, "PCM_24")
    assert staged[0].original.read_bytes() == data
    assert staged[0].original.suffix == ".aif"


def test_aiff_s8_maps_to_pcm16(tmp_path):
    st = Staging(tmp_path / "stage")
    data = wav(0.1, sr=8000, fmt="AIFF", subtype="PCM_S8")
    _, staged, _ = st.create([("a.aiff", data)])
    assert sf.info(staged[0].source).subtype == "PCM_16"


def test_same_name_twice_distinct_tokens(tmp_path):
    st = Staging(tmp_path / "stage")
    _, staged, _ = st.create([("x.wav", wav(0.1)), ("x.wav", wav(0.2))])
    assert len({s.token for s in staged}) == 2
    assert len({s.original for s in staged}) == 2


def test_dotfile_and_path_names(tmp_path):
    st = Staging(tmp_path / "stage")
    _, staged, rejected = st.create([(".wav", wav(0.1)), ("../../evil/k.wav", wav(0.1)), ("", b"x")])
    assert [s.filename for s in staged] == ["k.wav"]
    assert {r for _, r in rejected} == {"invalid filename"}
    assert str(staged[0].original).startswith(str(tmp_path / "stage"))


def test_discard_and_purge(tmp_path):
    root = tmp_path / "stage"
    st = Staging(root)
    b1, s1, _ = st.create([("a.wav", wav(0.1))])
    b2, s2, _ = st.create([("b.wav", wav(0.1))])
    st.discard(b1)
    assert not s1[0].original.exists() and not (root / b1).exists()
    st.discard(b1)  # idempotent
    with pytest.raises(KeyError):
        st.get(b1, s1[0].token)
    assert s2[0].source.exists()
    Staging(root).purge()  # leftovers from a previous run
    assert not s2[0].source.exists()
    assert root.exists() and list(root.iterdir()) == []


def test_unknown_token_keyerror(tmp_path):
    st = Staging(tmp_path / "stage")
    b, s, _ = st.create([("a.wav", wav(0.1))])
    with pytest.raises(KeyError):
        st.get(b, "nope")
    with pytest.raises(KeyError):
        st.get("nobatch", s[0].token)


def test_long_file_fast(tmp_path):
    st = Staging(tmp_path / "stage")
    data = wav(300, sr=48000, ch=2)
    t = time.perf_counter()
    _, staged, _ = st.create([("long.wav", data)])
    assert time.perf_counter() - t < 3
    assert staged[0].duration == pytest.approx(300.0)


def test_staging_dir_not_under_roots():
    for root in config.ROOTS.values():
        assert not config.STAGING_DIR.is_relative_to(root.expanduser())
