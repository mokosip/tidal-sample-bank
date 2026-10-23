import io

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from samplebank.app import create_app
from test_api import FakeDirt


def wav_bytes(dur=1.0, sr=22050, freq=440.0):
    t = np.arange(int(sr * dur)) / sr
    buf = io.BytesIO()
    sf.write(buf, 0.5 * np.sin(2 * np.pi * freq * t), sr, subtype="PCM_16", format="WAV")
    return buf.getvalue()


def make(tmp_path, staging=None):
    roots = {k: tmp_path / k for k in ("dirt", "dub", "own")}
    (roots["dirt"] / "bd").mkdir(parents=True, exist_ok=True)
    sf.write(roots["dirt"] / "bd" / "a.wav", np.zeros(2000), 22050, subtype="PCM_16")
    tidal = tmp_path / "tidal"
    tidal.mkdir(exist_ok=True)
    dirt = FakeDirt()
    app = create_app(roots=roots, meta_path=tmp_path / "meta.json", cache_path=tmp_path / "cache.json",
                     tidal_dir=tidal, dirt=dirt, background=False, allowed_hosts={"testserver"},
                     staging_dir=staging or tmp_path / "staging")
    return TestClient(app), dirt, roots


@pytest.fixture
def env(tmp_path):
    return make(tmp_path)


def stage(client, *files):
    r = client.post("/api/upload/stage", files=[("files[]", f) for f in files])
    assert r.status_code == 200, r.text
    return r.json()


def commit(client, batch, bank, files):
    return client.post("/api/upload/commit", json={"batch": batch, "bank": bank, "files": files})


def test_stage_then_commit_range(env):
    client, dirt, roots = env
    sr = 22050
    s = stage(client, ("rec.wav", wav_bytes(40, sr), "audio/wav"))
    assert s["rejected"] == [] and s["files"][0]["duration"] == pytest.approx(40)
    assert set(s["files"][0]) == {"token", "filename", "duration"}
    r = commit(client, s["batch"], "b", [{"token": s["files"][0]["token"], "action": "range",
                                          "start": 12.84, "end": 14.91, "fade": False}])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bank"] == "b" and body["added"] == ["rec.wav"] and body["rejected"] == []
    assert body["loaded"] == 3 and len(dirt.loads) == 1
    assert sf.info(roots["own"] / "b" / "rec.wav").frames == round(2.07 * sr)
    assert client.get(f"/api/upload/stage/{s['batch']}/{s['files'][0]['token']}/source.wav").status_code == 404
    assert "own/b/rec.wav" in {x["id"] for x in client.get("/api/samples").json()}


def test_commit_whole_keeps_original_bytes(env):
    client, _, roots = env
    raw = wav_bytes(0.5)
    s = stage(client, ("x.wav", raw, "audio/wav"))
    r = commit(client, s["batch"], "w", [{"token": s["files"][0]["token"], "action": "whole"}])
    assert r.status_code == 200 and r.json()["added"] == ["x.wav"]
    assert (roots["own"] / "w" / "x.wav").read_bytes() == raw


def test_commit_skip_and_bad_range_rejected(env):
    client, _, roots = env
    s = stage(client, ("a.wav", wav_bytes(), "audio/wav"), ("b.wav", wav_bytes(), "audio/wav"),
              ("c.wav", wav_bytes(), "audio/wav"), ("d.wav", wav_bytes(), "audio/wav"))
    t = [f["token"] for f in s["files"]]
    r = commit(client, s["batch"], "mix", [
        {"token": t[0], "action": "whole"},
        {"token": t[1], "action": "range", "start": 0.5, "end": 0.2},
        {"token": t[2], "action": "skip"},
        {"token": "../../etc", "action": "whole"},
    ])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["added"] == ["a.wav"]
    rej = dict(map(tuple, body["rejected"]))
    assert "after start" in rej["b.wav"] and rej["../../etc"] == "unknown file"
    assert sorted(p.name for p in (roots["own"] / "mix").iterdir()) == ["a.wav"]
    # d.wav was not listed: treated as skip
    assert "d.wav" not in rej


