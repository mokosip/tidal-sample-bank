"""HTTP API wiring all backend modules together."""

import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from . import config
from .analysis import AnalysisCache, Features
from .classify import guess_type
from .dirt import Dirt
from .ingest import check_bank, ingest, normalize_bank
from .layout import layout as compute_layout
from .layout import place_new
from .library import Sample, scan
from .meta import MetaCorruptError, MetaStore
from .usage import bank_usage

log = logging.getLogger(__name__)
STATIC = Path(__file__).parent / "static"


class PatchBody(BaseModel):
    type: str | None = None
    tags: list[str] | None = None
    star: bool | None = None


class PlayBody(BaseModel):
    id: str


class State:
    """Mutable server state; every access goes through `lock`."""

    def __init__(self, roots, meta_path, cache_path, tidal_dir, dirt):
        self.roots = roots
        self.tidal_dir = tidal_dir
        self.meta = MetaStore(meta_path)
        self.cache = AnalysisCache(cache_path)
        self.dirt = dirt
        self.lock = threading.RLock()
        self.samples: dict[str, Sample] = {}
        self.features: dict[str, Features] = {}
        self.analysing = False
        self._rebuild = threading.Lock()  # single-flight guard for full layouts

    def rescan(self) -> None:
        found = scan(self.roots)
        with self.lock:
            self.samples = {s.id: s for s in found}

    def analyse_all(self) -> None:
        with self.lock:
            todo = list(self.samples.values())
        for s in todo:
            f = self.cache.get_or_compute(s)
            if f is not None:
                with self.lock:
                    self.features[s.id] = f
        self.cache.save()
        self.ensure_layout()

    def full_layout(self) -> bool:
        """Recompute the whole map. Returns False if another rebuild is already running."""
        if not self._rebuild.acquire(blocking=False):
            return False
        try:
            with self.lock:
                ids = [i for i in self.samples if i in self.features]
                vectors = np.array([self.features[i].vector for i in ids], dtype=float)
            if not ids:
                return True
            xy = compute_layout(ids, vectors)
            with self.lock:
                new = {i: [x, y] for i, (x, y) in xy.items()}
                # samples analysed/placed while we were computing keep a position
                late = [i for i in self.features if i not in new]
                if late:
                    known = {i: (x, y) for i, (x, y) in xy.items()}
                    known_vectors = {i: np.array(self.features[i].vector) for i in known}
                    for i in late:
                        p = place_new(np.array(self.features[i].vector), known, known_vectors)
                        new[i] = [p[0], p[1]]
                self.cache.layout = new
                self.cache.save()
            return True
        finally:
            self._rebuild.release()

    def ensure_layout(self) -> None:
        with self.lock:
            covered = all(i in self.cache.layout for i in self.features)
        if not covered:
            self.full_layout()


