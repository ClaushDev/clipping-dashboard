"""Construcción de composiciones (formato en frontend/src/remotion/schema.ts)."""
from __future__ import annotations

import re

import uuid

STYLE_FIELDS = (
    "font", "font_size", "font_weight", "primary_color", "highlight_color", "highlight_mode", "box_color",
    "outline_color", "outline_width", "shadow", "uppercase", "words_per_chunk", "margin_v", "animation",
    "chunk_bg_color", "chunk_bg_opacity",
    "hook_enabled", "hook_font_size", "hook_text_color", "hook_bg_color", "hook_duration",
)


# ---------- Curvas de fotograma clave, espejo de schema.ts ----------
# Cada clave dice cómo se llega a ella desde la anterior: "hold" (salto), "smooth" (cámara de siempre), una curva con
# nombre o "custom" con `bezier` [x1, y1, x2, y2] (salida de la clave anterior y entrada a esta, como cubic-bezier).
# Los encuadres (`keys`) van sin curva = "hold"; las claves de capa sin curva = "ease"; las de volumen
# (`vol_keys` en tramos, pistas de audio y capas de vídeo: {t, v}) sin curva = "linear".

EASE_BEZIER = {
    "linear": (0, 0, 1, 1),
    "ease": (0.42, 0, 0.58, 1),
    "ease_in": (0.5, 0, 0.9, 0.4),
    "ease_out": (0.1, 0.6, 0.5, 1),
    "back": (0.34, 1.56, 0.64, 1),
}


def bezier_at(b, p: float) -> float:
    """Como bezierAt de schema.ts."""
    x1, y1, x2, y2 = b

    def coord(u, a, c):
        return 3 * a * u * (1 - u) ** 2 + 3 * c * u * u * (1 - u) + u ** 3

    lo, hi, u = 0.0, 1.0, p
    for _ in range(30):
        x = coord(u, x1, x2)
        if abs(x - p) < 1e-5:
            break
        if x < p:
            lo = u
        else:
            hi = u
        u = (lo + hi) / 2
    return coord(u, y1, y2)


def ease_at(ease: str, bezier, p: float) -> float | None:
    """Progreso con la curva de una clave; None = salto."""
    if ease == "hold":
        return None
    if ease == "smooth":
        return 2 * p * p if p < 0.5 else 1 - (-2 * p + 2) ** 2 / 2
    curve = (bezier or EASE_BEZIER["ease"]) if ease == "custom" else EASE_BEZIER.get(ease, EASE_BEZIER["ease"])
    return bezier_at(curve, p)


def crop_at(keys: list[dict], t: float) -> dict:
    """Como cropAt de schema.ts: encuadre en el segundo t (del original, desde el inicio del tramo)."""
    if not keys:
        return {"x": 0.5, "y": 0.5, "zoom": 1}
    if t <= keys[0]["t"]:
        return keys[0]
    for a, b in zip(keys, keys[1:]):
        if t < b["t"]:
            # rampa más corta que el plano (dur): hasta su inicio se queda en el punto anterior
            start = max(a["t"], b["t"] - b["dur"]) if b.get("dur") and (b.get("ease") or "hold") != "hold" else a["t"]
            if t < start:
                return a
            e = ease_at(b.get("ease") or "hold", b.get("bezier"), (t - start) / max(b["t"] - start, 1e-6))
            if e is None:
                return a
            return {k: a[k] + (b[k] - a[k]) * e for k in ("x", "y", "zoom")}
    return keys[-1]


def value_at(keys: list[dict] | None, t: float, fallback: float) -> float:
    """Como valueAt de schema.ts (claves de volumen)."""
    if not keys:
        return fallback
    if t <= keys[0]["t"]:
        return keys[0]["v"]
    for a, b in zip(keys, keys[1:]):
        if t < b["t"]:
            e = ease_at(b.get("ease") or "linear", b.get("bezier"), (t - a["t"]) / max(b["t"] - a["t"], 1e-6))
            return a["v"] if e is None else a["v"] + (b["v"] - a["v"]) * e
    return keys[-1]["v"]


def new_id() -> str:
    return uuid.uuid4().hex[:8]


