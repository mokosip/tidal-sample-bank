import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from samplebank.app import create_app


class FakeDirt:
    def __init__(self, up=True, loaded=3):
        self.up, self.loaded = up, loaded
        self.played, self.loads, self.closed = [], [], False

    def play(self, bank, n):
        self.played.append((bank, n))

    def hello(self, timeout=0.5):
        return self.up

    def load_bank(self, path, name, timeout=3.0):
        self.loads.append((path, name))
        return self.loaded if self.up else None

    def close(self):
        self.closed = True


def write_wav(path, freq=440.0, dur=0.3, sr=22050):
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(sr * dur)) / sr
    sf.write(path, 0.5 * np.sin(2 * np.pi * freq * t), sr, subtype="PCM_16")
    return path


@pytest.fixture
def env(tmp_path):
    roots = {k: tmp_path / k for k in ("dirt", "dub", "own")}
    write_wav(roots["dirt"] / "bd" / "a.wav", 80)
    write_wav(roots["dirt"] / "bd" / "b.wav", 60)
    write_wav(roots["dirt"] / "bd" / "c.wav", 70)
    write_wav(roots["dub"] / "pad" / "p.wav", 300)
    tidal = tmp_path / "tidal"
    tidal.mkdir()
    (tidal / "s.tidal").write_text('d1 $ s "bd*2"\n')
    dirt = FakeDirt()
    app = create_app(roots=roots, meta_path=tmp_path / "meta.json", cache_path=tmp_path / "cache.json",
                     tidal_dir=tidal, dirt=dirt, background=False, allowed_hosts={"testserver"})
    return TestClient(app), dirt, roots, tmp_path


def by_id(client):
    return {s["id"]: s for s in client.get("/api/samples").json()}


def test_samples_listing_shape(env):
    client, *_ = env
    s = by_id(client)["dirt/bd/b.wav"]
    assert set(s) == {"id", "source", "bank", "n", "filename", "type", "type_auto", "tags", "star",
                      "duration", "peaks", "x", "y", "used"}
    assert (s["source"], s["bank"], s["n"], s["filename"]) == ("dirt", "bd", 1, "b.wav")
    assert s["type"] == s["type_auto"] == "kick"
    assert s["tags"] == [] and s["star"] is False
    assert s["duration"] == pytest.approx(0.3, abs=0.01) and len(s["peaks"]) == 64
    assert s["used"] == 1
    assert 0 <= s["x"] <= 1 and 0 <= s["y"] <= 1
    assert by_id(client)["dub/pad/p.wav"]["used"] == 0


def test_patch_type_and_star_persist(env):
    client, _, roots, tmp_path = env
    r = client.patch("/api/samples/dirt/bd/a.wav", json={"type": "snare", "star": True, "tags": ["Dry"]})
    assert r.status_code == 200
    body = r.json()
    assert (body["type"], body["type_auto"], body["star"], body["tags"]) == ("snare", "kick", True, ["dry"])
    again = by_id(client)["dirt/bd/a.wav"]
    assert again["type"] == "snare" and again["star"] is True
    assert "snare" in (tmp_path / "meta.json").read_text()


def test_patch_bad_type_400(env):
    client, *_ = env
    assert client.patch("/api/samples/dirt/bd/a.wav", json={"type": "nope"}).status_code == 400


def test_patch_unknown_404(env):
    client, *_ = env
    assert client.patch("/api/samples/dirt/bd/zzz.wav", json={"star": True}).status_code == 404


def test_play_calls_dirt(env):
    client, dirt, *_ = env
    assert client.post("/api/play", json={"id": "dirt/bd/b.wav"}).status_code == 204
    assert dirt.played == [("bd", 1)]
    assert client.post("/api/play", json={"id": "dirt/bd/nope.wav"}).status_code == 404


def test_status_dirt_false_when_unreachable(env):
    client, dirt, *_ = env
    assert client.get("/api/status").json() == {"dirt": True, "samples": 4, "analysing": False, "rebuilding": False}
    dirt.up = False
    assert client.get("/api/status").json()["dirt"] is False


