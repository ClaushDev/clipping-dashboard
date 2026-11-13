"""Efectos de edición automáticos: la IA los coloca y el usuario los retoca en el editor.

Todo son parámetros de la composición (fx, overlays, scenes[].motion), sin motor nuevo:
- cara dinámica: zoom suave mientras alguien habla y punch-in en los momentos fuertes (clips con persona);
- cifras que cuentan desde 0 cuando la voz dice un número;
- stickers/emojis que entran con pop y se quedan flotando cuando se nombra algo que tiene emoji;
- transiciones (barrido, zoom, destello, glitch) en algunos cambios de escena, nunca en todos;
- cámara en mano sobre las imágenes fijas para que no parezca un pase de diapositivas.

Los efectos automáticos llevan id «auto_…»: al volver a colocarlos se sustituyen solo esos.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .pipeline.compose import audio_source_ranges, composition_duration, segment_length, segment_local_of
from .ytkit import hook_language

AUTO = "auto_"
TRANSITIONS = ("whip", "slide", "zoom_cut", "zoom_through", "flash", "glitch", "blur", "blur_zoom", "leak")
FOCUS = (0.5, 0.4)  # en un plano vertical de una persona, la cara suele quedar en el tercio superior


@dataclass
class Options:
    speaker_zoom: bool = True
    punch_in: bool = True
    numbers: bool = True
    stickers: bool = True
    transitions: str = "some"  # none | some | many
    camera: bool = True


def options(settings) -> Options:
    if not getattr(settings, "fx_auto", True):
        return Options(False, False, False, False, "none", False)
    return Options(settings.fx_speaker_zoom, settings.fx_punch_in, settings.fx_numbers, settings.fx_stickers,
                   settings.fx_transitions, settings.fx_camera)


# ---------- Palabras en la línea de tiempo ----------

def timeline_words(comp: dict) -> list[dict]:
    """Palabras de los subtítulos con tiempos del vídeo final (los clips las guardan en segundos del original)."""
    cap = comp.get("captions") or {}
    words = cap.get("words") or []
    if cap.get("time_base") != "source":
        return sorted(words, key=lambda w: w["s"])
    out, offset = [], 0.0
    segs = comp.get("segments") or []
    for seg, (a, b) in zip(segs, audio_source_ranges(segs)):
        for w in words:
            if a <= w["s"] < b and w.get("src", seg["src"]) == seg["src"]:
                s = offset + segment_local_of(seg, w["s"] - seg["src_in"])
                out.append({**w, "s": round(s, 3), "e": round(max(s + 0.05, offset + segment_local_of(seg, w["e"] - seg["src_in"])), 3)})
        offset += segment_length(seg)
    return sorted(out, key=lambda w: w["s"])


def _clean(w: str) -> str:
    return re.sub(r"[^\w%$€£']", "", w.lower())


def speech_spans(words: list[dict], gap: float = 0.6) -> list[list[float]]:
    out: list[list[float]] = []
    for w in words:
        if out and w["s"] - out[-1][1] < gap:
            out[-1][1] = max(out[-1][1], w["e"])
        else:
            out.append([w["s"], w["e"]])
    return out


# ---------- Momentos fuertes ----------

STRONG = {
    "en": {"never", "insane", "crazy", "secret", "biggest", "worst", "best", "huge", "impossible", "shocking", "insanely",
           "nobody", "everyone", "everything", "nothing", "million", "billion", "illegal", "dead", "died", "killed",
           "first", "last", "only", "free", "wrong", "lie", "lied", "truth", "actually", "literally", "boom", "wow"},
    "es": {"nunca", "increíble", "locura", "secreto", "mayor", "peor", "mejor", "enorme", "imposible", "nadie", "todos",
           "todo", "nada", "millón", "millones", "ilegal", "muerto", "murió", "primero", "primera", "último", "única",
           "único", "gratis", "mentira", "verdad", "brutal", "bestial", "realmente", "literalmente", "jamás"},
}
NUMBER = re.compile(r"\d")


def strength(w: dict, lang: str) -> float:
    raw = w.get("w", "")
    base = _clean(raw)
    score = 0.0
    if w.get("hl"):
        score += 2
    if raw.rstrip().endswith("!"):
        score += 2
    if NUMBER.search(raw):
        score += 1.5
    if base in STRONG.get(lang, STRONG["en"]):
        score += 2
    if raw.isupper() and len(base) > 2:
        score += 1
    if raw.rstrip().endswith("?"):
        score += 0.5
    return score


def _spaced(cands: list[tuple[float, dict]], gap: float, limit: int, taken: list[float] | None = None) -> list[dict]:
    """Los mejores candidatos (puntuación, palabra) separados al menos `gap` segundos entre sí y de `taken`."""
    picked: list[dict] = []
    times = list(taken or [])
    for _, w in sorted(cands, key=lambda c: (-c[0], c[1]["s"])):
        if len(picked) >= limit:
            break
        if all(abs(w["s"] - t) >= gap for t in times):
            picked.append(w)
            times.append(w["s"])
    return sorted(picked, key=lambda w: w["s"])


def _fx(kind: str, start: float, end: float, amount: float, x: float = 0.5, y: float = 0.5, **extra) -> dict:
    return {"id": f"{AUTO}{kind}_{int(start * 100)}", "kind": kind, "start": round(max(0.0, start), 2),
            "end": round(end, 2), "x": x, "y": y, "amount": amount, **extra}


def speaker_fx(words: list[dict], total: float, opts: Options, lang: str, busy: list[tuple[float, float]]) -> list[dict]:
    """Cara dinámica: zoom lento por tramos de habla y punch-in en las palabras fuertes."""
    out: list[dict] = []
    fx_, fy = FOCUS
    if opts.speaker_zoom:
        k = 0
        for s, e in speech_spans(words):
            if e - s < 3.5:
                continue
            n = max(1, round((e - s) / 7))
            step = (e - s) / n
            for j in range(n):
                a, b = s + j * step, min(total, s + (j + 1) * step)
                if k % 2 == 0:  # uno sí, uno no: el salto de vuelta a plano abierto también marca ritmo
                    out.append(_fx("zoom", a, b, 0.1 if (k // 2) % 2 == 0 else 0.07, fx_, fy))
                k += 1
    if opts.punch_in and words:
        def free(t: float) -> bool:
            return all(not (a - 0.3 <= t <= b) for a, b in busy)
        cands = [(strength(w, lang), w) for w in words if w["s"] > 0.4 and free(w["s"]) and strength(w, lang) >= 2]
        limit = max(1, int(total / 6))
        for w in _spaced(cands, 4.5, limit):
            out.append(_fx("punch", w["s"] - 0.05, min(total, w["s"] + 1.3), 0.18, fx_, fy))
        # Movimiento en el primer segundo: la capa «se ve» del arranque
        first = words[0]
        if first["s"] < 1.0 and not any(f["kind"] == "punch" and f["start"] < 1.0 for f in out) and free(first["s"]):
            out.append(_fx("punch", first["s"], min(total, first["s"] + 1.0), 0.1, fx_, fy))
    return out


# ---------- Cifras que cuentan ----------

UNIT = {"million": "MILLION", "millions": "MILLION", "billion": "BILLION", "thousand": "THOUSAND", "percent": "%",
        "millones": "MILLONES", "millón": "MILLÓN", "mil": "MIL", "ciento": "%", "dollars": "$", "dólares": "$",
        "euros": "€", "years": "YEARS", "años": "AÑOS", "km": "KM", "kilometers": "KM", "kilómetros": "KM"}
NUM_TOKEN = re.compile(r"^([$€£]?)(\d+(?:[.,]\d+)*)(%|k|m|x)?$", re.I)


def number_overlays(words: list[dict], total: float, start_after: float) -> list[dict]:
    """Un texto grande que cuenta hasta la cifra cuando la voz la dice (sin años sueltos ni números pequeños)."""
    cands: list[tuple[float, dict]] = []
    for i, w in enumerate(words):
        m = NUM_TOKEN.match(re.sub(r"[^\w%$€£.,]", "", w.get("w", "")).rstrip(".,"))
        if not m or w["s"] < start_after:
            continue
        cur, digits, suf = m.group(1), m.group(2), (m.group(3) or "").upper()
        nxt = _clean(words[i + 1]["w"]) if i + 1 < len(words) else ""
        unit = UNIT.get(nxt, "")
        if nxt == "por" and i + 2 < len(words) and _clean(words[i + 2]["w"]) == "ciento":
            unit = "%"
        value = float(re.sub(r"[.,](?=\d{3}\b)", "", digits).replace(",", ".") or 0)
        if not (cur or suf or unit) and (value <= 10 or (len(digits) == 4 and 1500 <= value <= 2099)):
            continue
        if unit == "$" or unit == "€":
            cur, unit = unit, ""
        text = f"{cur}{digits}{suf}" + ("%" if unit == "%" else f" {unit}" if unit else "")
        cands.append((1 + bool(cur or suf or unit) + min(2, len(digits) / 3), {**w, "text": text}))
    out = []
    for w in _spaced(cands, 6, max(1, min(4, int(total / 12) + 1))):
        out.append({"id": f"{AUTO}num_{int(w['s'] * 100)}", "kind": "text", "text": w["text"], "start": round(w["s"], 2),
                    "end": round(min(total, w["s"] + 2.2), 2), "x": 0.5, "y": 0.3, "w": 0.9, "anim": "count",
                    "size": 140, "color": "#FFD400", "bg": "", "font": "Montserrat", "weight": 900})
    return out


# ---------- Stickers ----------

EMOJI = {
    "💰": ("money", "cash", "rich", "dollar", "paid", "salary", "dinero", "rico", "pasta", "sueldo", "pagar"),
    "🔥": ("fire", "hot", "burn", "fuego", "quema", "caliente"),
    "💀": ("dead", "death", "died", "kill", "muerte", "muerto", "murió", "mató"),
    "🤯": ("insane", "crazy", "unbelievable", "mindblowing", "increíble", "locura", "alucinante"),
    "😱": ("scary", "terrifying", "shock", "shocking", "miedo", "terror", "aterrador"),
    "🚀": ("rocket", "launch", "space", "skyrocket", "cohete", "espacio", "despega"),
    "⚠️": ("warning", "danger", "dangerous", "careful", "peligro", "peligroso", "cuidado"),
    "🏆": ("win", "won", "champion", "trophy", "record", "ganó", "campeón", "trofeo", "récord"),
    "💡": ("trick", "hack", "secret", "truco", "secreto"),
    "⚽": ("football", "soccer", "goal", "fútbol", "gol"),
    "📈": ("growth", "grew", "increase", "doubled", "creció", "crecimiento", "duplicó"),
    "📉": ("crash", "dropped", "fell", "collapse", "cayó", "desplome", "hundió"),
    "❤️": ("love", "heart", "amor", "corazón"),
    "👀": ("spy", "spying", "staring", "espía", "espiando"),
    "🧠": ("brain", "smart", "genius", "cerebro", "listo", "genio"),
    "⏰": ("clock", "deadline", "countdown", "reloj", "cuenta atrás", "plazo"),
}
_STEM = {k: e for e, keys in EMOJI.items() for k in keys}


def sticker_overlays(words: list[dict], total: float, start_after: float, taken: list[float]) -> list[dict]:
    cands = []
    for w in words:
        e = _STEM.get(_clean(w.get("w", "")))
        if e and w["s"] >= start_after:
            cands.append((1.0, {**w, "emoji": e}))
    out = []
    seen: set[str] = set()
    picks = _spaced(cands, 8, max(1, min(3, int(total / 15) + 1)), taken)
    for k, w in enumerate(picks):
        if w["emoji"] in seen:
            continue
        seen.add(w["emoji"])
        left = k % 2 == 1
        out.append({"id": f"{AUTO}stk_{int(w['s'] * 100)}", "kind": "text", "text": w["emoji"], "start": round(w["s"], 2),
                    "end": round(min(total, w["s"] + 2.2), 2), "x": 0.22 if left else 0.78, "y": 0.36, "w": 0.3,
                    "anim": "pop", "loop": "float", "rot": -8 if left else 8, "size": 160, "color": "#FFFFFF", "bg": "",
                    "font": "Montserrat", "weight": 400})
    return out


# ---------- Transiciones ----------

def cuts(comp: dict) -> list[float]:
    """Cambios de imagen de verdad: entre tramos, y entre escenas con otra imagen (no los planos de la misma foto)."""
    out = []
    t = 0.0
    segs = comp.get("segments") or []
    for i, seg in enumerate(segs):
        if i:
            out.append(round(t, 3))
        t += segment_length(seg)
    prev = None
    for sc in sorted(comp.get("scenes") or [], key=lambda s: s["start"]):
        key = (sc.get("kind"), sc.get("src") or (sc.get("graphic") or {}).get("component"))
        if prev is not None and key != prev and sc["start"] > 0.05:
            out.append(round(sc["start"], 3))
        prev = key
    return sorted(set(out))


def transition_fx(comp: dict, total: float, mode: str, tool: str, busy: list[tuple[float, float]]) -> list[dict]:
    if mode == "none":
        return []
    gap = 7.0 if mode == "some" else 2.5
    order = {"recycle": ("whip", "glitch", "zoom_cut", "flash"), "clip": ("zoom_cut", "flash", "whip")}.get(
        tool, ("whip", "zoom_cut", "flash"))  # «slide» (empuje completo) queda para ponerlo a mano
    out, last, k = [], -99.0, 0
    for c in cuts(comp):
        if c < 1.2 or c > total - 1.0 or c - last < gap or any(a - 0.3 <= c <= b + 0.3 for a, b in busy):
            continue
        kind = order[k % len(order)]
        if kind in ("whip", "slide"):
            out.append(_fx(kind, c - 0.2, c + 0.2, 1, dir="left" if k % 2 == 0 else "right"))
        elif kind == "zoom_cut":
            out.append(_fx(kind, c - 0.25, c + 0.25, 0.8))
        elif kind == "flash":
            out.append(_fx(kind, c - 0.04, c + 0.26, 0.85))
        else:
            out.append(_fx(kind, c - 0.15, c + 0.2, 0.6))
        last, k = c, k + 1
    return out


def pan_motion(motion: dict, index: int) -> dict:
    """Paneos: una de cada tres imágenes con un zoom centrado pasa a barrer de lado (alternando izquierda y
    derecha) con el mismo zoom. Depende solo de la posición de la escena: volver a colocarlos da lo mismo."""
    a, b = motion.get("from") or {}, motion.get("to") or {}
    centered = all(abs(float(p.get(k, 0.5)) - 0.5) < 0.02 for p in (a, b) for k in ("x", "y"))
    if index % 3 != 1 or not centered:
        return motion
    z = max(1.12, float(a.get("zoom", 1)), float(b.get("zoom", 1)))
    d = min(0.3, (z - 1) * 1.5)
    sign = 1 if (index // 3) % 2 == 0 else -1
    return {**motion, "from": {"x": round(0.5 - sign * d, 3), "y": 0.5, "zoom": round(z, 3)},
            "to": {"x": round(0.5 + sign * d, 3), "y": 0.5, "zoom": round(z, 3)}}


# ---------- Todo junto ----------

def strip(comp: dict) -> dict:
    """Quita los efectos automáticos anteriores (los «auto_…»), sin tocar lo que puso el usuario."""
    c = dict(comp)
    c["fx"] = [f for f in comp.get("fx") or [] if not str(f.get("id", "")).startswith(AUTO)]
    c["overlays"] = [o for o in comp.get("overlays") or [] if not str(o.get("id", "")).startswith(AUTO)]
    return c


def decorate(comp: dict, opts: Options, tool: str = "") -> dict:
    """Coloca los efectos automáticos. `tool`: clip (persona hablando); si falta, se deduce."""
    c = strip(comp)
    if not tool:
        tool = "clip" if (c.get("captions") or {}).get("time_base") == "source" else "studio"
    total = composition_duration(c)
    words = timeline_words(c)
    lang = hook_language(" ".join(w.get("w", "") for w in words[:200]))
    style = (c.get("captions") or {}).get("style") or {}
    hook_end = float(style.get("hook_duration") or 3) if (c.get("hook") or {}).get("text") and style.get(
        "hook_enabled", True) else 0.0
    user_fx = [(f["start"], f["end"]) for f in c["fx"]]
    user_text = [o["start"] for o in c["overlays"] if o.get("kind") in ("text", "block", "progress")]

    added: list[dict] = []
    if tool == "clip":
        added += speaker_fx(words, total, opts, lang, user_fx)
    added += transition_fx(c, total, opts.transitions, tool, user_fx)
    overlays: list[dict] = []
    if opts.numbers:
        overlays += [o for o in number_overlays(words, total, max(hook_end, 0.5))
                     if all(abs(o["start"] - t) > 2.5 for t in user_text)]
    if opts.stickers:
        overlays += sticker_overlays(words, total, max(hook_end, 0.5), user_text + [o["start"] for o in overlays])
    c["fx"] = c["fx"] + sorted(added, key=lambda f: f["start"])
    c["overlays"] = c["overlays"] + overlays

    # Transición con estilo en una escena que entraba con fundido desde negro: mejor un corte limpio debajo
    starts = {round(f["start"] + (f["end"] - f["start"]) / 2, 1) for f in added if f["kind"] in ("whip", "slide", "zoom_cut")}
    if opts.camera or starts:
        scenes = []
        for sc in c.get("scenes") or []:
            sc = dict(sc)
            if any(abs(sc["start"] - t) < 0.15 for t in starts):
                sc["transition"] = "cut"
            # La cámara que puso el usuario se respeta: el paneo automático solo toca las demás
            if opts.camera and sc.get("kind") == "image" and sc.get("motion") and not sc.get("camera"):
                sc["motion"] = pan_motion(sc["motion"], len(scenes))
                if "drift" not in sc["motion"]:
                    sc["motion"] = {**sc["motion"], "drift": 0.35}
            scenes.append(sc)
        c["scenes"] = scenes
    return c


def summary(before: dict, after: dict) -> dict:
    """Cuántos efectos automáticos hay de cada tipo (para avisar en el editor)."""
    out: dict[str, int] = {}
    for f in after.get("fx") or []:
        if str(f["id"]).startswith(AUTO):
            key = "transitions" if f["kind"] in TRANSITIONS else "zooms"
            out[key] = out.get(key, 0) + 1
    for o in after.get("overlays") or []:
        if str(o["id"]).startswith(AUTO):
            key = "numbers" if o.get("anim") == "count" else "stickers"
            out[key] = out.get(key, 0) + 1
    out["removed"] = sum(1 for f in (before.get("fx") or []) + (before.get("overlays") or [])
                         if str(f.get("id", "")).startswith(AUTO))
    return out
