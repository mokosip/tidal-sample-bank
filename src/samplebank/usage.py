import os
import re
from collections import Counter
from pathlib import Path

_SKIP = {"node_modules", ".superpowers"}
_STRING = re.compile(r'\b(?:s|sound)\s+"([^"]*)"')
_SPLIT = re.compile(r"[\s\[\]<>{}(),*!~|?@/.]+")
_NAME = re.compile(r"^[a-z0-9]\w*$")
_DIGITS = re.compile(r"^\d+$")


def bank_usage(tidal_dir: Path) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for root, dirs, files in os.walk(tidal_dir):
        dirs[:] = [d for d in dirs if d not in _SKIP]
        for f in files:
            if not f.endswith(".tidal"):
                continue
            try:
                text = (Path(root) / f).read_text(errors="replace")
            except OSError:
                continue
            for m in _STRING.finditer(text):
                for tok in _SPLIT.split(m.group(1)):
                    name, colon, _ = tok.partition(":")
                    # a pure-digit name is a bank only when it carries a ":n" index
                    if _NAME.match(name) and (colon or not _DIGITS.match(name)):
                        counts[name] += 1
    return dict(counts)