def test_upload_clash_409_with_suggestion(env):
    client, dirt, roots, _ = env
    r = client.post("/api/upload", data={"bank": "bd"}, files=[("files[]", ("x.wav", b"RIFF", "audio/wav"))])
    assert r.status_code == 409
    assert r.json() == {"error": "bank name 'bd' clashes with an existing Dirt/dub bank", "suggestion": "bd_mine"}
    assert not (roots["own"] / "bd").exists()


def test_upload_invalid_bank_400(env):
    client, *_ = env
    r = client.post("/api/upload", data={"bank": "9 !"}, files=[("files[]", ("x.wav", b"RIFF", "audio/wav"))])
    assert r.status_code == 400 and "invalid bank name" in r.json()["error"]


def wav_payload(tmp_path, name, freq):
    return write_wav(tmp_path / "up" / name, freq).read_bytes()


def test_upload_dirt_down_still_adds(env):
    client, dirt, roots, tmp_path = env
    dirt.up = False
    files = [("files[]", ("one.wav", wav_payload(tmp_path, "one.wav", 500), "audio/wav")),
             ("files[]", ("bad.txt", b"hello", "text/plain"))]
    r = client.post("/api/upload", data={"bank": "My Loops"}, files=files)
    assert r.status_code == 200
    body = r.json()
    assert body["bank"] == "my_loops" and body["added"] == ["one.wav"] and body["loaded"] is None
    assert body["rejected"][0][0] == "bad.txt"
    assert (roots["own"] / "my_loops" / "one.wav").exists()
    s = by_id(client)["own/my_loops/one.wav"]
    assert s["n"] == 0 and s["duration"] is not None and s["x"] is not None
    assert client.get("/api/status").json()["samples"] == 5


def test_upload_reload_count(env):
    client, dirt, roots, tmp_path = env
    dirt.loaded = 2
    files = [("files[]", ("a.wav", wav_payload(tmp_path, "a.wav", 400), "audio/wav")),
             ("files[]", ("b.wav", wav_payload(tmp_path, "b.wav", 900), "audio/wav"))]
    r = client.post("/api/upload", data={"bank": "mine"}, files=files)
    assert r.json()["loaded"] == 2
    assert dirt.loads == [(roots["own"] / "mine", "mine")]
    ids = by_id(client)
    assert ids["own/mine/a.wav"]["n"] == 0 and ids["own/mine/b.wav"]["n"] == 1


def test_rebuild_map_202(env):
    client, *_ = env
    assert client.post("/api/rebuild-map").status_code == 202
    assert by_id(client)["dirt/bd/a.wav"]["x"] is not None


def test_corrupt_meta_500_names_file(env):
    client, _, _, tmp_path = env
    (tmp_path / "meta.json").write_text("{nope")
    r = client.get("/api/samples")
    assert r.status_code == 500 and "meta.json" in r.json()["error"]
    assert (tmp_path / "meta.json").read_text() == "{nope"


def test_index_and_static(env):
    client, *_ = env
    assert client.get("/").status_code == 200


def test_lifespan_closes_dirt(env):
    client, dirt, *_ = env
    with client:
        pass
    assert dirt.closed


def test_rebuild_keeps_concurrent_placement_and_single_flight(env, monkeypatch):
    import threading

    import numpy as np

    from samplebank import app as appmod

    client, *_ = env
    st = client.app.state.st
    real, calls = appmod.compute_layout, []
    entered, release = threading.Event(), threading.Event()

    def slow(ids, vectors):
        calls.append(1)
        entered.set()
        release.wait(5)
        return real(ids, vectors)

    monkeypatch.setattr(appmod, "compute_layout", slow)
    t = threading.Thread(target=st.full_layout)
    t.start()
    assert entered.wait(5)
    # an upload lands mid-flight: new feature + placement
    src = next(iter(st.features.values()))
    with st.lock:
        st.features["own/new/x.wav"] = src
        st.cache.layout["own/new/x.wav"] = [0.1, 0.2]
    assert client.post("/api/rebuild-map").status_code == 202
    assert st.full_layout() is False
    release.set()
    t.join()
    assert len(calls) == 1
    xy = st.cache.layout["own/new/x.wav"]
    assert xy is not None and all(0 <= v <= 1 for v in xy)
    assert set(st.features) <= set(st.cache.layout)


