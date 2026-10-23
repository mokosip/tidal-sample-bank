import pytest

from samplebank.meta import MetaStore


def test_update_persists_across_instances(tmp_path):
    p = tmp_path / "meta.json"
    MetaStore(p).update("own/bd/a.wav", star=True, tags=["dark"])
    assert MetaStore(p).get("own/bd/a.wav") == {"star": True, "tags": ["dark"]}


def test_unknown_type_rejected(tmp_path):
    with pytest.raises(ValueError):
        MetaStore(tmp_path / "meta.json").update("x", type="drums")


def test_missing_file_is_empty(tmp_path):
    assert MetaStore(tmp_path / "nope.json").get("x") == {}


def test_tags_normalized(tmp_path):
    m = MetaStore(tmp_path / "meta.json")
    assert m.update("x", tags=["  Dark", "dark"])["tags"] == ["dark"]
