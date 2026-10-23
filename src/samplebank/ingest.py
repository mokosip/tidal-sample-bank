import io
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath

import soundfile as sf

from . import config
from .library import bank_names

_CONVERTIBLE = {"mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "wma"}
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
                ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-c:a", "pcm_s16le", str(dst)],
                capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("conversion timed out")
        except FileNotFoundError:
            raise RuntimeError("ffmpeg not installed")
        if r.returncode != 0 or not dst.exists():
            raise RuntimeError("not a decodable audio file")
        return dst.read_bytes()


def _check_frames(data: bytes, unreadable: str) -> None:
    """SuperDirt skips 0-frame files, which would shift every later n."""
    try:
        frames = sf.info(io.BytesIO(data)).frames
    except Exception:
        raise RuntimeError(unreadable)
    if frames == 0:
        raise RuntimeError("no audio frames")


_BROWSER_WAV = {"PCM_16", "PCM_24", "PCM_32", "PCM_U8", "FLOAT"}
_WAV_SUBTYPES = {"PCM_16", "PCM_24", "PCM_32", "FLOAT", "DOUBLE"}


def _aiff_to_wav(data: bytes) -> bytes:
    try:
        info = sf.info(io.BytesIO(data))
        audio, sr = sf.read(io.BytesIO(data), dtype="float64", always_2d=True)
    except Exception:
        raise RuntimeError("not a readable audio file")
    subtype = info.subtype if info.subtype in _WAV_SUBTYPES else "PCM_16"
    out = io.BytesIO()
    sf.write(out, audio, sr, format="WAV", subtype=subtype)
    return out.getvalue()


def decode_to_wav(filename: str, data: bytes) -> bytes:
    """WAV bytes for any supported upload; same rejection reasons as ingest()."""
    ext = _basename(filename).rpartition(".")[2].lower()
    if ext == "wav":
        _check_frames(data, "not a readable audio file")
        info = sf.info(io.BytesIO(data))
        if info.format == "WAV" and info.subtype in _BROWSER_WAV:
            return data
        return _aiff_to_wav(data)  # a .wav the browser can't decode (ADPCM, really AIFF …)
    if ext in config.EXTS:
        _check_frames(data, "not a readable audio file")
        return _aiff_to_wav(data)
    if ext in _CONVERTIBLE:
        out = _convert(data, ext)
        _check_frames(out, "not a decodable audio file")
        return out
    raise RuntimeError("unsupported file type")


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
                _check_frames(data, "not a readable audio file")
                out = data
            elif ext_l in _CONVERTIBLE:
                out = _convert(data, ext_l)
                _check_frames(out, "not a decodable audio file")
                ext_l = "wav"
            else:
                raise RuntimeError("unsupported file type")
            final = _free_name(folder, stem, ext_l if ext_l == "wav" else ext)
            (folder / final).write_bytes(out)
        except (RuntimeError, OSError, ValueError) as e:
            res.rejected.append((base, str(e)))
            continue
        res.added.append(final)
    return res
