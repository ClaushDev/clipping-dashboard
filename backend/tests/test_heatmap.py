"""Puntos calientes de YouTube («Más reproducido»)."""
from clipping.pipeline import heatmap, moments, signals


def _info(values: list[float], step: float = 10.0) -> dict:
    return {"heatmap": [{"start_time": i * step, "end_time": (i + 1) * step, "value": v} for i, v in enumerate(values)]}


def test_from_info_normalizes_and_skips_bad_rows():
    info = _info([0.2, 1.4, -1])
    info["heatmap"].append({"start_time": "x"})
    pts = heatmap.from_info(info)
    assert [p["v"] for p in pts] == [0.2, 1.0, 0.0]
    assert heatmap.from_info({}) == [] and heatmap.from_info(None) == []


def test_hot_spots_are_bumps_over_the_trend():
    # Curva tipo real: arranque al máximo, caída lenta y dos bultos (60-80 s y 140 s).
    vals = [1.0, 0.6, 0.5, 0.4, 0.38, 0.36, 0.5, 0.55, 0.33, 0.32, 0.31, 0.3, 0.29, 0.28, 0.4, 0.27, 0.26, 0.25, 0.24, 0.23]
    pts = heatmap.from_info(_info(vals))
    spots = heatmap.hot_spots(pts)
    assert spots[0]["t"] == 60.0 and spots[0]["d"] == 20.0  # 60-80 s unidos, el que más destaca
    assert [s["t"] for s in spots] == [60.0, 140.0]
    assert all(s["t"] >= 30 for s in spots)  # el arranque no cuenta aunque sea el máximo
    assert heatmap.heat_of(pts, 65, 70) > heatmap.HOT and heatmap.heat_of(pts, 100, 120) == 0.0


def test_ensure_saves_once_even_when_empty(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(heatmap, "fetch", lambda url: calls.append(url) or [])
    path = tmp_path / heatmap.FILE
    assert heatmap.ensure(path, "https://www.youtube.com/watch?v=abc") == []
    assert heatmap.ensure(path, "https://www.youtube.com/watch?v=abc") == []
    assert calls == ["https://www.youtube.com/watch?v=abc"]
    assert heatmap.ensure(tmp_path / "otro.json", "https://www.tiktok.com/@a/video/1") == []
    assert len(calls) == 1  # TikTok no tiene «Más reproducido»


FLAT = [1.0, 0.5, 0.4] + [0.2] * 3 + [0.3] + [0.2] * 5  # bulto de +50 % en 60-70 s


def test_prompt_block_includes_most_replayed():
    pts = heatmap.from_info(_info(FLAT))
    text = signals.prompt_block({"heatmap": pts}, 0, 120)
    assert "MOST-REPLAYED" in text and "[60.0-70.0] +50%" in text
    assert signals.prompt_block({"heatmap": pts}, 80, 120) == ""


class _Fake:
    chunk_seconds = 600

    def complete_json(self, prompt, schema, **_):
        assert "MOST-REPLAYED" in prompt
        return {"moments": [{"start": 60, "end": 70, "title": "t", "hook": "h", "reason": "Buen remate.", "score": 80,
                             "tags": []}]}


def test_find_moments_notes_hot_spot_in_reason():
    words = [{"w": f"w{i}", "s": i * 0.5, "e": i * 0.5 + 0.4} for i in range(240)]
    tr = {"segments": [{"s": 0, "e": 120, "text": "texto"}], "words": words, "duration": 120, "language": "es"}
    pts = heatmap.from_info(_info(FLAT))
    found = moments.find_moments(tr, _Fake(), count=1, min_d=5, max_d=15, signals={"heatmap": pts})
    assert found and "punto caliente de YouTube (+50 %" in found[0].reason
