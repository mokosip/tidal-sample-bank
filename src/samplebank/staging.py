import io
import secrets
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

from .ingest import _basename, decode_to_wav

_MARKER = ".samplebank-staging"


@dataclass
class StagedFile:
    token: str
    filename: str
    duration: float
    original: Path  # uploaded bytes, for "keep whole file"
    source: Path  # decoded WAV that the browser loops and the server cuts


class Staging:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._lock = threading.Lock()
        self._files: dict[tuple[str, str], StagedFile] = {}

    def _ensure_root(self) -> None:
        """Only ever manage a dir that is ours: marker present, or new/empty."""
        root = self.root
        if root.is_symlink():
            raise RuntimeError(f"refusing to use staging dir {root}: it is a symlink")
        marker = root / _MARKER
        if root.exists() and not marker.exists() and any(root.iterdir()):
            raise RuntimeError(
                f"refusing to use staging dir {root}: not empty and has no {_MARKER} marker "
                "(check SAMPLEBANK_STAGING_DIR)"
            )
        root.mkdir(parents=True, exist_ok=True)
        marker.touch()

    def purge(self) -> None:
        with self._lock:
            self._ensure_root()
            for p in self.root.iterdir():
                if p.name == _MARKER:
                    continue
                if p.is_dir() and not p.is_symlink():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink(missing_ok=True)
            self._files.clear()

    def create(self, files: list[tuple[str, bytes]]):
        batch = secrets.token_hex(8)
        staged: list[StagedFile] = []
        rejected: list[tuple[str, str]] = []
        with self._lock:
            self._ensure_root()
            for filename, data in files:
                base = _basename(filename)
                if not base or base.startswith("."):
                    rejected.append((filename, "invalid filename"))
                    continue
                if not data:
                    rejected.append((base, "empty file"))
                    continue
                try:
                    wav = decode_to_wav(base, data)
                    duration = _duration(wav)
                    token = secrets.token_hex(8)
                    d = self.root / batch / token
                    d.mkdir(parents=True)
                    ext = base.rpartition(".")[2].lower()
                    original, source = d / f"original.{ext}", d / "source.wav"
                    original.write_bytes(data)
                    source.write_bytes(wav)
                except (RuntimeError, OSError, ValueError) as e:
                    rejected.append((base, str(e)))
                    continue
                sf_ = StagedFile(token, base, duration, original, source)
                self._files[(batch, token)] = sf_
                staged.append(sf_)
        return batch, staged, rejected

    def get(self, batch: str, token: str) -> StagedFile:
        with self._lock:
            return self._files[(batch, token)]

    def discard(self, batch: str) -> None:
        with self._lock:
            for key in [k for k in self._files if k[0] == batch]:
                del self._files[key]
            if batch and "/" not in batch and "\\" not in batch and not batch.startswith("."):
                shutil.rmtree(self.root / batch, ignore_errors=True)


def _duration(wav: bytes) -> float:
    info = sf.info(io.BytesIO(wav))
    return info.frames / info.samplerate
