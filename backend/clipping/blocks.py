"""Bloques animados de HyperFrames (heygen-com/hyperframes, Apache 2.0) como capa del editor.

El catálogo (≈450 bloques y componentes: rótulos, títulos, gráficos, mapas, tarjetas de redes, anotaciones…) se lee
del repositorio oficial y se guarda en data/hyperframes. Al usar un bloque se descargan sus archivos. El editor y el
renderer lo cargan en un iframe aislado (`sandbox="allow-scripts"`) con el documento de /api/blocks/{name}/doc: el
HTML original con las variables, textos, colores e imágenes cambiados, y un runtime mínimo que lleva sus líneas de
tiempo GSAP al segundo exacto que pide Remotion (por postMessage). Remotion sigue siendo el único motor de render.
"""
from __future__ import annotations

import html as htmlmod
import json
import logging
import mimetypes
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response

from .config import DATA_DIR
from .db import utcnow

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/blocks", tags=["blocks"])

RAW = "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry"
SOURCE_URL = "https://github.com/heygen-com/hyperframes"
HF_DIR = DATA_DIR / "hyperframes"
ITEMS_DIR = HF_DIR / "items"
VENDOR_DIR = HF_DIR / "vendor"
CATALOG_FILE = HF_DIR / "catalog.json"
VENDOR_HOSTS = ("cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com")
# El renderer de Remotion carga el documento desde otro origen (y el iframe aislado tiene origen opaco):
# fuentes e imágenes con `crossorigin` necesitan esta cabecera. Solo se sirve contenido del catálogo.
CORS = {"Access-Control-Allow-Origin": "*"}
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")

# Categorías en español por etiquetas (la primera que encaje).
CATEGORIES: list[tuple[str, str, set[str]]] = [
    ("lower_third", "Rótulos", {"lower-third", "news", "ticker", "broadcast"}),
    ("social", "Redes sociales", {"social", "social-overlay", "youtube", "instagram", "tiktok", "reddit", "twitter",
                                  "comments", "spotify", "notification"}),
    ("map", "Mapas", {"map", "geography", "travel"}),
    ("data", "Datos y gráficos", {"data", "chart", "data-viz", "stat", "stats", "counter", "number", "ranking",
                                  "statistics", "leaderboard", "progress", "gauge", "rating", "proof"}),
    ("annotation", "Anotaciones", {"handwritten", "annotation", "arrow", "callout", "highlight", "underline"}),
    ("captions", "Subtítulos", {"captions", "caption-style", "karaoke"}),
    ("title", "Títulos", {"title-card", "typography", "kinetic-text", "kinetic", "text", "headline", "logo"}),
    ("transition", "Transiciones", {"transition", "wipe"}),
    ("texture", "Texturas y efectos", {"texture", "grain", "overlay", "effect", "vignette", "light-leak", "film",
                                       "glitch", "particles", "media-treatment-overlay"}),
    ("background", "Fondos", {"background", "gradient", "aurora", "starfield", "snow", "weather"}),
    ("ui", "Interfaz y producto", {"mock-ui", "app", "product-demo", "cursor", "ui-props", "code", "developer",
                                   "chat", "ai", "video-primitive"}),
    ("3d", "3D", {"3d", "3d-motion", "3d-object", "three-js", "webgl"}),
]
GPU_TAGS = {"webgpu", "webgpu-shader", "webgl", "three-js", "shader", "html-in-canvas", "3d-object"}
VAR_TYPES = {"string": "string", "text": "text", "number": "number", "color": "color", "boolean": "boolean",
             "enum": "enum", "select": "enum"}

_lock = threading.Lock()
_status = {"running": False, "error": "", "done": 0, "total": 0}


# ---------- Catálogo ----------

def category(tags: list[str]) -> str:
    ts = set(tags)
    for key, _, keys in CATEGORIES:
        if ts & keys:
            return key
    return "other"