def create_app(roots=None, meta_path=None, cache_path=None, tidal_dir=None, dirt=None,
               background: bool = True) -> FastAPI:
    st = State(
        roots if roots is not None else config.ROOTS,
        meta_path if meta_path is not None else config.META_PATH,
        cache_path if cache_path is not None else config.CACHE_PATH,
        tidal_dir if tidal_dir is not None else config.TIDAL_DIR,
        dirt if dirt is not None else Dirt(),
    )
    st.rescan()

    def startup_analysis() -> None:
        try:
            st.analyse_all()
        except Exception:
            log.exception("startup analysis failed")
        finally:
            st.analysing = False

    st.analysing = True
    if background:
        threading.Thread(target=startup_analysis, daemon=True).start()
    else:
        startup_analysis()

    @asynccontextmanager
    async def lifespan(app):
        yield
        st.dirt.close()

    app = FastAPI(lifespan=lifespan)
    app.state.st = st

    @app.exception_handler(MetaCorruptError)
    async def _meta_corrupt(request, exc):
        return JSONResponse({"error": str(exc)}, status_code=500)

    def view(s: Sample, meta: dict, usage: dict[str, int]) -> dict:
        f = st.features.get(s.id)
        auto = guess_type(s.bank, f)
        xy = st.cache.layout.get(s.id)
        return {
            "id": s.id, "source": s.source, "bank": s.bank, "n": s.n, "filename": s.filename,
            "type": meta.get("type", auto), "type_auto": auto,
            "tags": meta.get("tags", []), "star": meta.get("star", False),
            "duration": f.duration if f else None, "peaks": f.peaks if f else None,
            "x": xy[0] if xy else None, "y": xy[1] if xy else None,
            "used": usage.get(s.bank, 0),
        }

    @app.get("/api/samples")
    def list_samples():
        meta = st.meta._load()  # one file read instead of one per sample
        usage = bank_usage(st.tidal_dir)
        with st.lock:
            return [view(s, meta.get(s.id, {}), usage) for s in st.samples.values()]

    @app.patch("/api/samples/{id:path}")
    def patch_sample(id: str, body: PatchBody):
        with st.lock:
            s = st.samples.get(id)
        if s is None:
            return JSONResponse({"error": f"unknown sample: {id}"}, status_code=404)
        try:
            meta = st.meta.update(id, type=body.type, tags=body.tags, star=body.star)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        with st.lock:
            return view(s, meta, bank_usage(st.tidal_dir))

    @app.post("/api/play", status_code=204)
    def play(body: PlayBody):
        with st.lock:
            s = st.samples.get(body.id)
        if s is None:
            return JSONResponse({"error": f"unknown sample: {body.id}"}, status_code=404)
        st.dirt.play(s.bank, s.n)
        return Response(status_code=204)

    @app.get("/api/status")
    def status():
        return {"dirt": st.dirt.hello(), "samples": len(st.samples), "analysing": st.analysing}

    @app.post("/api/upload")
    async def upload(request: Request):
        form = await request.form()
        bank_raw = form.get("bank")
        uploads = [v for k, v in form.multi_items()
                   if k in ("files", "files[]") and hasattr(v, "read")]
        files = [(u.filename or "", await u.read()) for u in uploads]
        if not isinstance(bank_raw, str):
            return JSONResponse({"error": "missing bank name"}, status_code=400)
        return await run_in_threadpool(_upload, bank_raw, files)

    def _upload(bank_raw: str, files: list[tuple[str, bytes]]):
        try:
            bank = normalize_bank(bank_raw)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        ok, suggestion = check_bank(bank, st.roots)
        if not ok:
            return JSONResponse(
                {"error": f"bank name {bank!r} clashes with an existing Dirt/dub bank",
                 "suggestion": suggestion}, status_code=409)
        res = ingest(files, bank, st.roots)
        st.rescan()
        new_ids = [f"own/{bank}/{name}" for name in res.added]
        new = [st.samples[i] for i in new_ids if i in st.samples]
        for s in new:
            f = st.cache.get_or_compute(s)
            if f is not None:
                with st.lock:
                    st.features[s.id] = f
        with st.lock:
            known = {i: tuple(xy) for i, xy in st.cache.layout.items() if i in st.features}
            known_vectors = {i: np.array(st.features[i].vector) for i in known}
            for s in new:
                if s.id in st.features:
                    xy = place_new(np.array(st.features[s.id].vector), known, known_vectors)
                    st.cache.layout[s.id] = [xy[0], xy[1]]
            st.cache.save()
        loaded = st.dirt.load_bank(st.roots["own"] / bank, bank) if res.added else None
        return {"bank": bank, "added": res.added, "rejected": [list(r) for r in res.rejected],
                "loaded": loaded}

    @app.post("/api/rebuild-map", status_code=202)
    def rebuild_map():
        def run():
            try:
                st.full_layout()
            except Exception:
                log.exception("map rebuild failed")
        if not st._rebuild.locked():
            threading.Thread(target=run, daemon=True).start()
        return Response(status_code=202)

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