def test_409_keeps_batch_then_commit_again(env):
    client, _, roots = env
    s = stage(client, ("x.wav", wav_bytes(), "audio/wav"))
    item = [{"token": s["files"][0]["token"], "action": "whole"}]
    r = commit(client, s["batch"], "bd", item)
    assert r.status_code == 409 and r.json()["suggestion"] == "bd_mine"
    r = commit(client, s["batch"], "bd_mine", item)
    assert r.status_code == 200 and r.json()["added"] == ["x.wav"]
    assert commit(client, s["batch"], "again", item).status_code == 410


def test_invalid_bank_400(env):
    client, *_ = env
    s = stage(client, ("x.wav", wav_bytes(), "audio/wav"))
    r = commit(client, s["batch"], "!!!", [])
    assert r.status_code == 400 and "error" in r.json()


def test_410_after_restart(tmp_path):
    client, *_ = make(tmp_path)
    s = stage(client, ("x.wav", wav_bytes(), "audio/wav"))
    client2, *_ = make(tmp_path)
    r = commit(client2, s["batch"], "b", [{"token": s["files"][0]["token"], "action": "whole"}])
    assert r.status_code == 410
    assert r.json() == {"error": "upload expired — drop the files again"}


def test_bad_batch_id_410(env):
    client, *_ = env
    assert commit(client, "../x", "b", []).status_code == 410


def test_same_name_twice_saved_twice(env):
    client, _, roots = env
    s = stage(client, ("take.wav", wav_bytes(), "audio/wav"), ("take.wav", wav_bytes(), "audio/wav"))
    r = commit(client, s["batch"], "t", [{"token": f["token"], "action": "whole"} for f in s["files"]])
    assert r.json()["added"] == ["take.wav", "take_2.wav"]


def test_range_output_name_is_wav_stem(env):
    client, _, roots = env
    s = stage(client, ("loop.aif", _aif(), "audio/aiff"))
    r = commit(client, s["batch"], "t", [{"token": s["files"][0]["token"], "action": "range",
                                           "start": 0.1, "end": 0.5}])
    assert r.json()["added"] == ["loop.wav"], r.text


def _aif():
    buf = io.BytesIO()
    sf.write(buf, np.zeros(22050), 22050, subtype="PCM_16", format="AIFF")
    return buf.getvalue()


def test_source_endpoint_serves_wav(env):
    client, *_ = env
    s = stage(client, ("x.wav", wav_bytes(0.5), "audio/wav"))
    f = s["files"][0]
    r = client.get(f"/api/upload/stage/{s['batch']}/{f['token']}/source.wav")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert sf.info(io.BytesIO(r.content)).frames == 11025
    assert client.get(f"/api/upload/stage/{s['batch']}/{'0' * 16}/source.wav").status_code == 404
    assert client.get(f"/api/upload/stage/{s['batch']}/..%2f/source.wav").status_code == 404


def test_delete_discards(env):
    client, *_ = env
    s = stage(client, ("x.wav", wav_bytes(), "audio/wav"))
    f = s["files"][0]
    assert client.delete(f"/api/upload/stage/{s['batch']}").status_code == 204
    assert client.delete(f"/api/upload/stage/{s['batch']}").status_code == 204
    assert client.delete("/api/upload/stage/zzz").status_code == 204
    assert client.get(f"/api/upload/stage/{s['batch']}/{f['token']}/source.wav").status_code == 404
    assert commit(client, s["batch"], "b", [{"token": f["token"], "action": "whole"}]).status_code == 410


def test_stage_rejects_and_empty(env):
    client, *_ = env
    assert client.post("/api/upload/stage", data={}).status_code == 400
    s = stage(client, ("junk.wav", b"notaudio", "audio/wav"))
    assert s["files"] == [] and s["rejected"][0][0] == "junk.wav"


def test_commit_all_skipped(env):
    client, dirt, roots = env
    s = stage(client, ("x.wav", wav_bytes(), "audio/wav"))
    r = commit(client, s["batch"], "b", [{"token": s["files"][0]["token"], "action": "skip"}])
    assert r.status_code == 200
    assert r.json() == {"bank": "b", "added": [], "rejected": [], "loaded": None}
    assert dirt.loads == [] and not (roots["own"] / "b").exists()
    assert commit(client, s["batch"], "b", []).status_code == 410


