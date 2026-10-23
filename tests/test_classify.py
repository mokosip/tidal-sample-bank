import pytest

from samplebank.analysis import Features
from samplebank.classify import guess_type


def feat(duration=1.0, rms=0.1, centroid=1000.0, attack=0.1, vector=None, peaks=None):
    return Features(
        duration=duration, rms=rms, centroid=centroid, attack=attack,
        vector=vector or [], peaks=peaks or [],
    )


@pytest.mark.parametrize("bank,expected", [
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
    ("busy", "other"), ("snow", "other"), ("shoe", "other"),
])
def test_name_rules(bank, expected):
    assert guess_type(bank, None) == expected


def test_audio_fallback():
    assert guess_type("zzz", feat(duration=6.0)) == "texture"
    assert guess_type("zzz", feat(duration=0.3, centroid=6000)) == "hat"
    assert guess_type("zzz", feat(duration=0.4, centroid=150)) == "kick"
    assert guess_type("zzz", None) == "other"