def _variable(v: dict) -> dict | None:
    """Variable de HyperFrames normalizada; las `params` antiguas (clave «--x») son variables CSS."""
    vid = str(v.get("id") or v.get("key") or "").strip()
    kind = VAR_TYPES.get(str(v.get("type", "string")))
    if not vid or not kind:
        return None
    out = {"id": vid, "type": kind, "label": str(v.get("label") or vid), "description": str(v.get("description") or ""),
           "default": v.get("default", "" if kind not in ("number", "boolean") else 0 if kind == "number" else False),
           "css": vid.startswith("--")}
    if kind == "enum":
        out["options"] = [o if isinstance(o, dict) else {"value": o, "label": str(o)} for o in v.get("options") or []]
    for k in ("min", "max", "step"):
        if isinstance(v.get(k), (int, float)):
            out[k] = v[k]
    return out


def normalize_item(raw: dict) -> dict:
    """Ficha del catálogo a partir de un registry-item.json."""
    kind = "component" if raw.get("type") == "hyperframes:component" else "block"
    tags = [str(t) for t in raw.get("tags") or []]
    dims = raw.get("dimensions") or {}
    variables = [x for x in (_variable(v) for v in (raw.get("variables") or []) + (raw.get("params") or [])) if x]
    seen: set[str] = set()
    variables = [v for v in variables if not (v["id"] in seen or seen.add(v["id"]))]
    return {
        "name": raw["name"], "type": kind, "title": raw.get("title") or raw["name"],
        "description": raw.get("description") or "", "tags": tags, "category": category(tags),
        "width": int(dims.get("width") or 0) if kind == "block" else 0,
        "height": int(dims.get("height") or 0) if kind == "block" else 0,
        "duration": float(raw.get("duration") or 0) or (3.0 if kind == "component" else 5.0),
        "poster": (raw.get("preview") or {}).get("poster", ""), "video": (raw.get("preview") or {}).get("video", ""),
        "variables": variables, "editable": bool(variables),
        "files": [{"path": f["path"], "type": str(f.get("type", "")).split(":")[-1]} for f in raw.get("files") or []
                  if isinstance(f, dict) and f.get("path")],
        "author": raw.get("author") or "HeyGen", "license": raw.get("license") or "Apache-2.0",
        "gpu": bool(set(tags) & GPU_TAGS),
    }


def _folder(item_type: str) -> str:
    return "components" if item_type == "component" else "blocks"


def fetch_catalog() -> list[dict]:
    """Lee registry.json y la ficha de cada bloque y componente del repositorio oficial (≈450 peticiones)."""
    reg = httpx.get(f"{RAW}/registry.json", timeout=30, follow_redirects=True)
    reg.raise_for_status()
    wanted = [(i["name"], "component" if i["type"] == "hyperframes:component" else "block")
              for i in reg.json().get("items", []) if i.get("type") in ("hyperframes:block", "hyperframes:component")
              and NAME_RE.match(str(i.get("name", "")))]
    with _lock:
        _status.update(total=len(wanted), done=0)

    def one(entry: tuple[str, str]) -> dict | None:
        name, kind = entry
        try:
            r = httpx.get(f"{RAW}/{_folder(kind)}/{name}/registry-item.json", timeout=30, follow_redirects=True)
            r.raise_for_status()
            return normalize_item(r.json())
        except (httpx.HTTPError, ValueError, KeyError) as e:
            log.warning("Bloque %s sin ficha: %s", name, e)
            return None
        finally:
            with _lock:
                _status["done"] += 1

    with ThreadPoolExecutor(max_workers=16) as pool:
        items = [x for x in pool.map(one, wanted) if x]
    return sorted(items, key=lambda x: (x["category"], x["title"].lower()))


def _refresh() -> None:
    try:
        items = fetch_catalog()
        if not items:
            raise RuntimeError("El catálogo ha llegado vacío")
        HF_DIR.mkdir(parents=True, exist_ok=True)
        CATALOG_FILE.write_text(json.dumps({"updated_at": utcnow().isoformat(), "items": items}, ensure_ascii=False),
                                encoding="utf-8")
        _catalog.cache_clear()
        with _lock:
            _status["error"] = ""
    except Exception as e:  # noqa: BLE001 — se enseña en el dashboard
        log.exception("Catálogo de HyperFrames")
        with _lock:
            _status["error"] = f"No se pudo leer el catálogo de HyperFrames: {e}"
    finally:
        with _lock:
            _status["running"] = False


