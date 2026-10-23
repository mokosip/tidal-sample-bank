import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath

from . import config
from .library import bank_names

_VALID = re.compile(r"^[a-z][a-z0-9_]*$")


@dataclass
class IngestResult:
    added: list[str] = field(default_factory=list)
    rejected: list[tuple[str, str]] = field(default_factory=list)


def normalize_bank(name: str) -> str:
    out = re.sub(r"[\s\-]+", "_", name.strip().lower())
    if not _VALID.match(out):
        raise ValueError(f"invalid bank name: {name!r}")
    return out


def _taken(name: str, roots) -> bool:
    return name in bank_names(roots, "dirt") or name in bank_names(roots, "dub")


def check_bank(name: str, roots) -> tuple[bool, str | None]:
    if not _taken(name, roots):
        return True, None
    candidate = f"{name}_mine"
    i = 2
    while _taken(candidate, roots):
        candidate = f"{name}_mine{i}"
        i += 1
    return False, candidate


def _basename(filename: str) -> str:
    return PurePosixPath(PureWindowsPath(filename).as_posix()).name


def _convert(data: bytes, ext: str) -> bytes:
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / f"in.{ext}"
        dst = Path(td) / "out.wav"
        src.write_bytes(data)
        try:
            r = subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-c:a", "pcm_s16le", str(dst)],
                capture_output=True, text=True,
            )
        except FileNotFoundError:
            raise RuntimeError("ffmpeg not installed")
        if r.returncode != 0 or not dst.exists():
            raise RuntimeError("not a decodable audio file")
        return dst.read_bytes()


def _free_name(folder: Path, stem: str, ext: str) -> str:
    name = f"{stem}.{ext}"
    i = 2
    while (folder / name).exists():
        name = f"{stem}_{i}.{ext}"
        i += 1
    return name


def ingest(files: list[tuple[str, bytes]], bank: str, roots) -> IngestResult:
    bank = normalize_bank(bank)
    ok, _ = check_bank(bank, roots)
    if not ok:
        raise ValueError(f"bank name {bank!r} clashes with an existing Dirt/dub bank")
    folder = roots["own"] / bank
    folder.mkdir(parents=True, exist_ok=True)
    res = IngestResult()
    for filename, data in files:
        base = _basename(filename)
        if not base or base in {".", ".."}:
            res.rejected.append((filename, "invalid filename"))
            continue
        if not data:
            res.rejected.append((base, "empty file"))
            continue
        stem, dot, ext = base.rpartition(".")
        if not dot or not stem:
            res.rejected.append((base, "unsupported file type"))
            continue
        ext_l = ext.lower()
        try:
            if ext_l in config.EXTS:
                out = data
            else:
                out = _convert(data, ext_l)
                ext_l = "wav"
        except RuntimeError as e:
            res.rejected.append((base, str(e)))
            continue
        final = _free_name(folder, stem, ext_l if ext_l == "wav" or ext.lower() != ext_l else ext)
        (folder / final).write_bytes(out)
        res.added.append(final)
    return res
