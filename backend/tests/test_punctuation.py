from clipping import punctuation as P


def _words(text: str) -> list[dict]:
    return [{"w": w, "s": i * 0.3, "e": i * 0.3 + 0.25} for i, w in enumerate(text.split())]


class Fake:
    def __init__(self, fn):
        self.fn, self.calls = fn, []

    def complete_json(self, prompt, schema=None, images=None, task=""):
        self.calls.append(task)
        text = prompt.split("Transcript:\n", 1)[1]
        return {"text": self.fn(text)}


def test_missing_runs_and_prompt():
    ws = _words("hola. " + "uno " * 30 + "fin.")
    assert P.missing_runs(ws) == [(1, 31)]
    assert P.missing_runs(_words("a, b. c? d!")) == []
    assert "¿" in P.initial_prompt("es") and P.initial_prompt("xx") is None
    assert P.stats(ws)["missing"] == 30


def test_restore_only_copies_marks_and_never_changes_words():
    raw = "y entonces le dije que no que eso no se hace así y él me miró y se fue sin decir nada más y yo me quedé ahí"
    ws = _words(raw)
    def fn(text):  # el modelo puntúa, pero además «corrige» una palabra y se inventa otra
        return ("Y entonces le dije que no, que eso no se hace así. Y él me miró y se fue sin decir nada más, "
                "y yo me quedé allí. Vale.")
    fake = Fake(fn)
    out, n = P.restore(ws, fake, "es")
    assert fake.calls == ["punctuation"]
    assert [P.norm(w["w"]) for w in out] == [P.norm(w["w"]) for w in ws]  # mismas palabras
    assert [w["s"] for w in out] == [w["s"] for w in ws]  # mismos tiempos
    text = " ".join(w["w"] for w in out)
    assert text.startswith("Y entonces le dije que no, que") and "así. Y él" in text
    assert out[-1]["w"] == "ahí"  # «allí» no sustituye a «ahí»
    assert n > 0 and ws[0]["w"] == "y"  # no muta la entrada


def test_restore_attaches_loose_marks_and_survives_errors():
    ws = _words("qué quieres saber " + "x " * 25)
    out, _ = P.restore(ws, Fake(lambda t: "¿ Qué quieres saber ? " + "x " * 25), "es")
    assert out[0]["w"] == "¿Qué" and out[2]["w"] == "saber?"

    class Broken:
        def complete_json(self, *a, **k):
            raise RuntimeError("sin modelo")
    out, n = P.restore(ws, Broken(), "es")
    assert n == 0 and out == ws


def test_agent_word_style_and_punctuation_style():
    from clipping import editor_agent
    c = {"version": 1, "aspect": "9:16", "fps": 30, "segments": [], "scenes": [], "hook": {"text": ""}, "overlays": [],
         "audio": [], "fx": [], "captions": {"enabled": True, "time_base": "timeline", "style": {},
                                              "words": [{"w": w, "s": i, "e": i + 0.5} for i, w in enumerate("cuesta 300 euros".split())]}}
    new, _ = editor_agent.apply_actions(c, [
        {"do": "word_style", "from": 2, "to": 1, "set": {"color": "#FFD400", "scale": 9, "anim": "nope", "evil": 1}},
        {"do": "caption_style", "set": {"punctuation": "expressive"}},
    ], {})
    w = new["captions"]["words"]
    assert "st" not in w[0] and w[1]["st"] == {"color": "#FFD400", "scale": 3} and w[2]["st"] == w[1]["st"]
    assert new["captions"]["style"]["punctuation"] == "expressive"
    new, _ = editor_agent.apply_actions(new, [{"do": "word_style", "from": 1, "to": 1, "set": {}}], {})
    assert "st" not in new["captions"]["words"][1] and "st" in new["captions"]["words"][2]


def test_word_presets_api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from clipping import api
    monkeypatch.setattr(api, "WORD_PRESETS", tmp_path / "p.json")
    cl = TestClient(api.app)
    assert cl.get("/api/caption-word-presets").json() == []
    r = cl.post("/api/caption-word-presets", json={"name": "Cifra", "style": {"color": "#FF0", "scale": 1.5, "x": 1, "font": ""}})
    assert r.json() == [{"name": "Cifra", "style": {"color": "#FF0", "scale": 1.5}}]
    assert cl.post("/api/caption-word-presets", json={"name": " ", "style": {}}).status_code == 400
    assert cl.delete("/api/caption-word-presets/Cifra").json() == []


def test_restore_skips_when_already_punctuated():
    ws = _words("Hola, ¿qué tal? Bien.")
    fake = Fake(lambda t: t)
    assert P.restore(ws, fake, "es") == (ws, 0) and not fake.calls
