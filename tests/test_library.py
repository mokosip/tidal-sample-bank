from samplebank.library import scan


def test_n_follows_sc_sort_and_skips_non_audio(tmp_path):
    b = tmp_path / "dirt" / "kit"; b.mkdir(parents=True)
    for f in ["b.wav", "A.WAV", ".DS_Store", "notes.txt", "a b.aif", "ä.wav"]:
        (b / f).write_bytes(b"x")
    s = scan({"dirt": tmp_path / "dirt"})
    assert [(x.filename, x.n) for x in s] == [("A.WAV", 0), ("a b.aif", 1), ("b.wav", 2), ("ä.wav", 3)]
    assert s[0].id == "dirt/kit/A.WAV"


def test_files_in_root_and_missing_roots_ignored(tmp_path):
    (tmp_path / "own").mkdir(); (tmp_path / "own" / "samplebank.json").write_text("{}")
    assert scan({"own": tmp_path / "own", "dub": tmp_path / "nope"}) == []
