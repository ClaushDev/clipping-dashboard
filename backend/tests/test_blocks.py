import json

from fastapi.testclient import TestClient

from clipping import blocks
from clipping.api import app

client = TestClient(app)

BLOCK_HTML = """<!doctype html>
<html><head><meta charset="UTF-8" /><title>Lower</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>html,body{background:#FAF9F6} .bar{background:#ff5a36;color:#fff} #root{border:1px solid #abc}</style>
</head><body>
<div data-composition-id="lt" data-start="0" data-duration="4.8"
  data-composition-variables='[{"id":"TXT_SUB","type":"string","label":"Sub line","default":"Sonderbericht"}]'>
  <div class="clip bar" data-start="0" data-duration="4.8">
    <h1 class="name">Dr. Maya Chen</h1>
    <p style="color: #5a6170">Host &amp; Neuroscientist</p>
    <img class="avatar" src="assets/avatar.jpg" />
    <svg><rect fill="#0f1115" /><text>42</text></svg>
  </div>
  <script>
    var vars = window.__hyperframes.getVariables();
    var tl = gsap.timeline({ paused: true });
    tl.to(".bar", { backgroundColor: "#ff5a36", duration: 1 });
    window.__timelines = { lt: tl };
  </script>
</div>
</body></html>"""

COMPONENT_HTML = """<!doctype html>
<html lang="en" data-composition-id="count-up"><head><title>Count Up</title></head><body>
<template>
  <div id="root" data-composition-id="count-up" data-duration="3" data-fps="30">
    <style>#root{color:var(--fg, #f8fafc)}</style>
    <div class="cu-stage"><span class="cu-value"></span></div>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script>var v = window.__hyperframes.getVariables(); window.__timelines = {"count-up": gsap.timeline()};</script>
  </div>
</template>
</body></html>"""

ITEMS = {
    "lt-test": {"name": "lt-test", "type": "hyperframes:block", "title": "LT Test", "tags": ["lower-third", "overlay"],
                "dimensions": {"width": 1920, "height": 1080}, "duration": 4.8,
                "files": [{"path": "lt-test.html", "type": "hyperframes:composition"},
                          {"path": "assets/avatar.jpg", "type": "hyperframes:asset"}],
                "preview": {"poster": "https://x/p.png", "video": "https://x/v.mp4"},
                "variables": [{"id": "TXT_SUB", "type": "string", "default": "Sonderbericht"}]},  # sin etiqueta
    "count-test": {"name": "count-test", "type": "hyperframes:component", "title": "Count", "tags": ["counter"],
                   "files": [{"path": "count-test.html", "type": "hyperframes:snippet"}],
                   "variables": [{"id": "end", "type": "number", "label": "End value", "default": 100},
                                 {"id": "accent", "type": "enum", "label": "Accent", "default": "green",
                                  "options": [{"value": "green", "label": "Green"}, {"value": "blue", "label": "Blue"}]}]},
}
FILES = {"lt-test/lt-test.html": BLOCK_HTML, "lt-test/assets/avatar.jpg": "JPG", "count-test/count-test.html": COMPONENT_HTML}


class _Resp:
    def __init__(self, body: str, status: int = 200):
        self.content = body.encode()
        self.status_code = status

    def json(self):
        return json.loads(self.content)

    def raise_for_status(self):
        pass


def _fake_get(url, **_):
    key = url.split("/registry/", 1)[-1].split("/", 1)[-1] if "/registry/" in url else url
    if url.endswith("/registry.json"):
        return _Resp(json.dumps({"items": [{"name": n, "type": i["type"]} for n, i in ITEMS.items()]}))
    if url.endswith("registry-item.json"):
        return _Resp(json.dumps(ITEMS[url.split("/")[-2]]))
    if key in FILES:
        return _Resp(FILES[key])
    return _Resp("no", 404)


def _setup(monkeypatch):
    monkeypatch.setattr(blocks.httpx, "get", _fake_get)
    blocks.HF_DIR.mkdir(parents=True, exist_ok=True)
    blocks.CATALOG_FILE.write_text(json.dumps({"updated_at": "2026-10-26", "items": blocks.fetch_catalog()}), encoding="utf-8")
    blocks._catalog.cache_clear()
    blocks._cached_doc.cache_clear()


def test_normalize_and_categories():
    lt = blocks.normalize_item(ITEMS["lt-test"])
    assert lt["type"] == "block" and lt["category"] == "lower_third" and lt["width"] == 1920 and not lt["gpu"]
    cu = blocks.normalize_item(ITEMS["count-test"])
    assert cu["type"] == "component" and cu["width"] == 0 and cu["category"] == "data" and cu["duration"] == 3.0
    assert cu["variables"][1]["type"] == "enum" and cu["variables"][1]["options"][1]["value"] == "blue"
    assert blocks.category(["webgl", "aurora"]) == "background" and blocks.category(["zzz"]) == "other"


