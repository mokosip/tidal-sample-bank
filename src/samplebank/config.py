import os
from pathlib import Path

TIDAL_DIR = Path(os.environ.get("SAMPLEBANK_TIDAL_DIR", "~/tidal")).expanduser()

_DEFAULT_ROOTS = {
    "dirt": "~/Library/Application Support/SuperCollider/downloaded-quarks/Dirt-Samples",
    "dub": str(TIDAL_DIR / "dub" / "sounds"),
    "own": str(TIDAL_DIR / "samples"),
}

ROOTS: dict[str, Path] = {
    k: Path(os.environ.get(f"SAMPLEBANK_ROOT_{k.upper()}", v)).expanduser()
    for k, v in _DEFAULT_ROOTS.items()
}

EXTS = {"wav", "aif", "aiff", "aifc"}

META_PATH = Path(
    os.environ.get("SAMPLEBANK_META_PATH", ROOTS["own"] / "samplebank.json")
).expanduser()
CACHE_PATH = Path(
    os.environ.get("SAMPLEBANK_CACHE_PATH", ROOTS["own"] / ".samplebank-cache.json")
).expanduser()

DIRT_ADDR = ("127.0.0.1", 57120)
PORT = 57150

TYPES = ("kick", "snare", "hat", "perc", "bass", "tonal", "voice", "texture", "loop", "fx", "other")
