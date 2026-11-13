"""El arranque de un clip en tres capas (lo que se oye, se lee y se ve), cada una 0-100, con avisos para el editor.
Lo usan los filtros de calidad (quality.py)."""
from __future__ import annotations

import re

from . import ytkit

STOP_EN = set("""a an the and or but if of to in on at for with from by as is are was were be been being it its this that
these those i you he she we they them his her our your their my me us not no so do does did have has had will would can
could just than then there here what which who whom how why when where all any each more most some such only own same
very too into out up down over under again about after before off once also like get got""".split())
STOP_ES = set("""el la los las un una unos unas de del al y o pero si no que en con por para es son fue ser lo le les
se su sus tu tus te mi mis me nos os este esta estos estas ese esa eso esto aquel como cuando donde quien cual muy
mas más ya también tambien hay porque sobre entre sin hasta desde todo toda todos todas otro otra""".split())

def _content(text: str) -> list[str]:
    return [w for w in re.findall(r"[\w']+", (text or "").lower())
            if len(w) > 2 and not w.isdigit() and w not in STOP_EN and w not in STOP_ES]


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?¿¡…])\s+", text or "") if s.strip()]


def lead(text: str, max_words: int = 24) -> str:
    """Las primeras frases hasta `max_words` palabras (al menos la primera entera). Un gancho de vídeo largo puede durar
    15 s y 40 palabras, pero lo que decide si se quedan es la frase con la que arranca: eso es lo que se puntúa."""
    out, n = [], 0
    for sent in _sentences(text):
        k = len(sent.split())
        if out and n + k > max_words:
            break
        out.append(sent)
        n += k
    return " ".join(out) or text.strip()



def hook_words(words: list[dict], window: float) -> list[dict]:
    """Las palabras del gancho hablado: lo que empieza dentro de la ventana, alargado hasta el final de la frase (sin
    pasar de 2,5 veces la ventana): un gancho cortado a media frase se puntúa mal sin motivo."""
    out = []
    for w in words:
        if w["s"] >= window * 2.5:
            break
        if w["s"] >= window and out and re.search(r"[.!?…]$", out[-1].get("w", "")):
            break
        if w["s"] >= window and not out:
            break
        out.append(w)
    return out


MOVING_FX = ("punch", "zoom", "pan", "drift", "shake", "whip", "slide", "zoom_cut", "zoom_through", "flash", "glitch",
             "blur", "blur_zoom", "leak")


