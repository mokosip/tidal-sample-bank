from samplebank.usage import bank_usage


def test_counts_banks_in_mininotation(tmp_path):
    (tmp_path / "a.tidal").write_text('d1 $ s "bd*4 [hh27:3 ~] <arpy sn>" # n 1\nd2 $ sound "hh27(3,8)"\n-- s "cp"')
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "x.tidal").write_text('s "bd"')
    u = bank_usage(tmp_path)
    assert u["bd"] == 1 and u["hh27"] == 2 and u["arpy"] == 1 and u["sn"] == 1
    assert u.get("cp", 0) == 1  # comments count too: they are ideas Moko kept