def start_refresh() -> None:
    with _lock:
        if _status["running"]:
            return
        _status.update(running=True, error="", done=0, total=0)
    threading.Thread(target=_refresh, daemon=True, name="hyperframes-catalog").start()


@lru_cache(maxsize=1)
def _catalog() -> dict:
    if not CATALOG_FILE.exists():
        return {"updated_at": "", "items": []}
    return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))


def catalog_item(name: str) -> dict:
    if not NAME_RE.match(name):
        raise HTTPException(400, "Nombre de bloque no válido")
    meta = ITEMS_DIR / name / "meta.json"
    if meta.exists():
        return json.loads(meta.read_text(encoding="utf-8"))
    item = next((i for i in _catalog()["items"] if i["name"] == name), None)
    if not item:
        raise HTTPException(404, "Ese bloque no está en el catálogo")
    return item


# ---------- Lectura y cambios del HTML ----------

TAG_RE = re.compile(r"<(/?)([A-Za-z][\w:-]*)(?:\"[^\"]*\"|'[^']*'|[^'\">])*>|<![^>]*>")
HEX_CSS = re.compile(r"(?<![\w&/(])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])")
HEX_JS = re.compile(r"(?<![\w&/(])#([0-9a-fA-F]{6})(?![\w-])")
COLOR_ATTR_RE = re.compile(r"""\b(style|fill|stroke|stop-color|color|flood-color)\s*=\s*("[^"]*"|'[^']*')""", re.I)
IMG_SRC_RE = re.compile(r"""(<img\b[^>]*?\bsrc\s*=\s*)("[^"]*"|'[^']*')""", re.I)
CDN_RE = re.compile(r"https://(" + "|".join(re.escape(h) for h in VENDOR_HOSTS) + r")/")


def segments(s: str):
    """Trocea HTML en (tipo, inicio, fin): tag, comment, text y raw:script / raw:style (su contenido)."""
    i, n = 0, len(s)
    while i < n:
        j = s.find("<", i)
        if j == -1:
            yield "text", i, n
            return
        if j > i:
            yield "text", i, j
        if s.startswith("<!--", j):
            k = s.find("-->", j + 4)
            k = n if k == -1 else k + 3
            yield "comment", j, k
            i = k
            continue
        m = TAG_RE.match(s, j)
        if not m:
            yield "text", j, j + 1
            i = j + 1
            continue
        yield "tag", j, m.end()
        i = m.end()
        name = (m.group(2) or "").lower()
        if name in ("script", "style") and not m.group(1):
            close = re.compile(rf"</{name}\s*>", re.I).search(s, i)
            end = close.start() if close else n
            yield f"raw:{name}", i, end
            i = end


def region(doc: str, kind: str) -> tuple[int, int]:
    """Zona con el contenido visible: el <template> de un componente o el <body> de un bloque."""
    tag = "template" if kind == "component" else "body"
    m = re.search(rf"<{tag}\b[^>]*>", doc, re.I)
    e = doc.lower().rfind(f"</{tag}>")
    if not m or e < m.end():
        return 0, len(doc)
    return m.end(), e


def _text_nodes(s: str) -> list[tuple[int, int, str]]:
    """Textos visibles (no scripts ni estilos) con al menos una letra o cifra."""
    out = []
    for kind, a, b in segments(s):
        if kind != "text":
            continue
        text = htmlmod.unescape(s[a:b]).strip()
        if text and re.search(r"\w", text):
            out.append((a, b, " ".join(text.split())))
    return out


def _norm_hex(h: str) -> str:
    h = h.lower()
    return "#" + "".join(c * 2 for c in h) if len(h) == 3 else "#" + h[:6]


