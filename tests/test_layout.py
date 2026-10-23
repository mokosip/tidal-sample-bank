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
