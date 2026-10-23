import os

import pytest

from samplebank import config
from samplebank.analysis import Features
from samplebank.classify import guess_type


def feat(duration=1.0, rms=0.1, centroid=1000.0, attack=0.1, vector=None, peaks=None):
    return Features(
        duration=duration, rms=rms, centroid=centroid, attack=attack,
        vector=vector or [], peaks=peaks or [],
    )


NAME_CASES = [
    ("bd", "kick"), ("808bd", "kick"), ("clubkick", "kick"), ("hardkick", "kick"),
    ("sn", "snare"), ("cp", "snare"), ("realclaps", "snare"),
    ("hh27", "hat"), ("hh", "hat"), ("linnhats", "hat"), ("ho", "hat"),
    ("jvbass", "bass"), ("bass3", "bass"), ("bassdm", "bass"),
    ("tabla", "perc"), ("conga", "perc"), ("perc", "perc"),
    ("breaks125", "loop"), ("amencutup", "loop"),
    ("numbers", "voice"), ("speakspell", "voice"),
    ("arpy", "tonal"), ("superpiano", "tonal"),
    ("nature", "texture"), ("birds", "texture"), ("wind", "texture"),
    ("bassdm", "bass"), ("808sd", "snare"), ("808cy", "hat"), ("808mt", "perc"),
    ("speech", "voice"), ("moog", "tonal"), ("cb", "perc"),
    ("invaders", "fx"), ("cosmicg", "fx"), ("tacscan", "fx"), ("space", "fx"), ("subroc3d", "fx"),
    ("incoming", "fx"), ("bleep", "fx"), ("blip", "fx"), ("feelfx", "fx"),
    ("dr", "perc"), ("dr_few", "perc"), ("dr2", "perc"), ("dr55", "perc"), ("gretsch", "perc"),
    ("stab", "tonal"),
    ("busy", "other"), ("snow", "other"), ("shoe", "other"),
]


@pytest.mark.parametrize("bank,expected", NAME_CASES)
def test_name_rules(bank, expected):
    assert guess_type(bank, None) == expected


def test_audio_fallback():
    assert guess_type("zzz", feat(duration=6.0)) == "texture"
    assert guess_type("zzz", feat(duration=0.3, centroid=6000)) == "hat"
    assert guess_type("zzz", feat(duration=0.4, centroid=150)) == "kick"
    assert guess_type("zzz", None) == "other"


def test_audio_perc_and_boundaries():
    assert guess_type("zzz", feat(duration=0.5, centroid=1500, attack=0.005)) == "perc"
    assert guess_type("zzz", feat(duration=0.5, centroid=1500, attack=0.1)) == "other"
    assert guess_type("zzz", feat(duration=2.0, centroid=1500, attack=0.1)) != "texture"
    assert guess_type("zzz", feat(duration=0.5, centroid=4000, attack=0.1)) != "hat"
    assert guess_type("zzz", feat(duration=0.5, centroid=300, attack=0.1)) != "kick"


def test_results_always_in_types():
    names = [b for b, _ in NAME_CASES] + ["zzz"]
    dirt = config.ROOTS["dirt"]
    if not dirt.is_dir():
        pytest.skip("Dirt-Samples not present")
    names += [n for n in os.listdir(dirt) if (dirt / n).is_dir()]
    for n in names:
        assert guess_type(n, None) in config.TYPES, n
        for f in (feat(), feat(duration=6.0), feat(centroid=6000), feat(centroid=100), feat(attack=0.001)):
            assert guess_type(n, f) in config.TYPES, n