def style_from_template(tpl, overrides: dict | None = None) -> dict:
    style = {k: getattr(tpl, k) for k in STYLE_FIELDS}
    for k, v in (overrides or {}).items():
        if k in STYLE_FIELDS or k in ("placement", "punctuation"):
            style[k] = v
    return style


def source_video_url(source_id: int) -> str:
    return f"/api/sources/{source_id}/video"


def clip_composition(*, source, start: float, end: float, words: list[dict], style: dict, hook: str,
                     layout: str, keys: list[dict], aspect: str, hook_enabled: bool = True,
                     panels: list[dict] | None = None, note: str = "", parts: list[dict] | None = None,
                     source_cuts: list[dict] | None = None) -> dict:
    """Composición inicial de un clip: un tramo del vídeo original con su encuadre, o varios tramos seguidos
    (`parts`, tiempos relativos al clip) cuando el encuadre cambia a lo largo del clip (p. ej. doble vista).
    source_cuts: cortes, transiciones y zooms del original en segundos del original; cada tramo guarda los suyos."""
    if not parts:
        parts = [{"t0": 0.0, "t1": end - start, "layout": layout, "keys": keys, "panels": panels, "note": note}]
    if not hook_enabled:
        style = {**style, "hook_enabled": False}
    if "placement" not in style:
        # Con el vídeo completo (bandas o fondo), los subtítulos van debajo para no taparlo.
        # En pantalla dividida, "below_video" los coloca sobre la línea de corte entre paneles; en los tramos con
        # recorte normal no hay hueco y se usa la altura fija.
        below = any(p["layout"].startswith("fit") or p["layout"] == "split" for p in parts)
        style = {**style, "placement": "below_video" if below else "bottom"}
    segments = []
    for p in parts:
        segments.append({
            "id": new_id(),
            "src": source_video_url(source.id),
            "src_w": source.width,
            "src_h": source.height,
            "src_in": round(start + p["t0"], 3),
            "src_out": round(min(end, start + p["t1"]), 3),
            "layout": p["layout"],
            "bg_color": getattr(source, "bg_color", "#111111") or "#111111",
            "keys": p.get("keys") or [{"t": 0, "x": 0.5, "y": 0.5, "zoom": 1, "ease": "hold"}],
            **({"panels": p["panels"]} if p.get("panels") else {}),
            **({"note": p["note"]} if p.get("note") else {}),
            "volume": 1,
        })
        if source_cuts is not None:
            seg = segments[-1]
            seg["source_cuts"] = [c for c in source_cuts if seg["src_in"] < c["t"] < seg["src_out"]]
    return {
        "version": 1,
        "aspect": aspect,
        "fps": 30,
        "segments": segments,
        "scenes": [],
        "captions": {
            "enabled": True,
            "time_base": "source",
            "style": style,
            # Sin la probabilidad de Whisper («p»): solo la usa el preset Speed para marcar palabras dudosas.
            "words": [{k: v for k, v in w.items() if k != "p"} for w in words if w["e"] > start and w["s"] < end],
        },
        "hook": {"text": hook},
        "overlays": [],
        "audio": [],
    }


COLD_OPEN_LABEL = "Gancho adelantado"
EARLIER = {"es": "Unos segundos antes…", "ca": "Uns segons abans…", "pt": "Alguns segundos antes…",
           "fr": "Quelques secondes plus tôt…", "de": "Ein paar Sekunden vorher…", "it": "Qualche secondo prima…"}


def _keys_from(keys: list[dict], at: float, until: float) -> list[dict]:
    """Puntos de encuadre de un tramo vistos desde `at` (segundos relativos al tramo): el que manda en `at` pasa a 0."""
    keys = sorted(keys or [], key=lambda k: k["t"])
    head = next((k for k in reversed(keys) if k["t"] <= at), keys[0] if keys else None)
    out = [{**head, "t": 0}] if head else [{"t": 0, "x": 0.5, "y": 0.5, "zoom": 1, "ease": "hold"}]
    out += [{**k, "t": round(k["t"] - at, 3)} for k in keys if at < k["t"] < until]
    return out


def _part(seg: dict, a: float, b: float) -> dict:
    """Trozo [a, b) (segundos del original) de un tramo, con su encuadre recolocado."""
    at, until = a - seg["src_in"], b - seg["src_in"]
    out = {**seg, "id": new_id(), "src_in": round(a, 3), "src_out": round(b, 3), "keys": _keys_from(seg["keys"], at, until)}
    if seg.get("panels"):
        out["panels"] = [{**p, "keys": _keys_from(p.get("keys") or [], at, until)} for p in seg["panels"]]
    return out


