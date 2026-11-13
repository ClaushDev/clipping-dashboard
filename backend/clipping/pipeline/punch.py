"""señales de viralidad sin IA. Se suman a la nota de la IA y un momento con señales muy fuertes no puede quedar
fuera aunque la IA lo puntúe bajo.

Cuatro señales, 0-100 en total:
- audio (30): el pico de volumen más fuerte dentro del clip (risas, gritos, golpes) sobre el nivel normal de la voz;
- energía (20): cuánto se acelera el habla en algún tramo de 3 s frente al ritmo normal del vídeo;
- giros (20): frases de giro o sorpresa («no puede ser», «espera…», «wait», «no way»…);
- heatmap (30): el bulto de «más vistos» de YouTube que toca el clip, cuando existe.

También propone candidatos que salen solo de las señales (puntos calientes y picos fuertes), para que la segunda
pasada de la IA los mire aunque ningún bloque los propusiera."""
from __future__ import annotations

import re
import statistics

STRONG = 65  # señales a partir de las que un momento entra sí o sí
MAX_BONUS = 15  # lo que las señales pueden sumar a la nota de la IA

# Frases de giro: sorpresa, incredulidad, revelación. Sin tildes: se comparan con el texto normalizado.
TURNS = {
    "es": ["no puede ser", "espera", "en serio", "que dices", "no me lo creo", "madre mia", "resulta que", "de repente",
           "pero entonces", "y entonces", "te lo juro", "no jodas", "flipa", "increible", "nunca", "lo peor",
           "lo mejor", "nadie", "el secreto", "la verdad es", "que fuerte", "ostia", "hostia", "dios mio", "cuidado",
           "no te lo vas a creer", "atencion"],
    "en": ["no way", "wait", "what the", "oh my god", "are you serious", "you won't believe", "turns out", "suddenly",
           "plot twist", "i swear", "holy", "never", "the worst", "the best", "nobody", "the secret", "the truth is",
           "insane", "crazy", "unbelievable", "look at this", "watch this", "here's the thing", "but then"],
    "pt": ["nao pode ser", "espera", "serio", "meu deus", "de repente", "nunca", "ninguem", "o segredo", "incrivel"],
    "fr": ["c'est pas possible", "attends", "serieux", "mon dieu", "tout a coup", "jamais", "personne", "le secret",
           "incroyable"],
    "it": ["non puo essere", "aspetta", "sul serio", "oddio", "all'improvviso", "mai", "nessuno", "il segreto",
           "incredibile"],
    "de": ["das gibt's nicht", "warte", "im ernst", "oh mein gott", "plotzlich", "niemals", "niemand", "das geheimnis",
           "unglaublich"],
}
_ACCENTS = str.maketrans("áéíóúàèìòùâêîôûäëïöüãõñç", "aeiouaeiouaeiouaeiouaonc")


def _norm(text: str) -> str:
    return re.sub(r"[^\w' ]+", " ", text.lower().translate(_ACCENTS))


def turn_phrases(text: str, lang: str) -> list[str]:
    """Frases de giro distintas que aparecen en el texto (palabras enteras)."""
    t = f" {_norm(text)} "
    found = []
    for p in TURNS.get((lang or "en")[:2], []) + ([] if (lang or "en")[:2] == "en" else TURNS["en"][:6]):
        if re.search(rf"(?<!\w){re.escape(p)}(?!\w)", t) and p not in found:
            found.append(p)
    return found


def speech_rate(words: list[dict]) -> float:
    """Palabras por segundo normales del vídeo (mediana de ventanas de 10 s con voz)."""
    if len(words) < 20:
        return 0.0
    rates, i = [], 0
    t, end = words[0]["s"], words[-1]["e"]
    while t < end:
        n = 0
        while i < len(words) and words[i]["s"] < t:
            i += 1
        j = i
        while j < len(words) and words[j]["s"] < t + 10:
            n += 1
            j += 1
        if n >= 5:
            rates.append(n / 10)
        t += 10
    return statistics.median(rates) if rates else 0.0


def rate_jump(words: list[dict], start: float, end: float, base: float) -> float:
    """El tramo de 3 s más rápido del clip frente al ritmo normal (1 = igual; 1,6 = un 60 % más rápido)."""
    inside = [w for w in words if w["s"] >= start and w["e"] <= end]
    if base <= 0 or len(inside) < 6:
        return 1.0
    best, j = 0, 0
    for i, w in enumerate(inside):
        while j < len(inside) and inside[j]["s"] < w["s"] + 3:
            j += 1
        best = max(best, j - i)
    return best / 3 / base


def _clamp(x: float) -> float:
    return min(1.0, max(0.0, x))


def signal_score(start: float, end: float, words: list[dict], sig: dict | None, lang: str = "",
                 base_rate: float | None = None) -> dict:
    """{score 0-100, parts {audio, energy, turns, heat}, notes [frases en español], turns [frases de giro]}."""
    from .heatmap import heat_of

    sig = sig or {}
    peaks = [p for p in sig.get("peaks", []) if start <= p["t"] < end]
    best_db = max((p["db"] for p in peaks), default=0.0)
    audio = 30 * _clamp((best_db - 6) / 12)
    base = speech_rate(words) if base_rate is None else base_rate
    jump = rate_jump(words, start, end, base)
    energy = 20 * _clamp((jump - 1.3) / 0.9)
    text = " ".join(w["w"] for w in words if w["s"] >= start - 0.05 and w["e"] <= end + 0.05)
    turns = turn_phrases(text, lang)
    turn_pts = 20 * min(len(turns), 3) / 3
    lift = heat_of(sig.get("heatmap"), start, end) if sig.get("heatmap") else 0.0
    heat = 30 * _clamp((lift - 1.1) / 0.6)
    parts = {"audio": round(audio), "energy": round(energy), "turns": round(turn_pts), "heat": round(heat)}
    notes = []
    if audio >= 10:
        notes.append(f"pico de audio de +{best_db:.0f} dB")
    if energy >= 7:
        notes.append(f"el habla se acelera un {round((jump - 1) * 100)} %")
    if turns:
        notes.append("giro: «" + "», «".join(turns[:3]) + "»")
    if heat >= 8:
        notes.append(f"punto caliente de YouTube (+{round((lift - 1) * 100)} %)")
    return {"score": min(100, sum(parts.values())), "parts": parts, "notes": notes, "turns": turns}


def bonus(signal: int) -> int:
    """Lo que suman las señales a la nota de la IA (0-15)."""
    return round(MAX_BONUS * signal / 100)


def spots(sig: dict | None, limit: int = 8) -> list[float]:
    """Segundos donde las señales dicen que pasa algo fuerte: puntos calientes de YouTube y picos de +12 dB o más."""
    from .heatmap import hot_spots

    sig = sig or {}
    out: list[tuple[float, float]] = []  # (fuerza, segundo)
    for h in hot_spots(sig.get("heatmap"), limit=limit):
        if h["lift"] >= 1.25:
            out.append((h["lift"] * 20, h["t"] + h["d"] / 2))
    for p in sig.get("peaks", []):
        if p["db"] >= 12:
            out.append((p["db"], p["t"]))
    out.sort(key=lambda x: -x[0])
    chosen: list[float] = []
    for _, t in out:
        if all(abs(t - c) > 20 for c in chosen):
            chosen.append(t)
        if len(chosen) >= limit:
            break
    return chosen