def test_analyze_texts_colors_images_variables():
    a = blocks.analyze(BLOCK_HTML, "block")
    assert [t["text"] for t in a["texts"]] == ["Dr. Maya Chen", "Host & Neuroscientist", "42"]
    colors = {c["color"]: c["uses"] for c in a["colors"]}
    # CSS (3 y 6 cifras, mayúsculas), atributos style/fill y el script; #root no es un color.
    assert colors == {"#ff5a36": 2, "#faf9f6": 1, "#ffffff": 1, "#aabbcc": 1, "#5a6170": 1, "#0f1115": 1}
    assert a["images"] == ["assets/avatar.jpg"] and a["variables"][0]["id"] == "TXT_SUB" and not a["warnings"]

    r0, r1 = blocks.region(BLOCK_HTML, "block")
    part = blocks.apply_texts(BLOCK_HTML[r0:r1], {0: "Laura <te> cuenta", 2: "7"})
    assert "Laura &lt;te&gt; cuenta" in part and "<text>7</text>" in part and "Host &amp; Neuroscientist" in part
    recolored = blocks.apply_colors(BLOCK_HTML, {"#ff5a36": "#00aa00", "#aabbcc": "#123456"})
    assert recolored.count("#00aa00") == 2 and "#123456" in recolored and "#root" in recolored
    assert 'src="/media/assets/me.png"' in blocks.apply_images(part, {"assets/avatar.jpg": "/media/assets/me.png"})


def test_catalog_install_and_doc(monkeypatch):
    _setup(monkeypatch)
    cat = client.get("/api/blocks/catalog").json()
    assert {i["name"] for i in cat["items"]} == {"lt-test", "count-test"} and not cat["status"]["running"]
    assert {c["key"] for c in cat["categories"]} == {"lower_third", "data"}

    info = client.post("/api/blocks/lt-test/install").json()
    assert info["installed"] and info["texts"][0]["text"] == "Dr. Maya Chen" and info["editable"]
    assert [(v["id"], v["label"]) for v in info["variables"]] == [("TXT_SUB", "Sub line")]  # etiqueta del HTML
    assert next(i for i in client.get("/api/blocks/catalog").json()["items"] if i["name"] == "lt-test")["installed"]

    cfg = {"texts": {"0": "Laura"}, "colors": {"#ff5a36": "#00aa00"}, "vars": {"TXT_SUB": "Te lo cuento"},
           "images": {"assets/avatar.jpg": "/media/assets/me.png"}, "transparent": True, "duration": 6}
    r = client.get("/api/blocks/lt-test/doc", params={"cfg": json.dumps(cfg)})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "*"
    doc = r.text
    assert "<h1 class=\"name\">Laura</h1>" in doc and "#00aa00" in doc and "#ff5a36" not in doc
    assert '{"TXT_SUB": "Te lo cuento"}' in doc and 'src="/media/assets/me.png"' in doc
    assert '<base href="http://testserver/api/blocks/files/lt-test/">' in doc
    assert "http://testserver/api/blocks/vendor/cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js" in doc
    assert "cdn.jsdelivr.net/npm" not in doc.replace("vendor/cdn.jsdelivr.net/npm", "")
    assert "background:transparent!important" in doc and "hfSeek" in doc and "var CLIPS = true" in doc
    assert doc.index("__hyperframes={getVariables") < doc.index("gsap.min.js")  # variables antes que el bloque

    f = client.get("/api/blocks/files/lt-test/assets/avatar.jpg")
    assert f.status_code == 200 and f.content == b"JPG" and f.headers["access-control-allow-origin"] == "*"
    assert client.get("/api/blocks/files/lt-test/meta.json").status_code == 404
    assert client.get("/api/blocks/files/lt-test/..%2F..%2Fcatalog.json").status_code in (400, 404)


def test_component_doc_fills_box_and_takes_layer_duration(monkeypatch):
    _setup(monkeypatch)
    cfg = {"vars": {"end": "250", "accent": "blue"}, "duration": 5.5}
    doc = client.get("/api/blocks/count-test/doc", params={"cfg": json.dumps(cfg)}).text  # se descarga solo
    assert doc.startswith("<!doctype html>") and "<template" not in doc
    assert 'data-composition-id="count-up" data-duration="5.5"' in doc
    assert '"end": 250.0' in doc and '"accent": "blue"' in doc and "--fg:#f8fafc" in doc and "var CLIPS = false" in doc


def test_bad_inputs(monkeypatch):
    _setup(monkeypatch)
    assert client.get("/api/blocks/NOPE!").status_code == 400
    assert client.get("/api/blocks/no-such-block").status_code == 404
    assert client.get("/api/blocks/lt-test/doc", params={"cfg": "{bad"}).status_code == 400
    assert client.get("/api/blocks/vendor/evil.com/x.js").status_code == 400
    cached = blocks.VENDOR_DIR / "cdn.jsdelivr.net" / "npm" / "gsap@3.14.2" / "dist" / "gsap.min.js"
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text("window.gsap={}", encoding="utf-8")
    r = client.get("/api/blocks/vendor/cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/javascript") and r.text == "window.gsap={}"
    cfg = blocks.parse_cfg(json.dumps({"colors": {"#FFF": "#000000", "#ff0000": "red", "#00ff00": "#0000FF"},
                                       "images": {"a.png": "javascript:alert(1)"}, "texts": {"x": "y", "3": "z"}}))
    assert cfg["colors"] == {"#00ff00": "#0000ff"} and cfg["images"] == {} and cfg["texts"] == {3: "z"}