def opening(comp: dict) -> dict:
    """Las tres capas del arranque, cada una 0-100, y la nota del conjunto con avisos para el editor."""
    from .quality import shots, timeline_words  # quality usa este módulo al revisar cada render
    vertical = (comp.get("aspect") or "9:16") != "16:9"
    window = 3.0 if vertical else 15.0
    issues: list[dict] = []

    def issue(layer: str, level: str, text: str, fix: str = "") -> None:
        issues.append({"layer": layer, "level": level, "text": text, "fix": fix})

    # Lo que se oye
    words = timeline_words(comp)
    spoken = hook_words(words, window)
    said = " ".join(w.get("w", "") for w in spoken).strip()
    hook = ytkit.score_hook(lead(said) if len(said.split()) > 30 else said) if len(spoken) >= 3 else None
    start = words[0]["s"] if words else None
    if start is None:
        s_score = 0 if vertical else 40
        issue("spoken", "warn", "No se oye ninguna voz en el arranque.", "Que lo primero que se oiga sea una frase que enganche.")
    else:
        s_score = hook["verdict"] if hook else 35
        if start > 0.8:
            s_score -= min(30, round((start - 0.8) * 15))
            issue("spoken", "warn", f"La voz empieza en el segundo {start:.1f}.", "Recorta el principio: la primera palabra, antes de 0,5 s.")
        if hook and hook["band"] == "weak":
            issue("spoken", "warn", f"El gancho hablado es flojo ({hook['verdict']}/100).", f"Mejora: {hook['fix']}.")
        elif hook is None:
            issue("spoken", "info", "Se dice muy poco en el arranque para puntuarlo.")
    s_score = max(0, min(100, s_score))

    # Lo que se lee
    style = (comp.get("captions") or {}).get("style") or {}
    texts = []
    if style.get("hook_enabled", True) and (comp.get("hook") or {}).get("text"):
        texts.append((0.0, comp["hook"]["text"]))
    for o in comp.get("overlays") or []:
        if o.get("kind") == "text" and o.get("start", 0) < window and o.get("text"):
            texts.append((o["start"], o["text"]))
        elif o.get("kind") == "block" and o.get("start", 0) < window:
            texts.append((o["start"], " ".join(str(v) for v in (o.get("texts") or {}).values()) or "bloque animado"))
    if not texts:
        t_score = 30 if vertical else 70
        issue("text", "warn" if vertical else "info", "No hay texto en pantalla en el arranque.",
              "Un texto corto arriba (la cifra, la pregunta o el «espera…») retiene a quien lo ve sin sonido.")
    else:
        t_score = 100
        first_at, first = min(texts)
        n = len(re.findall(r"[\w']+", first))
        if n > 8:
            t_score -= 25
            issue("text", "warn", f"El texto del arranque tiene {n} palabras: no da tiempo a leerlo.", "Déjalo en 3-7 palabras.")
        if first_at > 0.5:
            t_score -= 15
            issue("text", "info", f"El texto aparece en el segundo {first_at:.1f}.", "Que esté desde el primer fotograma.")
        shared = set(_content(first)) & set(_content(said))
        if said and _content(first) and len(shared) / len(set(_content(first))) > 0.6:
            t_score -= 20
            issue("text", "info", "El texto repite lo que dice la voz.", "Que añada algo: la cifra, la pregunta o lo que está en juego.")
    t_score = max(0, min(100, t_score))

    # Lo que se ve
    shot_list = shots(comp)
    fx = comp.get("fx") or []
    events = sorted({round(s["start"], 2) for s in shot_list}
                    | {round(o.get("start", 0), 2) for o in comp.get("overlays") or [] if o.get("kind") != "progress"}
                    | {round(f["start"], 2) for f in fx}
                    | {round(k.get("t", 0), 2) for s in comp.get("segments") or [] for k in s.get("keys") or []})
    first_change = next((e for e in events if e > 0.05), None)
    limit = 1.5 if vertical else 4.0
    v_score = 100
    if first_change is None or first_change > limit:
        v_score -= 35
        when = f"en el segundo {first_change:.1f}" if first_change else "nunca"
        issue("visual", "warn", f"El primer cambio de imagen llega {when}.",
              f"Un corte, un zoom o un texto antes de {limit:g} s.")
    moving = any(f["start"] < 1.0 and f.get("kind") in MOVING_FX for f in fx)
    first_scene = next((s for s in shot_list if s["start"] < 0.05), None)
    if first_scene and first_scene["kind"] == "image" and not moving:
        static = not any(sc.get("motion") for sc in comp.get("scenes") or [] if sc.get("start", 0) < 0.05)
        v_score -= 25 if static else 10
        issue("visual", "warn" if static else "info", "El vídeo abre con una imagen fija" + (" sin movimiento." if static else "."),
              "Abre con vídeo o con un punch-in o un zoom en el primer segundo.")
    if vertical and not any(a.get("kind") == "sfx" and a.get("start", 0) < 1.0 for a in comp.get("audio") or []) and not moving:
        v_score -= 10
        issue("visual", "info", "Nada marca el primer segundo (ni efecto de cámara ni sonido).",
              "Un whoosh o un punch-in al empezar ayuda a frenar el deslizamiento.")
    v_score = max(0, min(100, v_score))

    weights = (0.45, 0.25, 0.30) if vertical else (0.6, 0.1, 0.3)
    total = round(weights[0] * s_score + weights[1] * t_score + weights[2] * v_score)
    return {"score": total, "band": ytkit.band(total), "window": window,
            "layers": {"spoken": {"score": s_score, "text": said, "start": start, "hook": hook},
                       "text": {"score": t_score, "texts": [t for _, t in sorted(texts)][:3]},
                       "visual": {"score": v_score, "first_change": first_change}},
            "issues": issues}