def _color_spans(doc: str):
    """Colores hex en estilos, atributos de color y (solo de 6 cifras) en scripts: (inicio, fin, hex de la cifra)."""
    for kind, a, b in segments(doc):
        if kind == "raw:style":
            for m in HEX_CSS.finditer(doc, a, b):
                yield m.start(1), m.end(1), m.group(1)
        elif kind == "raw:script":
            for m in HEX_JS.finditer(doc, a, b):
                yield m.start(1), m.end(1), m.group(1)
        elif kind == "tag":
            for am in COLOR_ATTR_RE.finditer(doc, a, b):
                for m in HEX_CSS.finditer(doc, am.start(2), am.end(2)):
                    yield m.start(1), m.end(1), m.group(1)


def doc_variables(doc: str) -> list[dict]:
    m = re.search(r"""data-composition-variables\s*=\s*('([^']*)'|"([^"]*)")""", doc)
    if not m:
        return []
    try:
        raw = json.loads(htmlmod.unescape(m.group(2) if m.group(2) is not None else m.group(3)))
    except ValueError:
        return []
    return [x for x in (_variable(v) for v in raw if isinstance(v, dict)) if x]


def analyze(doc: str, kind: str) -> dict:
    """Lo que se puede cambiar de un bloque: textos, colores, imágenes y variables declaradas en el HTML."""
    a, b = region(doc, kind)
    part = doc[a:b]
    texts = [{"i": i, "text": t[:200]} for i, (_, _, t) in enumerate(_text_nodes(part))][:40]
    counts: dict[str, int] = {}
    for _, _, h in _color_spans(doc):
        counts[_norm_hex(h)] = counts.get(_norm_hex(h), 0) + 1
    colors = [{"color": c, "uses": n} for c, n in sorted(counts.items(), key=lambda x: -x[1])][:14]
    images = []
    for m in IMG_SRC_RE.finditer(part):
        src = htmlmod.unescape(m.group(2)[1:-1])
        if src and not src.startswith(("data:", "http:", "https:", "//")) and src not in images:
            images.append(src)
    warnings = []
    if re.search(r"<(video|audio)\b", part, re.I):
        warnings.append("Trae vídeo o audio propio: en el editor no se sincroniza y se verá quieto.")
    if "data-composition-src" in doc:
        warnings.append("Carga otras composiciones por dentro: puede quedar incompleto.")
    if re.search(r"webgpu|getContext\(\s*['\"]webgl|three(\.module)?(\.min)?\.js|/three@", doc, re.I):
        warnings.append("Usa WebGL, WebGPU o 3D: puede ir lento o salir en negro al renderizar. Pruébalo antes de exportar.")
    return {"texts": texts, "colors": colors, "images": images[:8], "variables": doc_variables(doc), "warnings": warnings}


def apply_texts(part: str, texts: dict[int, str]) -> str:
    if not texts:
        return part
    out, last = [], 0
    for i, (a, b, _) in enumerate(_text_nodes(part)):
        if i not in texts:
            continue
        raw = part[a:b]
        lead = raw[: len(raw) - len(raw.lstrip())]
        trail = raw[len(raw.rstrip()):]
        out += [part[last:a], lead, htmlmod.escape(texts[i], quote=False), trail]
        last = b
    out.append(part[last:])
    return "".join(out)


def apply_colors(doc: str, colors: dict[str, str]) -> str:
    if not colors:
        return doc
    out, last = [], 0
    for a, b, h in sorted(_color_spans(doc)):
        new = colors.get(_norm_hex(h))
        if not new:
            continue
        alpha = h[6:] if len(h) == 8 else ""
        out += [doc[last:a], new[1:] + alpha]
        last = b
    out.append(doc[last:])
    return "".join(out)


def apply_images(part: str, images: dict[str, str]) -> str:
    if not images:
        return part

    def swap(m: re.Match) -> str:
        new = images.get(htmlmod.unescape(m.group(2)[1:-1]))
        return m.group(1) + (f'"{htmlmod.escape(new)}"' if new else m.group(2))
    return IMG_SRC_RE.sub(swap, part)


