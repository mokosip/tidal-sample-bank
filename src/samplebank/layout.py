"""2D sound-map layout: similar feature vectors land close together. Pure, no file I/O."""

import warnings

import numpy as np
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

MIN_UMAP_SAMPLES = 20
N_NEIGHBOURS_NEW = 5


def _to_unit_square(xy: np.ndarray) -> np.ndarray:
    xy = np.nan_to_num(np.asarray(xy, dtype=float))
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    span = hi - lo
    out = np.full_like(xy, 0.5)
    ok = span > 1e-12
    out[:, ok] = (xy[:, ok] - lo[ok]) / span[ok]
    return np.clip(out, 0.0, 1.0)


def layout(ids: list[str], vectors: np.ndarray) -> dict[str, tuple[float, float]]:
    n = len(ids)
    if n == 0:
        return {}
    if n == 1:
        return {ids[0]: (0.5, 0.5)}
    scaled = StandardScaler().fit_transform(np.asarray(vectors, dtype=float))
    if not np.any(np.ptp(scaled, axis=0) > 1e-12):
        return {i: (0.5, 0.5) for i in ids}  # all vectors identical: nothing to separate
    if n < MIN_UMAP_SAMPLES:
        xy = PCA(n_components=2, random_state=42).fit_transform(scaled)
    else:
        import umap

        with warnings.catch_warnings():
            # known: random_state forces n_jobs=1 (reproducibility), and says so
            warnings.filterwarnings("ignore", message=".*n_jobs.*")
            xy = umap.UMAP(
                n_components=2, n_neighbors=15, min_dist=0.1, random_state=42
            ).fit_transform(scaled)
    xy = _to_unit_square(xy)
    return {i: (float(x), float(y)) for i, (x, y) in zip(ids, xy)}


def place_new(
    vector: np.ndarray,
    known: dict[str, tuple],
    known_vectors: dict[str, np.ndarray],
) -> tuple[float, float]:
    """Mean map position of the 5 nearest known samples in scaled feature space."""
    keys = [k for k in known if k in known_vectors]
    if not keys:
        return (0.5, 0.5)
    matrix = np.array([known_vectors[k] for k in keys], dtype=float)
    scaler = StandardScaler().fit(matrix)
    dist = np.linalg.norm(scaler.transform(matrix) - scaler.transform([np.asarray(vector, float)]), axis=1)
    nearest = np.argsort(dist, kind="stable")[:N_NEIGHBOURS_NEW]
    xy = np.array([known[keys[i]] for i in nearest], dtype=float).mean(axis=0)
    return (float(xy[0]), float(xy[1]))
