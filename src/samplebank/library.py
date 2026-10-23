from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

from . import config


@dataclass(frozen=True)
class Sample:
    id: str
    source: str
    bank: str
    n: int
    path: Path
    filename: str


def _is_audio(name: str) -> bool:
    return name.rsplit(".", 1)[-1].lower() in config.EXTS if "." in name else False


def _loadable(path: Path) -> bool:
    """SuperDirt skips files whose header reports 0 frames (extBuffer.sc: failed = numFrames == 0)
    and files it cannot read at all, so they must not take an n."""
    try:
        return sf.info(str(path)).frames > 0
    except Exception:
        return False


def scan(roots: dict[str, Path]) -> list[Sample]:
    """Index every readable file per bank; n follows SuperDirt's sorted-filename order."""
    samples: list[Sample] = []
    for source, root in roots.items():
        if not root.is_dir():
            continue
        for bank_dir in root.iterdir():
            if not bank_dir.is_dir():
                continue
            names = sorted(p.name for p in bank_dir.iterdir() if p.is_file())
            # SC's `*` glob skips dotfiles (AppleDouble ._foo.wav would shift n)
            audio = [name for name in names
                     if not name.startswith(".") and _is_audio(name) and _loadable(bank_dir / name)]
            for n, name in enumerate(audio):
                samples.append(Sample(
                    id=f"{source}/{bank_dir.name}/{name}",
                    source=source, bank=bank_dir.name, n=n,
                    path=bank_dir / name, filename=name,
                ))
    return sorted(samples, key=lambda s: (s.bank, s.n))


def bank_names(roots: dict[str, Path], source: str) -> set[str]:
    return {s.bank for s in scan({source: roots[source]})} if source in roots else set()