RUNTIME = """<script>
(function () {
  // Runtime mínimo del editor: Remotion pide un segundo y aquí se llevan las líneas de tiempo a ese punto.
  var CLIPS = %(clips)s;
  function timelines() {
    var t = window.__timelines || {};
    return Object.keys(t).map(function (k) { return t[k]; }).filter(function (x) { return x && x.seek; });
  }
  function seek(time) {
    if (CLIPS) {
      document.querySelectorAll(".clip[data-start]").forEach(function (el) {
        if (el.hasAttribute("data-composition-id")) return;
        var s = parseFloat(el.getAttribute("data-start") || "0");
        var d = parseFloat(el.getAttribute("data-duration") || "1e9");
        el.style.visibility = time >= s && time < s + d ? "" : "hidden";
      });
    }
    timelines().forEach(function (tl) {
      try { tl.seek(Math.max(0, Math.min(time, tl.duration())), false); } catch (e) {}
    });
  }
  function images() {
    return Promise.all(Array.prototype.map.call(document.images, function (img) {
      return img.complete ? null : new Promise(function (r) { img.onload = img.onerror = r; });
    }));
  }
  var ready = new Promise(function (r) {
    if (document.readyState === "complete") r(); else window.addEventListener("load", function () { r(); });
  }).then(function () {
    return Promise.all([document.fonts ? document.fonts.ready : null, images()]);
  }).then(function () {
    seek(0);
    var d = timelines().reduce(function (m, tl) { return Math.max(m, tl.duration()); }, 0);
    parent.postMessage({ hfReady: true, duration: d }, "*");
  });
  window.addEventListener("message", function (e) {
    var m = e.data || {};
    if (typeof m.hfSeek !== "number") return;
    ready.then(function () {
      seek(m.hfSeek);
      parent.postMessage({ hfSeeked: m.id }, "*");
    });
  });
})();
</script>"""

COMPONENT_TOKENS = (":root{--fg:#f8fafc;--bg:transparent;--brand:#71f5a7;--accent:#61a8ff;--accent-2:#c5a3ff;"
                    "--font-display:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;"
                    "--font-body:Inter,system-ui,-apple-system,'Segoe UI',sans-serif}"
                    "html,body{width:100%;height:100%;background:transparent}")
TRANSPARENT_CSS = ("html,body,[data-composition-id]{background:transparent!important;"
                   "background-color:transparent!important;background-image:none!important}")


def _var_value(v: dict, value):
    if v["type"] == "number":
        try:
            return float(value)
        except (TypeError, ValueError):
            return v["default"]
    if v["type"] == "boolean":
        return value is True or value == "true"
    return "" if value is None else str(value)


