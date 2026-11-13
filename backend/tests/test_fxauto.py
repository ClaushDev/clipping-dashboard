from clipping import editor_agent, fxauto
from clipping.fxauto import Options


def _words(text: str, start: float = 0.0, step: float = 0.4) -> list[dict]:
    return [{"w": w, "s": round(start + i * step, 2), "e": round(start + i * step + 0.35, 2)} for i, w in enumerate(text.split())]


def _clip(words: list[dict], src_in: float = 100.0, length: float = 30.0, hook: str = "") -> dict:
    src = [{**w, "s": w["s"] + src_in, "e": w["e"] + src_in} for w in words]
    return {"version": 1, "aspect": "9:16", "fps": 30, "scenes": [], "overlays": [], "audio": [],
            "segments": [{"id": "a", "src": "/v", "src_w": 1920, "src_h": 1080, "src_in": src_in,
                          "src_out": src_in + length, "layout": "crop", "keys": [], "volume": 1}],
            "captions": {"enabled": True, "time_base": "source", "style": {"hook_duration": 3, "hook_enabled": True},
                         "words": src},
            "hook": {"text": hook}}


def _studio(n: int = 6, dur: float = 5.0) -> dict:
    scenes = [{"id": f"s{i}", "kind": "image", "start": i * dur, "duration": dur, "src": f"/img{i}.png",
               "transition": "fade", "motion": {"from": {"x": 0.5, "y": 0.5, "zoom": 1}, "to": {"x": 0.5, "y": 0.5, "zoom": 1.1}}}
              for i in range(n)]
    return {"version": 1, "aspect": "9:16", "fps": 30, "segments": [], "scenes": scenes, "overlays": [], "audio": [],
            "captions": {"enabled": True, "time_base": "timeline", "style": {}, "words": []}, "hook": {"text": ""}}


def test_timeline_words_maps_source_times():
    comp = _clip(_words("hello there friend"), src_in=50)
    tw = fxauto.timeline_words(comp)
    assert [w["s"] for w in tw] == [0.0, 0.4, 0.8]


def test_speaker_zoom_and_punch_in_on_strong_words():
    text = ("so I was walking down the street and then I saw something nobody expected it was INSANE honestly "
            "I never thought this could happen to me and my friends were there too watching everything")
    comp = fxauto.decorate(_clip(_words(text)), Options(transitions="none", numbers=False, stickers=False), "clip")
    kinds = [f["kind"] for f in comp["fx"]]
    assert "zoom" in kinds, kinds
    punches = [f for f in comp["fx"] if f["kind"] == "punch"]
    assert punches and punches[0]["start"] < 1.0  # movimiento en el primer segundo
    assert all(f["id"].startswith("auto_") for f in comp["fx"])
    # Punch-ins separados al menos 4,5 s (salvo el del arranque)
    later = [f["start"] for f in punches if f["start"] >= 1.0]
    assert all(b - a >= 4.4 for a, b in zip(later, later[1:]))


def test_numbers_count_up_and_skip_years_and_small():
    words = _words("in 2019 he had 3 cars but then he made $5,000 in one week and 90 percent of people never do", start=4)
    comp = fxauto.decorate(_clip(words), Options(speaker_zoom=False, punch_in=False, stickers=False, transitions="none"))
    texts = [o["text"] for o in comp["overlays"]]
    assert texts and texts[0] == "$5,000", texts
    assert all(o["anim"] == "count" for o in comp["overlays"])
    assert not any("2019" in t or t == "3" for t in texts)


def test_numbers_stay_out_of_the_hook_window():
    words = _words("$1,000 is what it costs and that is all", start=0.2)
    comp = fxauto.decorate(_clip(words, hook="Big hook"), Options(False, False, True, False, "none", False))
    assert not comp["overlays"]


def test_stickers_from_keywords_spaced():
    words = _words("this is about money and fire " + "filler " * 30 + "and then danger arrived", start=4)
    comp = fxauto.decorate(_clip(words, length=40), Options(False, False, False, True, "none", False))
    stickers = [o for o in comp["overlays"] if o["loop"] == "float"]
    assert stickers and stickers[0]["text"] == "\U0001F4B0"
    assert all(b["start"] - a["start"] >= 8 for a, b in zip(stickers, stickers[1:]))


def test_transitions_only_on_real_scene_changes_and_sparse():
    comp = _studio()
    # Dos planos de la misma imagen no son un cambio de escena
    comp["scenes"].insert(1, {**comp["scenes"][0], "id": "s0_1", "start": 2.5, "duration": 2.5})
    out = fxauto.decorate(comp, Options(False, False, False, False, "some", False), "studio")
    tr = [f for f in out["fx"] if f["kind"] in fxauto.TRANSITIONS]
    centers = [round((f["start"] + f["end"]) / 2, 1) for f in tr]
    assert tr and 2.5 not in centers
    assert all(b - a >= 7 for a, b in zip(centers, centers[1:]))
    # La escena que recibe un barrido entra con corte, no con fundido desde negro
    for f in tr:
        if f["kind"] in ("whip", "slide", "zoom_cut"):
            c = (f["start"] + f["end"]) / 2
            assert next(s for s in out["scenes"] if abs(s["start"] - c) < 0.15)["transition"] == "cut"
    many = fxauto.decorate(comp, Options(False, False, False, False, "many", False), "studio")
    assert len([f for f in many["fx"] if f["kind"] in fxauto.TRANSITIONS]) > len(tr)
    none = fxauto.decorate(comp, Options(False, False, False, False, "none", False), "studio")
    assert not none["fx"]


def test_camera_drift_on_stills_and_rerun_replaces_only_auto():
    comp = _studio()
    comp["fx"] = [{"id": "mine", "kind": "shake", "start": 1, "end": 1.5, "x": 0.5, "y": 0.5, "amount": 0.5}]
    once = fxauto.decorate(comp, Options(), "studio")
    assert all(s["motion"].get("drift") for s in once["scenes"])
    twice = fxauto.decorate(once, Options(), "studio")
    assert [f["id"] for f in twice["fx"]] == [f["id"] for f in once["fx"]]
    assert any(f["id"] == "mine" for f in twice["fx"])
    summary = fxauto.summary(once, twice)
    assert summary["removed"] == sum(1 for f in once["fx"] if f["id"].startswith("auto_"))


def test_agent_new_effects_and_scene_motion():
    comp = _studio(3)
    comp["fx"] = []
    out, changes = editor_agent.apply_actions(comp, [
        {"do": "add_fx", "kind": "whip", "start": 4.8, "dir": "right"},
        {"do": "add_fx", "kind": "nonsense"},
        {"do": "add_text", "text": "$5,000", "start": 1, "anim": "count", "loop": "pulse"},
        {"do": "add_sticker", "emoji": "\U0001F525", "start": 2},
        {"do": "scene_motion", "id": "s1", "move": "left", "amount": 0.2, "drift": 0.4},
    ], {})
    assert out["fx"][0]["kind"] == "whip" and out["fx"][0]["dir"] == "right"
    assert round(out["fx"][0]["end"] - out["fx"][0]["start"], 2) == 0.4
    assert out["fx"][1]["kind"] == "punch"
    text, sticker = out["overlays"]
    assert text["anim"] == "count" and text["loop"] == "pulse"
    assert sticker["loop"] == "float"
    m = out["scenes"][1]["motion"]
    assert m["from"]["x"] > m["to"]["x"] and m["drift"] == 0.4
    assert len(changes) == 5