def test_delete_origin_checked(env):
    client, *_ = env
    r = client.delete("/api/upload/stage/" + "a" * 16, headers={"origin": "http://evil.example"})
    assert r.status_code == 403
    r = client.post("/api/upload/stage", headers={"origin": "http://evil.example"},
                    files=[("files[]", ("x.wav", wav_bytes(), "audio/wav"))])
    assert r.status_code == 403


def test_bad_staging_dir_503_rest_works(tmp_path):
    bad = tmp_path / "precious"
    bad.mkdir()
    (bad / "keep.txt").write_text("x")
    client, *_ = make(tmp_path, staging=bad)
    r = client.post("/api/upload/stage", files=[("files[]", ("x.wav", wav_bytes(), "audio/wav"))])
    assert r.status_code == 503 and "marker" in r.json()["error"]
    assert commit(client, "a" * 16, "b", []).status_code == 503
    assert client.get("/api/upload/stage/" + "a" * 16 + "/" + "b" * 16 + "/source.wav").status_code in (404, 503)
    assert client.get("/api/status").status_code == 200
    assert (bad / "keep.txt").exists()


def test_old_upload_still_works(env):
    client, *_ = env
    r = client.post("/api/upload", data={"bank": "old"}, files=[("files[]", ("o.wav", wav_bytes(), "audio/wav"))])
    assert r.status_code == 200 and r.json()["added"] == ["o.wav"]


def test_concurrent_commits_one_wins(env, monkeypatch):
    import threading
    import time

    import samplebank.app as appmod
    client, dirt, roots = env
    s = stage(client, ("take.wav", wav_bytes(), "audio/wav"))
    item = [{"token": s["files"][0]["token"], "action": "range", "start": 0.1, "end": 0.5}]
    real = appmod.cut_wav

    def slow(*a, **k):
        time.sleep(0.4)
        return real(*a, **k)
    monkeypatch.setattr(appmod, "cut_wav", slow)
    out = []
    ts = [threading.Thread(target=lambda: out.append(commit(client, s["batch"], "b", item)))
          for _ in range(2)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert sorted(r.status_code for r in out) == [200, 410]
    assert sorted(p.name for p in (roots["own"] / "b").iterdir()) == ["take.wav"]
    assert len(dirt.loads) == 1


def test_delete_during_commit_no_500(env, monkeypatch):
    import threading
    import time

    import samplebank.app as appmod
    client, _, roots = env
    s = stage(client, ("take.wav", wav_bytes(), "audio/wav"))
    item = [{"token": s["files"][0]["token"], "action": "range", "start": 0.1, "end": 0.5}]
    real = appmod.cut_wav

    def slow(*a, **k):
        time.sleep(0.4)
        return real(*a, **k)
    monkeypatch.setattr(appmod, "cut_wav", slow)
    out = []
    t = threading.Thread(target=lambda: out.append(commit(client, s["batch"], "b", item)))
    t.start()
    time.sleep(0.1)
    assert client.delete(f"/api/upload/stage/{s['batch']}").status_code == 204
    t.join()
    assert out[0].status_code == 200 and out[0].json()["added"] == ["take.wav"]


def test_missing_file_outside_staging_is_not_expired(env, monkeypatch):
    import samplebank.app as appmod
    client, *_ = env
    s = stage(client, ("x.wav", wav_bytes(), "audio/wav"))
    f = s["files"][0]

    def boom(*a, **k):
        raise FileNotFoundError("/somewhere/else")

    monkeypatch.setattr(appmod, "ingest", boom)
    c = TestClient(client.app, raise_server_exceptions=False)
    r = commit(c, s["batch"], "b", [{"token": f["token"], "action": "whole"}])
    assert r.status_code == 500
    monkeypatch.undo()
    # the claim is released, the batch is still there
    assert commit(client, s["batch"], "b", [{"token": f["token"], "action": "whole"}]).status_code == 200


def test_vanished_staged_file_is_410(env):
    client, _, roots = env
    s = stage(client, ("x.wav", wav_bytes(), "audio/wav"))
    f = s["files"][0]
    root = roots["own"].parent / "staging" / s["batch"]
    for p in root.rglob("*"):
        if p.is_file():
            p.unlink()
    assert commit(client, s["batch"], "b", [{"token": f["token"], "action": "whole"}]).status_code == 410
