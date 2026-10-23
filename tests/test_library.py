from samplebank.library import scan


def test_n_follows_sc_sort_and_skips_non_audio(tmp_path):
    b = tmp_path / "dirt" / "kit"; b.mkdir(parents=True)
    for f in ["b.wav", "A.WAV", "a b.aif", "ä.wav"]:
        _wav(b / f)
    for f in [".DS_Store", "notes.txt"]:
        (b / f).write_bytes(b"x")
    s = scan({"dirt": tmp_path / "dirt"})
    assert [(x.filename, x.n) for x in s] == [("A.WAV", 0), ("a b.aif", 1), ("b.wav", 2), ("ä.wav", 3)]
    assert s[0].id == "dirt/kit/A.WAV"


def test_files_in_root_and_missing_roots_ignored(tmp_path):
    (tmp_path / "own").mkdir(); (tmp_path / "own" / "samplebank.json").write_text("{}")
    assert scan({"own": tmp_path / "own", "dub": tmp_path / "nope"}) == []


def _wav(path, frames=100):
    import numpy as np
    import soundfile as sf

    sf.write(path, np.zeros(frames, dtype="float32"), 44100, format="WAV")


def test_zero_frame_and_unreadable_files_do_not_take_an_n(tmp_path):
    # SuperDirt's extBuffer.sc sets failed = numFrames == 0 and skips the file
    b = tmp_path / "own" / "kit"; b.mkdir(parents=True)
    _wav(b / "a_empty.wav", frames=0)
    (b / "b_garbage.wav").write_bytes(b"not audio")
    _wav(b / "c_ok.wav")
    _wav(b / "d_ok.wav")
    s = scan({"own": tmp_path / "own"})
    assert [(x.filename, x.n) for x in s] == [("c_ok.wav", 0), ("d_ok.wav", 1)]


def test_hidden_files_do_not_take_an_n(tmp_path):
    # SC's `*` glob skips dotfiles; AppleDouble ._a.wav would otherwise shift n
    b = tmp_path / "own" / "kit"; b.mkdir(parents=True)
    _wav(b / "._a.wav")
    _wav(b / "a.wav")
    _wav(b / "b.wav")
    s = scan({"own": tmp_path / "own"})
    assert [(x.filename, x.n) for x in s] == [("a.wav", 0), ("b.wav", 1)]
