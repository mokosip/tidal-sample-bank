import json
import os
import tempfile
import threading
from pathlib import Path

from . import config


_LOCK = threading.Lock()


class MetaCorruptError(Exception):
    pass


class MetaStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _load(self) -> dict:
        try:
            return json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}
        except json.JSONDecodeError as e:
            raise MetaCorruptError(f"metadata file is corrupt: {self.path} ({e})") from e

    def get(self, id: str) -> dict:
        return self._load().get(id, {})

    def update(self, id: str, *, type: str | None = None, tags: list[str] | None = None,
               star: bool | None = None) -> dict:
        if type is not None and type not in config.TYPES:
            raise ValueError(f"unknown type: {type!r}")
        with _LOCK:
            data = self._load()
            entry = data.get(id, {})
            self._apply(entry, type, tags, star)
            data[id] = entry
            self._save(data)
        return entry

    @staticmethod
    def _apply(entry, type, tags, star) -> None:
        if type is not None:
            entry["type"] = type
        if tags is not None:
            entry["tags"] = list(dict.fromkeys(t.strip().lower() for t in tags if t.strip()))
        if star is not None:
            entry["star"] = star

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=2, sort_keys=True)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