def add_cold_open(comp: dict, a: float, b: float, *, transition: str = "flash", mode: str = "repeat",
                  language: str = "") -> dict:
    """Gancho adelantado (cold open): el tramo [a, b] del original se ve primero, con una transición de salto, y
    luego el clip desde su inicio. mode «repeat» lo vuelve a enseñar en su sitio; «trim» lo quita del cuerpo. Es un
    tramo más del editor (cold_open = True); los subtítulos, con tiempos del original, le siguen solos."""
    segs = comp.get("segments") or []
    host = next((s for s in segs if s["src_in"] <= a < s["src_out"]), None)
    if not host or b - a < 0.5:
        return comp
    b = min(b, host["src_out"])
    opener = {**_part(host, a, b), "cold_open": True, "label": COLD_OPEN_LABEL}
    body = segs
    if mode == "trim":
        body = []
        for s in segs:
            if s is not host:
                body.append(s)
                continue
            if a - s["src_in"] >= 0.3:
                body.append(_part(s, s["src_in"], a))
            if s["src_out"] - b >= 0.3:
                body.append(_part(s, b, s["src_out"]))
    length = round(b - a, 3)
    out = {**comp, "segments": [opener, *body]}
    if transition == "glitch":
        fx = {"id": new_id(), "kind": "glitch", "start": round(max(0, length - 0.15), 3), "end": round(length + 0.25, 3),
              "x": 0.5, "y": 0.5, "amount": 0.8}
    else:
        fx = {"id": new_id(), "kind": "flash", "start": round(max(0, length - 0.03), 3), "end": round(length + 0.35, 3),
              "x": 0.5, "y": 0.5, "amount": 0.9 if transition == "flash" else 0.5}
    out["fx"] = [*(comp.get("fx") or []), fx]
    if transition == "text":
        out["overlays"] = [*(comp.get("overlays") or []), {
            "id": new_id(), "kind": "text", "text": EARLIER.get(language[:2], "A few seconds earlier…"),
            "start": length, "end": round(length + 1.6, 3), "x": 0.5, "y": 0.2, "w": 0.86, "size": 64,
            "font": "Montserrat", "weight": 800, "color": "#FFFFFF", "bg": "rgba(0,0,0,0.55)", "anim": "fade"}]
    return out


SOURCE_VIDEO = re.compile(r"/api/sources/(\d+)/video")


def regenerate_words(comp: dict, load) -> list[dict]:
    """«Regenerar subtítulos»: vuelve a sacar de la transcripción del vídeo original las palabras de todos los
    tramos actuales (tras alargar, duplicar o recortar tramos). `load(source_id)` da las palabras de Whisper o None.
    Se conservan las palabras destacadas (hl, hl2) que coincidan; los textos retocados a mano se pierden. Los tramos
    de archivos sin transcripción guardada conservan sus palabras."""
    cap = comp.get("captions") or {}
    if cap.get("time_base") != "source":
        raise ValueError("Los subtítulos de este vídeo salen de la narración: no hay transcripción que releer")
    segs = comp.get("segments") or []
    old = cap.get("words") or []
    single = len({s["src"] for s in segs}) == 1
    flags = {(round(w["s"], 2), w.get("src")): w for w in old}
    out, redone = [], set()
    for src in dict.fromkeys(s["src"] for s in segs):
        m = SOURCE_VIDEO.search(src or "")
        words = load(int(m.group(1))) if m else None
        if words is None:
            continue
        redone.add(src)
        ranges = [r for s, r in zip(segs, audio_source_ranges(segs)) if s["src"] == src]
        for w in words:
            if not any(a <= w["s"] < b for a, b in ranges):
                continue
            nw = {"w": w["w"], "s": w["s"], "e": w["e"], **({} if single else {"src": src})}
            prev = flags.get((round(w["s"], 2), None if single else src))
            nw |= {k: prev[k] for k in ("hl", "hl2", "st") if prev and prev.get(k)}  # también el estilo propio
            out.append(nw)
    if not redone:
        raise ValueError("No se encontró la transcripción del vídeo original")
    out += [w for w in old if not single and w.get("src") and w["src"] not in redone]
    return sorted(out, key=lambda w: w["s"])


