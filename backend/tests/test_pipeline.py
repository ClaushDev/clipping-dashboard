from types import SimpleNamespace

from clipping.llm.base import extract_json
from clipping.pipeline import compose, moments, reframe


def _words(text: str, start: float = 0.0, step: float = 0.5) -> list[dict]:
    out = []
    t = start
    for token in text.split():
        out.append({"w": token, "s": round(t, 3), "e": round(t + step * 0.8, 3)})
        t += step
    return out


SENTENCES = " ".join(f"This is sentence number {n} with words." for n in range(40))
WORDS = _words(SENTENCES)  # 7 palabras por frase, 3,5 s por frase


def test_snap_starts_at_sentence_and_ends_on_sentence():
    # Propuesta a mitad de frase: debe avanzar al inicio de la siguiente frase.
    s, e = moments.snap(5.0, 30.0, WORDS, 20, 40, 200)
    start_word = next(w for w in WORDS if abs(w["s"] - (s + 0.12)) < 1e-6)
    assert start_word["w"] == "This"
    end_word = next(w for w in WORDS if abs(w["e"] - (e - 0.35)) < 1e-6)
    assert end_word["w"].endswith(".")
    assert 20 <= e - s <= 40.5


def test_snap_extends_short_and_trims_long():
    s, e = moments.snap(0.0, 5.0, WORDS, 20, 40, 200)
    assert e - s >= 20
    s, e = moments.snap(0.0, 100.0, WORDS, 20, 40, 200)
    assert e - s <= 40.5


def test_snap_rejects_cut_at_end_of_video():
    assert moments.snap(138.0, 150.0, WORDS, 20, 40, 140) is None


def test_dedupe_keeps_best_of_overlapping():
    a = moments.Moment(0, 30, "a", "", "", 90)
    b = moments.Moment(5, 35, "b", "", "", 70)
    c = moments.Moment(60, 90, "c", "", "", 50)
    assert [m.title for m in moments.dedupe([b, c, a])] == ["a", "c"]


def test_build_chunks_overlap_covers_everything():
    segs = [{"s": i * 10.0, "e": i * 10.0 + 9, "text": f"seg {i}"} for i in range(100)]
    chunks = moments.build_chunks(segs, chunk_seconds=300, overlap=60)
    assert chunks[0][0] == 0
    assert chunks[-1][1] == segs[-1]["e"]
    for (_, prev_end, _), (next_start, _, _) in zip(chunks, chunks[1:]):
        assert next_start < prev_end


def test_extract_json_tolerates_fences():
    assert extract_json('Here:\n```json\n{"moments": []}\n```') == {"moments": []}


def test_clip_composition_keeps_only_words_in_range_and_disables_hook():
    src = SimpleNamespace(id=7, width=1920, height=1080, bg_color="#111111")
    c = compose.clip_composition(source=src, start=10, end=20, words=_words("a " * 80), style={"hook_enabled": True},
                                 hook="Hi", layout="crop", keys=[], aspect="9:16", hook_enabled=False)
    seg = c["segments"][0]
    assert seg["src"] == "/api/sources/7/video" and seg["keys"][0]["x"] == 0.5
    assert all(w["e"] > 10 and w["s"] < 20 for w in c["captions"]["words"])
    assert c["captions"]["time_base"] == "source" and c["captions"]["style"]["hook_enabled"] is False
    assert compose.composition_duration(c) == 10


def test_absolutize_only_rewrites_local_urls():
    c = {"segments": [{"src": "/api/sources/1/video"}], "overlays": [{"src": "https://x.com/a.png"}], "n": 1}
    out = compose.absolutize(c, "http://127.0.0.1:8765")
    assert out["segments"][0]["src"] == "http://127.0.0.1:8765/api/sources/1/video"
    assert out["overlays"][0]["src"] == "https://x.com/a.png" and out["n"] == 1


def test_plan_keyframes_ignores_jitter_and_follows_moves():
    times = [i / 3 for i in range(30)]
    centers = [500 + (10 if i % 2 else -10) for i in range(15)] + [1400] * 15
    kf = reframe.plan_keyframes(times, centers, crop_w=606, src_w=1920)
    assert len(kf) == 2
    assert abs(kf[0][1] - (500 - 303)) <= 12 and kf[1][1] == 1400 - 303 - 1  # x par
    assert all(0 <= x <= 1920 - 606 for _, x in kf)


W, H = 1920, 1080


def test_plan_split_gaming_detects_corner_webcam():
    cam = (1650, 80, 120, 140)  # cara pequeña y fija arriba a la derecha
    faces = [[cam] for _ in range(20)]
    plan = reframe.plan_split(faces, W, H, "gaming")
    assert plan and [p["label"] for p in plan["panels"]] == ["Cámara", "Gameplay"]
    k = plan["panels"][0]["keys"][0]
    assert k["x"] > 0.85 and k["zoom"] > 2


def test_plan_split_gaming_rejects_moving_or_centered_faces():
    centered = [[(900, 400, 120, 140)] for _ in range(20)]
    assert reframe.plan_split(centered, W, H, "gaming") is None
    moving = [[(100 + 80 * i, 80, 120, 140)] for i in range(20)]
    assert reframe.plan_split(moving, W, H, "gaming") is None


def test_plan_split_duo_only_when_people_do_not_fit_one_crop():
    apart = [[(300, 300, 160, 200), (1450, 320, 150, 190)] for _ in range(20)]
    plan = reframe.plan_split(apart, W, H, "duo")
    assert plan and len(plan["panels"]) == 2 and plan["panels"][0]["keys"][0]["x"] < 0.5
    together = [[(820, 300, 140, 180), (1000, 320, 140, 180)] for _ in range(20)]
    assert reframe.plan_split(together, W, H, "duo") is None
    single = [[(800, 300, 200, 250)] for _ in range(20)]
    assert reframe.plan_split(single, W, H, "duo") is None


def _talking():  # dos caras separadas mirándose: la izquierda mira a la derecha (+) y la derecha a la izquierda (-)
    return [(300, 300, 160, 200, 0.3), (1450, 320, 150, 190, -0.3)]


def test_plan_dynamic_alternates_split_and_follow():
    times = [i / 3 for i in range(30)]  # 10 s
    faces = [_talking() for _ in range(15)] + [[(900, 300, 220, 260, 0.0)] for _ in range(15)]
    parts = reframe.plan_dynamic(times, faces, W, H, 10.0)
    assert [p["layout"] for p in parts] == ["split", "crop"]
    assert parts[0]["t0"] == 0 and parts[-1]["t1"] == 10.0
    assert abs(parts[0]["t1"] - parts[1]["t0"]) < 1e-6 and 4 < parts[0]["t1"] < 6


def test_plan_dynamic_requires_people_facing_each_other_and_exactly_two():
    times = [i / 3 for i in range(30)]
    away = [[(300, 300, 160, 200, -0.3), (1450, 320, 150, 190, 0.3)] for _ in range(30)]
    assert reframe.plan_dynamic(times, away, W, H, 10.0) is None
    table = [_talking() + [(800, 330, 120, 150, 0.0), (1100, 330, 120, 150, 0.0)] for _ in range(30)]
    assert reframe.plan_dynamic(times, table, W, H, 10.0) is None


def test_plan_dynamic_ignores_short_flickers():
    times = [i / 3 for i in range(30)]
    single = [(900, 300, 220, 260, 0.0)]
    faces = [[*single] for _ in range(30)]
    for i in (10, 11):  # 0,7 s de "dos personas": demasiado corto para cambiar de vista
        faces[i] = _talking()
    assert reframe.plan_dynamic(times, faces, W, H, 10.0) is None
