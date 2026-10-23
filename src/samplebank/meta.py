import json
import os
from pathlib import Path

from . import config


class MetaStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _load(self) -> dict:
        try:
            return json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}

    def get(self, id: str) -> dict:
        return self._load().get(id, {})

    def update(self, id: str, *, type: str | None = None, tags: list[str] | None = None,
               star: bool | None = None) -> dict:
        if type is not None and type not in config.TYPES:
            raise ValueError(f"unknown type: {type!r}")
        data = self._load()
        entry = data.get(id, {})
        if type is not None:
            entry["type"] = type
        if tags is not None:
            entry["tags"] = list(dict.fromkeys(t.strip().lower() for t in tags if t.strip()))
        if star is not None:
            entry["star"] = star
        data[id] = entry
        self._save(data)
        return entry

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
        os.replace(tmp, self.path)
