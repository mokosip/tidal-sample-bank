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


def test_concurrent_updates_not_lost(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    p = tmp_path / "meta.json"
    m = MetaStore(p)
    with ThreadPoolExecutor(20) as ex:
        list(ex.map(lambda i: m.update(f"id{i}", star=True), range(20)))
    data = MetaStore(p)
    assert all(data.get(f"id{i}") == {"star": True} for i in range(20))


def test_corrupt_file_raises_and_is_preserved(tmp_path):
    from samplebank.meta import MetaCorruptError

    p = tmp_path / "meta.json"
    p.write_text("{not json")
    m = MetaStore(p)
    with pytest.raises(MetaCorruptError, match="meta.json"):
        m.get("x")
    with pytest.raises(MetaCorruptError):
        m.update("x", star=True)
    assert p.read_text() == "{not json"
