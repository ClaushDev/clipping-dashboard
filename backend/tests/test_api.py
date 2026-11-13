from fastapi.testclient import TestClient

from clipping.api import app
from clipping.db import init_db

# Sin "with": no arranca el worker, así los trabajos encolados no se ejecutan.
client = TestClient(app)
init_db()


def test_create_source_from_url():
    r = client.post("/api/sources", json={
        "url": "https://www.youtube.com/watch?v=test", "permission_note": "Prueba",
        "requested_clips": 3, "layout": "fit_black", "aspect": "16:9",
    })
    assert r.status_code == 200, r.text
    src = r.json()
    assert src["url"] == "https://www.youtube.com/watch?v=test"
    assert src["layout"] == "fit_black" and src["aspect"] == "16:9" and src["requested_clips"] == 3


def test_create_source_requires_permission():
    r = client.post("/api/sources", json={"url": "https://x.com/v", "permission_note": " "})
    assert r.status_code == 400


def test_unhandled_errors_return_reason():
    r = client.get("/api/clips/999999/download")
    assert r.status_code == 404


def test_source_activity_lists_its_jobs():
    r = client.post("/api/sources", json={"url": "https://www.youtube.com/watch?v=act", "permission_note": "Prueba"})
    sid = r.json()["id"]
    act = client.get(f"/api/sources/{sid}/activity")
    assert act.status_code == 200, act.text
    jobs = act.json()["jobs"]
    assert any(j["kind"] == "process_source" for j in jobs)
    assert client.get("/api/sources/999999/activity").status_code == 404


def test_clip_types_catalog():
    d = client.get("/api/clip-types").json()
    assert {t["id"] for t in d["types"]} >= {"clips"}
    preset_ids = {p["id"] for p in d["presets"]}
    assert all(set(t["presets"]) <= preset_ids for t in d["types"])