def test_status_rebuilding_while_layout_runs(env, monkeypatch):
    import threading

    from samplebank import app as appmod

    client, *_ = env
    st = client.app.state.st
    real = appmod.compute_layout
    entered, release = threading.Event(), threading.Event()

    def slow(ids, vectors):
        entered.set()
        release.wait(5)
        return real(ids, vectors)

    monkeypatch.setattr(appmod, "compute_layout", slow)
    assert client.get("/api/status").json()["rebuilding"] is False
    t = threading.Thread(target=st.full_layout)
    t.start()
    try:
        assert entered.wait(5)
        status = client.get("/api/status").json()
        assert status["rebuilding"] is True
        assert {k: status[k] for k in ("dirt", "samples", "analysing")} == {"dirt": True, "samples": 4, "analysing": False}
    finally:
        release.set()
        t.join()
    assert client.get("/api/status").json()["rebuilding"] is False


def test_upload_load_count_zero_passes_through_distinct_from_null(env):
    client, dirt, roots, tmp_path = env
    files = [("files[]", ("a.wav", wav_payload(tmp_path, "a.wav", 400), "audio/wav"))]
    dirt.loaded = 0  # SuperDirt answered but loaded nothing (e.g. bank named like a synth)
    zero = client.post("/api/upload", data={"bank": "clash_a"}, files=files).json()["loaded"]
    dirt.up = False  # SuperDirt not reachable
    null = client.post("/api/upload", data={"bank": "clash_b"}, files=files).json()["loaded"]
    assert zero == 0 and zero is not None
    assert null is None


def test_foreign_origin_rejected_on_state_changes(env):
    client, dirt, *_ = env
    sid = "dirt/bd/a.wav"
    for evil in ("http://evil.example", "http://localhost:9999"):
        assert client.post("/api/play", json={"id": sid}, headers={"Origin": evil}).status_code == 403
        assert client.patch(f"/api/samples/{sid}", json={"star": True}, headers={"Origin": evil}).status_code == 403
    assert dirt.played == []
    assert by_id(client)[sid]["star"] is False


def test_good_or_missing_origin_ok(env):
    client, dirt, *_ = env
    sid = "dirt/bd/a.wav"
    assert client.post("/api/play", json={"id": sid}, headers={"Origin": "http://testserver"}).status_code == 204
    assert client.post("/api/play", json={"id": sid}).status_code == 204  # curl / non-browser
    assert client.get("/api/status", headers={"Origin": "http://evil.example"}).status_code == 200  # reads are not CSRF


def test_default_hosts_come_from_config_and_reject_rebinding(tmp_path):
    app = create_app(roots={k: tmp_path / k for k in ("dirt", "dub", "own")}, meta_path=tmp_path / "m.json",
                     cache_path=tmp_path / "c.json", tidal_dir=tmp_path, dirt=FakeDirt(), background=False)
    from samplebank import config

    for host in (f"localhost:{config.PORT}", f"127.0.0.1:{config.PORT}"):
        assert TestClient(app, base_url=f"http://{host}").get("/api/status").status_code == 200
    assert TestClient(app, base_url="http://evil.example:57150").get("/api/status").status_code == 403
    ok = TestClient(app, base_url=f"http://localhost:{config.PORT}")
    assert ok.post("/api/play", json={"id": "x"}, headers={"Origin": "http://127.0.0.1:57150"}).status_code == 404
    assert ok.post("/api/play", json={"id": "x"}, headers={"Origin": "http://evil.example"}).status_code == 403
