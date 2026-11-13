import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from clipping import editor_agent
from clipping.api import app
from clipping.db import Clip, engine, init_db
from clipping import sfx

client = TestClient(app)
init_db()
SOUNDS = {i["id"]: i for i in sfx.catalog()}


def _comp() -> dict:
    seg = {"id": "s1", "src": "/media/recycle/1/m1/source.mp4", "src_w": 1920, "src_h": 1080, "src_in": 2, "src_out": 6,
           "layout": "fit_blur", "keys": [], "volume": 1}
    seg2 = {**seg, "id": "s2", "src_in": 10, "src_out": 12, "speed": 0.5}
    return {"version": 1, "aspect": "9:16", "fps": 30, "segments": [seg, seg2], "scenes": [],
            "captions": {"enabled": True, "time_base": "timeline", "style": {"font_size": 80},
                         "words": [{"w": "watch", "s": 0.2, "e": 0.5}, {"w": "the", "s": 0.5, "e": 0.6}, {"w": "ball", "s": 0.6, "e": 1.0}]},
            "hook": {"text": ""}, "overlays": [], "audio": [], "fx": []}


def test_summary_and_words():
    c = _comp()
    text = editor_agent.summarize(c)
    assert "duration 8.00s" in text and "segment 1: 4.00-8.00" in text and "speed 0.5" in text
    assert editor_agent._words_text(c).startswith("0:watch@0.2")
    seg, src_t = editor_agent.segment_at(c, 5.0)
    assert seg["id"] == "s2" and src_t == pytest.approx(10.5)


def test_apply_actions():
    c = _comp()
    new, changes = editor_agent.apply_actions(c, [
        {"do": "add_shape", "shape": "circle", "start": 0.6, "end": 2, "x": 0.4, "y": 0.5, "w": 0.2, "h": 0.1},
        {"do": "add_sound", "sound": "whoosh", "at": 0.6},
        {"do": "add_sound", "sound": "no_existe", "at": 1},
        {"do": "add_fx", "kind": "punch", "start": 0.6, "x": 0.4, "y": 0.5},
        {"do": "segment", "index": 0, "set": {"freeze": 0.8, "evil": 1}},
        {"do": "hook", "text": "Watch the ball"},
        {"do": "word", "index": 2, "highlight": True},
        {"do": "split", "at": 2.0},
        {"do": "add_text", "text": "BOOM", "start": 99},
    ], SOUNDS)
    assert c["overlays"] == [] and c["segments"][0].get("freeze") is None  # la original no se toca
    shape = new["overlays"][0]
    assert shape["shape"] == "circle" and shape["anim"] == "draw" and shape["start"] == 0.6
    assert new["audio"][0]["kind"] == "sfx" and len(new["audio"]) == 1
    assert new["fx"][0]["kind"] == "punch" and new["fx"][0]["end"] == pytest.approx(1.8)
    assert len(new["segments"]) == 3 and new["segments"][0]["src_out"] == 4 and new["segments"][1]["freeze"] == 0.8
    assert "evil" not in new["segments"][0] and new["hook"]["text"] == "Watch the ball"
    assert new["captions"]["words"][2]["hl"] is True
    assert new["overlays"][-1]["start"] <= 8.8  # el tiempo se recorta a la duración
    assert any("no_existe" in x for x in changes)
    upd, _ = editor_agent.apply_actions(new, [{"do": "update", "id": shape["id"], "set": {"color": "#00FF00", "zzz": 1}},
                                              {"do": "delete", "id": new["fx"][0]["id"]}], SOUNDS)
    assert upd["overlays"][0]["color"] == "#00FF00" and "zzz" not in upd["overlays"][0] and upd["fx"] == []


class FakeProvider:
    """Primera vuelta: localiza la pelota. Segunda: pone el círculo donde le han dicho."""
    def __init__(self):
        self.prompts = []

    def complete_json(self, prompt, schema=None, images=None, **_):
        self.prompts.append(prompt)
        if len(self.prompts) == 1:
            return {"actions": [{"do": "locate", "query": "the ball", "at": 0.6}], "reply": "", "done": False}
        assert "center x 0.500" in prompt
        return {"actions": [{"do": "add_shape", "shape": "circle", "start": 0.6, "end": 2, "x": 0.5, "y": 0.4, "w": 0.1, "h": 0.06},
                            {"do": "add_sound", "sound": "pop", "at": 0.6}],
                "reply": "He rodeado la pelota y añadido un pop.", "done": True}


def test_run_agent_with_query(monkeypatch, tmp_path):
    with Session(engine) as s:
        clip = Clip(source_id=0, start=0, end=8, composition="")
        s.add(clip)
        s.commit()
        s.refresh(clip)
    fake = FakeProvider()
    frame = tmp_path / "f.jpg"
    frame.write_bytes(b"x")
    monkeypatch.setattr(editor_agent, "get_provider", lambda name, settings: fake)
    monkeypatch.setattr(editor_agent, "_frame", lambda comp, t, name: (frame, comp["segments"][0]))
    monkeypatch.setattr(editor_agent, "locate", lambda items: {items[0]["id"]: {"box": [0.4, 0.4, 0.6, 0.6], "score": 0.9}})
    r = client.post(f"/api/clips/{clip.id}/agent", json={"composition": _comp(), "message": "rodea la pelota",
                                                         "history": [], "playhead": 0.6})
    assert r.status_code == 200
    out = r.json()
    assert out["reply"].startswith("He rodeado") and len(out["changes"]) == 2
    assert out["composition"]["overlays"][0]["shape"] == "circle" and len(fake.prompts) == 2
    assert client.post(f"/api/clips/{clip.id}/agent", json={"composition": _comp(), "message": " "}).status_code == 400