def build_doc(name: str, cfg: dict, base_url: str) -> str:
    """Documento listo para el iframe: cambios del usuario aplicados, librerías servidas en local y runtime."""
    item = catalog_item(name)
    main = next((f["path"] for f in item["files"] if f["type"] in ("composition", "snippet")), None)
    path = ITEMS_DIR / name / (main or "")
    if not main or not path.is_file():
        raise HTTPException(404, "Ese bloque no está descargado")
    doc = path.read_text(encoding="utf-8")
    kind = item["type"]

    doc = apply_colors(doc, cfg.get("colors") or {})
    a, b = region(doc, kind)
    part = apply_images(apply_texts(doc[a:b], cfg.get("texts") or {}), cfg.get("images") or {})
    duration = float(cfg.get("duration") or item["duration"])

    variables = {v["id"]: v for v in item.get("variables") or []}
    values = {k: _var_value(v, (cfg.get("vars") or {}).get(k, v["default"])) for k, v in variables.items()}
    js_vars = {k: x for k, x in values.items() if not variables[k]["css"]}
    css_vars = "".join(f"{k}:{x};" for k, x in values.items() if variables[k]["css"] and re.match(r"^[\w#.,%() -]*$", str(x)))
    style = ":root{color-scheme:light}html,body{margin:0;overflow:hidden}"
    if kind == "component":
        style += COMPONENT_TOKENS
    if css_vars:
        style += f":root{{{css_vars}}}"
    if cfg.get("transparent"):
        style += TRANSPARENT_CSS
    head = (f'<base href="{htmlmod.escape(base_url)}/api/blocks/files/{name}/">'
            f"<style>{style}</style>"
            "<script>window.__hyperframes={getVariables:function(){return "
            + json.dumps(js_vars, ensure_ascii=False).replace("</", "<\\/") + "}};</script>")
    runtime = RUNTIME % {"clips": "true" if kind == "block" else "false"}

    if kind == "component":
        # El componente llena la caja; su duración es la de la capa (su animación se adapta a ella).
        part = re.sub(r'(<[^>]*\bdata-composition-id="[^"]*"[^>]*?\bdata-duration=")[^"]*(")',
                      lambda m: f"{m.group(1)}{duration:g}{m.group(2)}", part, count=1)
        doc = f'<!doctype html><html><head><meta charset="utf-8">{head}</head><body>{part}{runtime}</body></html>'
    else:
        doc = doc[:a] + part + runtime + doc[b:]
        m = re.search(r"<head\b[^>]*>", doc, re.I)
        doc = doc[:m.end()] + head + doc[m.end():] if m else head + doc
    # Librerías (GSAP, three…) desde la copia local en vez del CDN: el render no depende de la red.
    return CDN_RE.sub(lambda m: f"{base_url}/api/blocks/vendor/{m.group(1)}/", doc)


def install(name: str) -> dict:
    """Descarga los archivos del bloque y guarda su ficha con lo que se puede editar."""
    item = catalog_item(name)
    target = ITEMS_DIR / name
    meta = target / "meta.json"
    if meta.exists():
        return item
    for f in item["files"]:
        dest = _safe_path(target, f["path"])
        r = httpx.get(f"{RAW}/{_folder(item['type'])}/{name}/{f['path']}", timeout=60, follow_redirects=True)
        if r.status_code != 200:
            raise HTTPException(502, f"No se pudo descargar {f['path']} ({r.status_code})")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
    main = next((f["path"] for f in item["files"] if f["type"] in ("composition", "snippet")), None)
    if not main:
        raise HTTPException(422, "Ese bloque no trae una composición")
    found = analyze((target / main).read_text(encoding="utf-8"), item["type"])
    # Las variables declaradas en el HTML completan las de la ficha (que a veces vienen sin etiqueta).
    in_html = {v["id"]: v for v in found["variables"]}
    merged = [{**v, "label": in_html[v["id"]]["label"]} if v["id"] in in_html and v["label"] == v["id"] else v
              for v in item["variables"]]
    known = {v["id"] for v in merged}
    item = {**item, **{k: found[k] for k in ("texts", "colors", "images", "warnings")},
            "variables": merged + [v for v in found["variables"] if v["id"] not in known],
            "installed": True}
    item["editable"] = bool(item["variables"] or item["texts"] or item["colors"])
    meta.write_text(json.dumps(item, ensure_ascii=False, indent=1), encoding="utf-8")
    return item


def _safe_path(root: Path, rel: str) -> Path:
    p = (root / rel).resolve()
    if not p.is_relative_to(root.resolve()) or rel.startswith(("/", "\\")):
        raise HTTPException(400, "Ruta no válida")
    return p


def parse_cfg(raw: str) -> dict:
    if len(raw) > 30_000:
        raise HTTPException(413, "Configuración demasiado grande")
    try:
        cfg = json.loads(raw or "{}")
    except ValueError:
        raise HTTPException(400, "Configuración no válida") from None
    if not isinstance(cfg, dict):
        raise HTTPException(400, "Configuración no válida")
    hexre = re.compile(r"^#[0-9a-fA-F]{6}$")
    return {
        "vars": cfg.get("vars") if isinstance(cfg.get("vars"), dict) else {},
        "texts": {int(k): str(v)[:500] for k, v in (cfg.get("texts") or {}).items() if str(k).isdigit()},
        "colors": {k.lower(): v.lower() for k, v in (cfg.get("colors") or {}).items()
                   if hexre.match(str(k)) and hexre.match(str(v))},
        "images": {str(k): str(v) for k, v in (cfg.get("images") or {}).items()
                   if str(v).startswith(("/media/", "/api/", "http://", "https://"))},
        "transparent": bool(cfg.get("transparent")),
        "duration": min(600.0, max(0.1, float(cfg["duration"]))) if isinstance(cfg.get("duration"), (int, float)) else 0,
    }


