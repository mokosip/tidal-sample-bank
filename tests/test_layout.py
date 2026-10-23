import numpy as np

from samplebank.layout import layout, place_new

DIM = 29


def _clusters(n=30, seed=0):
    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, 1.0, (n, DIM))
    sine = rng.normal(0.0, 0.05, (n, DIM)) + 8.0
    return noise, sine


def _ids_vectors():
    noise, sine = _clusters()
    ids = [f"n{i}" for i in range(len(noise))] + [f"s{i}" for i in range(len(sine))]
    return ids, np.vstack([noise, sine])


def test_clusters_separate():
    ids, vectors = _ids_vectors()
    pos = layout(ids, vectors)
    a = np.array([pos[i] for i in ids if i.startswith("n")])
    b = np.array([pos[i] for i in ids if i.startswith("s")])
    ca, cb = a.mean(axis=0), b.mean(axis=0)
    intra = np.mean([np.linalg.norm(a - ca, axis=1).mean(), np.linalg.norm(b - cb, axis=1).mean()])
    assert intra < np.linalg.norm(ca - cb)


def test_coords_in_unit_square_and_finite():
    ids, vectors = _ids_vectors()
    xy = np.array(list(layout(ids, vectors).values()))
    assert xy.shape == (60, 2)
    assert np.isfinite(xy).all()
    assert xy.min() >= 0.0 and xy.max() <= 1.0


def test_tiny_input_uses_pca():
    rng = np.random.default_rng(1)
    pos = layout([f"a{i}" for i in range(5)], rng.normal(size=(5, DIM)))
    assert len(pos) == 5
    assert np.isfinite(np.array(list(pos.values()))).all()


def test_empty_and_single():
    assert layout([], np.zeros((0, DIM))) == {}
    pos = layout(["a"], np.ones((1, DIM)))
    assert pos["a"] == (0.5, 0.5)


def test_place_new_near_neighbours():
    ids, vectors = _ids_vectors()
    pos = layout(ids, vectors)
    known_vectors = dict(zip(ids, vectors))
    new = vectors[40] + 0.01  # near the sine cluster
    x, y = place_new(new, pos, known_vectors)
    sine = np.array([pos[i] for i in ids if i.startswith("s")])
    noise = np.array([pos[i] for i in ids if i.startswith("n")])
    d_sine = np.linalg.norm(sine.mean(axis=0) - (x, y))
    d_noise = np.linalg.norm(noise.mean(axis=0) - (x, y))
    assert d_sine < d_noise


def test_deterministic():
    ids, vectors = _ids_vectors()
    assert layout(ids, vectors) == layout(ids, vectors)


def _strict(fn, *args):
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        return fn(*args)


def _assert_unit_finite(pos, n):
    assert len(pos) == n
    xy = np.array(list(pos.values()))
    assert np.isfinite(xy).all()
    assert xy.min() >= 0.0 and xy.max() <= 1.0


def test_two_samples():
    rng = np.random.default_rng(2)
    _assert_unit_finite(_strict(layout, ["a", "b"], rng.normal(size=(2, DIM))), 2)


import pytest  # noqa: E402


@pytest.mark.parametrize("n", [5, 30])
def test_identical_vectors_pca_and_umap_paths(n):
    pos = _strict(layout, [f"i{k}" for k in range(n)], np.full((n, DIM), 3.0))
    _assert_unit_finite(pos, n)


def test_zero_variance_column():
    rng = np.random.default_rng(3)
    vectors = rng.normal(size=(30, DIM))
    vectors[:, 4] = 7.0
    _assert_unit_finite(_strict(layout, [f"z{k}" for k in range(30)], vectors), 30)


def test_place_new_fewer_than_five_known():
    rng = np.random.default_rng(4)
    known_vectors = {f"k{i}": rng.normal(size=DIM) for i in range(3)}
    known = {"k0": (0.0, 0.0), "k1": (1.0, 0.0), "k2": (0.0, 1.0)}
    x, y = _strict(place_new, rng.normal(size=DIM), known, known_vectors)
    assert np.isfinite([x, y]).all() and 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0


def test_place_new_empty_known():
    assert _strict(place_new, np.zeros(DIM), {}, {}) == (0.5, 0.5)


def test_place_new_measures_distance_in_scaled_space():
    rng = np.random.default_rng(5)
    # feature 0: huge scale, uninformative per group offsets; feature 1: tiny scale, separates groups
    a = np.zeros((20, 2)); b = np.zeros((20, 2))
    a[:, 0] = rng.uniform(400, 500, 20); a[:, 1] = 0.0
    b[:, 0] = rng.uniform(-50, 50, 20); b[:, 1] = 0.001
    vecs = {f"a{i}": a[i] for i in range(20)} | {f"b{i}": b[i] for i in range(20)}
    known = {k: ((0.1, 0.1) if k[0] == "a" else (0.9, 0.9)) for k in vecs}
    query = np.array([450.0, 0.001])  # unscaled: near group a; scaled: near group b
    raw = sorted(vecs, key=lambda k: np.linalg.norm(vecs[k] - query))[:5]
    assert all(k[0] == "a" for k in raw)
    x, y = place_new(query, known, vecs)
    assert x > 0.5 and y > 0.5
