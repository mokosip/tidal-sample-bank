import os
import re
from collections import Counter
from pathlib import Path

_SKIP = {"node_modules", ".superpowers"}
_STRING = re.compile(r'\b(?:s|sound)\s+"([^"]*)"')
_SPLIT = re.compile(r"[\s\[\]<>{}(),*!~|?@/.:]+")
_NAME = re.compile(r"^[a-z]\w*$")


def bank_usage(tidal_dir: Path) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for root, dirs, files in os.walk(tidal_dir):
        dirs[:] = [d for d in dirs if d not in _SKIP]
        for f in files:
            if not f.endswith(".tidal"):
                continue
            text = (Path(root) / f).read_text(errors="replace")
            for m in _STRING.finditer(text):
                counts.update(t for t in _SPLIT.split(m.group(1)) if _NAME.match(t))
    return dict(counts)