# ---------- Rutas ----------

@router.get("/catalog")
def get_catalog():
    cat = _catalog()
    with _lock:
        status = dict(_status)
    if not cat["items"] and not status["running"] and not status["error"]:
        start_refresh()
        status["running"] = True
    installed = {p.name for p in ITEMS_DIR.iterdir() if (p / "meta.json").exists()} if ITEMS_DIR.exists() else set()
    # La categoría se recalcula al servir: así un cambio en CATEGORIES no obliga a volver a leer el catálogo.
    items = [{**i, "category": category(i["tags"]), "installed": i["name"] in installed} for i in cat["items"]]
    order = {k: n for n, (k, _, _) in enumerate(CATEGORIES)}
    items.sort(key=lambda i: (order.get(i["category"], len(order)), i["title"].lower()))
    counts: dict[str, int] = {}
    for i in items:
        counts[i["category"]] = counts.get(i["category"], 0) + 1
    cats = [{"key": k, "label": label, "count": counts.get(k, 0)} for k, label, _ in CATEGORIES]
    cats.append({"key": "other", "label": "Otros", "count": counts.get("other", 0)})
    return {"status": status, "updated_at": cat["updated_at"], "source": SOURCE_URL,
            "items": items,
            "categories": [c for c in cats if c["count"]]}


@router.post("/catalog/refresh")
def refresh_catalog():
    start_refresh()
    return {"ok": True}


@router.get("/{name}")
def get_block(name: str):
    return catalog_item(name)


@router.post("/{name}/install")
def install_block(name: str):
    try:
        return install(name)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"No se pudo descargar el bloque: {e}") from e


@router.get("/{name}/doc")
def block_doc(name: str, request: Request, cfg: str = ""):
    base = str(request.base_url).rstrip("/")
    item = catalog_item(name)
    if not item.get("installed"):
        install(name)
    return HTMLResponse(_cached_doc(name, json.dumps(parse_cfg(cfg), sort_keys=True), base), headers=CORS)


@lru_cache(maxsize=64)
def _cached_doc(name: str, cfg_json: str, base: str) -> str:
    cfg = json.loads(cfg_json)
    cfg["texts"] = {int(k): v for k, v in cfg["texts"].items()}
    return build_doc(name, cfg, base)


@router.get("/files/{name}/{path:path}")
def block_file(name: str, path: str):
    if not NAME_RE.match(name):
        raise HTTPException(400, "Nombre de bloque no válido")
    p = _safe_path(ITEMS_DIR / name, path)
    if not p.is_file() or p.name == "meta.json":
        raise HTTPException(404, "No existe")
    return FileResponse(p, headers=CORS)


@router.get("/vendor/{host}/{path:path}")
def vendor(host: str, path: str):
    """Copia local de las librerías que piden los bloques (GSAP, three, lottie…): se descarga una vez."""
    if host not in VENDOR_HOSTS or not re.match(r"^[\w@.+/-]+$", path) or ".." in path:
        raise HTTPException(400, "Origen no permitido")
    dest = _safe_path(VENDOR_DIR / host, path)
    if not dest.is_file():
        r = httpx.get(f"https://{host}/{path}", timeout=60, follow_redirects=True)
        if r.status_code != 200:
            raise HTTPException(502, f"No se pudo descargar {host}/{path} ({r.status_code})")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
    if dest.suffix in (".js", ".mjs", "") or path.endswith("+esm"):
        media = "application/javascript"
    else:
        media = mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
    return Response(dest.read_bytes(), media_type=media, headers={**CORS, "Cache-Control": "public, max-age=31536000"})
