import pytest

from samplebank import config


@pytest.fixture(autouse=True)
def _tmp_staging(tmp_path, monkeypatch):
    """Never let a test app purge the real staging dir."""
    monkeypatch.setattr(config, "STAGING_DIR", tmp_path / "staging-default")