SPEED_MIN, SPEED_MAX = 0.1, 8.0


def _ramp_table(s: dict) -> tuple[list[float], float]:
    """Rampa de velocidad, como rampTable en schema.ts: out[i] = segundos de timeline hasta el segundo i·h."""
    src_len = max(0.0, s["src_out"] - s["src_in"])
    n = max(20, int(-(-src_len * 60 // 1)))
    h = src_len / n
    out = [0.0]
    for i in range(n):
        sp = min(SPEED_MAX, max(SPEED_MIN, value_at(s["speed_keys"], (i + 0.5) * h, 1)))
        out.append(out[-1] + h / sp)
    return out, h


def is_remapped(s: dict) -> bool:
    """Tramo con rampa o marcha atrás: se dibuja fotograma a fotograma y sin su sonido."""
    return bool(s.get("speed_keys")) or bool(s.get("reverse"))


def moving_length(s: dict) -> float:
    """Lo que dura la parte en movimiento del tramo, como movingLength en schema.ts."""
    src_len = max(0.0, s["src_out"] - s["src_in"])
    if not s.get("speed_keys"):
        return src_len / (s.get("speed") or 1)
    return _ramp_table(s)[0][-1]


def segment_source_local(s: dict, local: float) -> float:
    """Segundo del original (desde src_in) que se ve en el segundo `local` del tramo, como en schema.ts."""
    src_len = max(0.0, s["src_out"] - s["src_in"])
    local = max(0.0, local)
    if not s.get("speed_keys"):
        f = min(local * (s.get("speed") or 1), src_len)
    else:
        out, h = _ramp_table(s)
        if local >= out[-1]:
            f = src_len
        else:
            i = max(0, next(k for k, v in enumerate(out) if v > local) - 1)
            f = min(src_len, (i + (local - out[i]) / max(out[i + 1] - out[i], 1e-9)) * h)
    return max(0.0, src_len - f) if s.get("reverse") else f


def segment_local_of(s: dict, src_local: float) -> float:
    """Inverso: segundo del tramo en el que se ve el segundo `src_local` del original, como segmentLocalOf."""
    src_len = max(0.0, s["src_out"] - s["src_in"])
    x = src_len - src_local if s.get("reverse") else src_local
    if not s.get("speed_keys"):
        return x / (s.get("speed") or 1)
    out, h = _ramp_table(s)
    i = min(len(out) - 2, max(0, int(x / max(h, 1e-9))))
    return out[i] + (out[i + 1] - out[i]) * min(1.0, max(0.0, x / max(h, 1e-9) - i))


def avg_rate(s: dict) -> float:
    """Velocidad media del tramo (con rampa, la que resulta de toda ella)."""
    return max(0.0, s["src_out"] - s["src_in"]) / max(moving_length(s), 1e-6)


def segment_length(s: dict) -> float:
    """Duración del tramo en la timeline (velocidad, rampa y congelado incluidos), como segmentLength en schema.ts."""
    return moving_length(s) + max(0.0, s.get("freeze") or 0)


def audio_offset(segs: list[dict], i: int) -> float:
    """Corte J/L al empezar el tramo i, limitado a medio plano a cada lado, como audioOffset en schema.ts."""
    v = (segs[i].get("audio_offset") or 0) if 0 < i < len(segs) else 0
    if not v:
        return 0.0
    lim = min(segment_length(segs[i - 1]), segment_length(segs[i])) / 2
    return max(-lim, min(lim, v))


def audio_source_ranges(segs: list[dict]) -> list[tuple[float, float]]:
    """Trozo del original que se oye en cada tramo (segundos del original): con cortes J/L empieza antes o acaba
    después que su imagen. Como segmentAudioWindows en schema.ts, pero en tiempos del original."""
    out = []
    for i, s in enumerate(segs):
        if s.get("reverse"):  # marcha atrás: sin sonido ni subtítulos
            out.append((s["src_in"], s["src_in"]))
            continue
        if s.get("speed_keys"):  # rampa: sin sonido; los subtítulos van con su imagen
            out.append((s["src_in"], s["src_out"]))
            continue
        rate = s.get("speed") or 1
        moving = max(0.0, s["src_out"] - s["src_in"]) / rate
        a = audio_offset(segs, i)
        nxt = audio_offset(segs, i + 1) if i + 1 < len(segs) else 0.0
        b = min(segment_length(s) + nxt, moving + max(0.0, nxt))
        out.append((s["src_in"] + a * rate, s["src_in"] + max(a, b) * rate))
    return out


def word_cut_range(words: list[dict], i: int, j: int) -> tuple[float, float]:
    """Trozo del original que se quita al borrar las palabras i..j, como wordCutRanges en ops.ts: desde justo
    antes de la primera hasta 0,1 s antes de la siguiente (se va también la pausa de detrás)."""
    first, last = words[i], words[j]
    prev = words[i - 1] if i > 0 else None
    nxt = words[j + 1] if j + 1 < len(words) else None
    a = max(prev["e"], first["s"] - 0.05) if prev else first["s"] - 0.05
    b = max(last["e"], nxt["s"] - min(0.1, nxt["s"] - last["e"])) if nxt else last["e"] + 0.15
    return round(max(0.0, a), 3), round(b, 3)


def cut_source(comp: dict, a: float, b: float, src: str | None = None) -> float:
    """Quita [a, b) (segundos del original) de los tramos de ese archivo: los parte y junta el resto (editar
    borrando palabras). Lo que había encima del trozo se borra y lo de detrás se adelanta. Devuelve los segundos
    quitados de la timeline (0 si no toca nada o se quedaría sin tramos)."""
    segs, out, removed, at = comp.get("segments", []), [], 0.0, None
    t = 0.0
    for s in segs:
        if (src and s["src"] != src) or b <= s["src_in"] or a >= s["src_out"]:
            out.append(s)
            t += segment_length(s)
            continue
        rate = avg_rate(s)
        lo, hi = max(a, s["src_in"]), min(b, s["src_out"])
        if at is None:
            at = t + (lo - s["src_in"]) / rate
        removed += (hi - lo) / rate
        head = {**_part(s, s["src_in"], lo), "id": s["id"], "freeze": 0} if lo - s["src_in"] >= 0.02 else None
        tail = {**_part(s, hi, s["src_out"]), "audio_offset": None} if s["src_out"] - hi >= 0.02 else None
        if tail is None and head is not None:
            head["freeze"] = s.get("freeze") or 0
        if not head and not tail:
            removed += max(0.0, s.get("freeze") or 0)
        out += [p for p in (head, tail) if p]
        t += segment_length(s)
    if not removed or not out:
        return 0.0
    comp["segments"] = [{k: v for k, v in s.items() if v is not None} for s in out]
    inside = lambda s, e: s >= at - 1e-3 and e <= at + removed + 1e-3  # noqa: E731
    after = lambda x: x >= at + removed - 1e-3  # noqa: E731
    mv = lambda x: round(max(0.0, x - removed), 3)  # noqa: E731
    comp["overlays"] = [({**o, "start": mv(o["start"]), "end": mv(o["end"])} if after(o["start"]) else o)
                        for o in comp.get("overlays", []) if not inside(o["start"], o["end"])]
    comp["fx"] = [({**f, "start": mv(f["start"]), "end": mv(f["end"])} if after(f["start"]) else f)
                  for f in comp.get("fx") or [] if not inside(f["start"], f["end"])]
    comp["audio"] = [({**x, "start": mv(x["start"])} if x.get("kind") == "sfx" and after(x["start"]) else x)
                     for x in comp.get("audio", []) if not (x.get("kind") == "sfx" and at <= x["start"] < at + removed)]
    return round(removed, 3)


def composition_duration(c: dict) -> float:
    seg = sum(segment_length(s) for s in c.get("segments", []))
    scenes = max((s["start"] + s["duration"] for s in c.get("scenes", [])), default=0.0)
    return max(seg, scenes, 0.5)


def absolutize(c: dict, base_url: str) -> dict:
    """El renderer (Chrome sin cabeza) necesita URLs absolutas; el editor usa relativas."""
    def fix(v):
        if isinstance(v, str) and v.startswith(("/api/", "/media/")):
            return base_url + v
        if isinstance(v, dict):
            return {k: fix(x) for k, x in v.items()}
        if isinstance(v, list):
            return [fix(x) for x in v]
        return v
    return fix(c)
