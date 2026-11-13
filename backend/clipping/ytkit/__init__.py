"""Herramientas de las skills `yt-*` (github.com/Jakeschincariol/youtube-agent-skill, MIT) portadas al backend.

- `score_hook`: puntúa un gancho en 5 propiedades (concreción, se dirige a ti, qué está en juego, curiosidad,
  brevedad). El veredicto es 60 % la media y 40 % la peor: un gancho con una propiedad muerta se escapa por ahí.
- `classify`: qué fórmula de las 21 de `hooks.json` usa un título o un gancho (juicio sobre las palabras, no sobre por
  qué funcionó).

Los patrones del gancho están en inglés y en español (los clips siguen el idioma del vídeo); el idioma se detecta
solo si no se indica. Las fórmulas siguen pensadas para inglés. La heurística separa bien ganchos malos de buenos, pero no predice cuál de dos buenos funcionará más.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

HOOKS_PATH = Path(__file__).with_name("hooks.json")


@lru_cache(maxsize=1)
def _data() -> dict:
    return json.loads(HOOKS_PATH.read_text(encoding="utf-8"))


def formulas() -> list[dict]:
    return _data()["hooks"]


def rules() -> list[str]:
    return _data()["rules"]


def formulas_prompt() -> str:
    """Las 21 fórmulas en una línea cada una, para los prompts."""
    return "\n".join(f"- {f['id']}: {f['shape']} e.g. \"{f['example']}\"" for f in formulas())


def classify(text: str) -> tuple[str, str, int]:
    """(id, nombre, patrones que encajan) de la fórmula que más encaja; ("", "Sin fórmula", 0) si ninguna."""
    best, hits = None, 0
    for f in formulas():
        n = sum(1 for p in f["match"] if re.search(p, text, re.I))
        if n > hits:
            best, hits = f, n
    return (best["id"], best["name"], hits) if best else ("", "Sin fórmula", 0)


# ---------- Gancho ----------

FILLER = {"basically", "actually", "literally", "just", "really", "very", "so", "kind", "sort", "like",
          "guys", "hey", "welcome", "today", "video", "subscribe", "channel"}
VAGUE = {"amazing", "incredible", "insane", "crazy", "huge", "massive", "game", "changer", "secret",
         "powerful", "ultimate", "best", "revolutionary", "mind", "blowing", "unbelievable"}
UNITS = r"second|minute|hour|day|week|month|year|segundo|minuto|hora|d[ií]a|semana|mes|meses|año"
CONCRETE = re.compile(rf"\b(\d[\d,.]*\s?(%|k|m|x|s|m|h|€)?|\$\d|\d+\s?({UNITS})s?)\b", re.I)

# Palabras de cada idioma para las cinco propiedades. «You» en español es «tú, te, tu…»; lo que «se responde solo» es
# el gancho que explica el porqué dentro de la misma frase.
LEX = {
    "en": {
        "filler": FILLER, "vague": VAGUE,
        "you": re.compile(r"\b(you|your|you're|youre|yourself)\b", re.I),
        "stake": re.compile(r"\b(lose|lost|wasting|waste|quit|fail|broke|cost|risk|before|stop|never|die|dying|dead)\b", re.I),
        "curiosity": re.compile(r"\b(why|how|what|which|until|before|but|nobody|almost|except|reason|actually)\b", re.I),
        "closed": re.compile(r"\b(because|so that|which means)\b", re.I),
        "address_fix": "di «you» en las seis primeras palabras",
    },
    "es": {
        "filler": {"básicamente", "literalmente", "realmente", "bueno", "pues", "entonces", "hola", "chicos", "bienvenidos",
                   "hoy", "vídeo", "video", "suscríbete", "canal", "tipo", "osea", "vale", "muy"},
        "vague": {"increíble", "increible", "impresionante", "brutal", "locura", "loco", "enorme", "secreto", "definitivo",
                  "mejor", "revolucionario", "alucinante", "épico", "epico", "flipante", "bestial"},
        "you": re.compile(r"(?<!\w)(tú|tu|tus|te|ti|contigo|usted|ustedes|vosotros|os)(?!\w)", re.I),
        "stake": re.compile(r"(?<!\w)(pierdes|perder|perdiste|pierde|pierden|desperdicias|tiras|fallas|falla|fallar|arruina|"
                            r"cuesta|costó|riesgo|antes|deja de|nunca|muere|murió|muerto|morir|error|errores|ruina|caro)(?!\w)",
                            re.I),
        "curiosity": re.compile(r"(?<!\w)(por qué|cómo|qué|cuál|hasta que|antes de|pero|nadie|casi|excepto|salvo|la razón|"
                                r"en realidad|resulta que)(?!\w)", re.I),
        "closed": re.compile(r"(?<!\w)(porque|así que|lo que significa|o sea que)(?!\w)", re.I),
        "address_fix": "háblale de tú («te», «tu») en las seis primeras palabras",
    },
}
YOU, STAKE, CURIOSITY = LEX["en"]["you"], LEX["en"]["stake"], LEX["en"]["curiosity"]

_HINT = {"es": {"el", "la", "los", "las", "que", "de", "es", "por", "una", "un", "y", "en", "no", "se", "lo", "con", "para",
                "su", "esto", "este", "qué", "cómo", "pero", "más", "nadie", "tu", "te"},
         "en": {"the", "a", "is", "of", "and", "to", "you", "your", "this", "that", "it", "in", "what", "how", "why", "but",
                "nobody", "for", "with", "are", "was"}}


def hook_language(text: str) -> str:
    """«es» o «en» según las palabras frecuentes de cada idioma; en caso de duda, inglés."""
    w = _words(text)
    es = sum(x in _HINT["es"] for x in w) + 2 * bool(re.search(r"[ñáéíóú¿¡]", text.lower()))
    return "es" if es > sum(x in _HINT["en"] for x in w) else "en"


PROPERTIES = {
    "specificity": ("Concreción", "cambia un adjetivo por una cifra, un nombre o una fecha"),
    "address": ("Te habla a ti", "di «you» en las seis primeras palabras"),
    "stakes": ("Qué está en juego", "di qué le cuesta al espectador seguir como hasta ahora"),
    "curiosity": ("Curiosidad", "quita la mitad de la frase que se responde sola"),
    "brevity": ("Brevedad", "entre 9 y 24 palabras: léelo en voz alta y para donde te quedes sin aire"),
}


def _words(t: str) -> list[str]:
    return re.findall(r"[\w'%$.€]+", t.lower())


def _specificity(t: str, lx: dict) -> int:
    w = _words(t)
    if not w:
        return 0
    s = 34 + len(CONCRETE.findall(t)) * 22 - sum(x in lx["vague"] for x in w) * 16 - sum(x in lx["filler"] for x in w) * 5
    s += min(18, 6 * sum(1 for x in t.split()[1:] if x[:1].isupper()))  # nombres propios a media frase
    return max(0, min(100, s))


def _address(t: str, lx: dict) -> int:
    first = 30 if lx["you"].search(" ".join(t.split()[:6])) else 0
    return max(0, min(100, 26 + len(lx["you"].findall(t)) * 20 + first))


def _stakes(t: str, lx: dict) -> int:
    return max(0, min(100, 22 + len(lx["stake"].findall(t)) * 26 + (14 if CONCRETE.search(t) else 0)))


def _curiosity(t: str, lx: dict) -> int:
    q = 18 if t.strip().endswith("?") else 0
    closed = -18 if lx["closed"].search(t) else 0  # se responde sola
    return max(0, min(100, 24 + len(lx["curiosity"].findall(t)) * 17 + q + closed))


def _brevity(t: str, lx: dict) -> int:
    n = len(_words(t))
    if n == 0:
        return 0
    if 9 <= n <= 24:  # lo que cabe en ~10 s hablando a 150 palabras por minuto
        return 100
    if n < 9:
        return max(30, 100 - (9 - n) * 11)
    return max(10, 100 - (n - 24) * 7)


_SCORERS = {"specificity": _specificity, "address": _address, "stakes": _stakes, "curiosity": _curiosity,
            "brevity": _brevity}


def band(verdict: int) -> str:
    return "strong" if verdict >= 72 else "workable" if verdict >= 55 else "weak"


def score_hook(text: str, lang: str = "") -> dict:
    """`lang`: «en», «es» o «» (se detecta). Otros idiomas se puntúan con los patrones ingleses."""
    lang = lang if lang in LEX else hook_language(text)
    lx = LEX[lang]
    parts = {k: fn(text, lx) for k, fn in _SCORERS.items()}
    vals = list(parts.values())
    verdict = round(0.6 * (sum(vals) / len(vals)) + 0.4 * min(vals))
    fid, fname, hits = classify(text)
    weakest = min(parts, key=parts.get)
    fix = lx["address_fix"] if weakest == "address" else PROPERTIES[weakest][1]
    return {"text": text.strip(), "properties": parts, "verdict": verdict, "band": band(verdict),
            "formula": fid, "formula_name": fname, "weakest": weakest, "fix": fix, "lang": lang}


def rank_hooks(hooks: list[str], lang: str = "") -> list[dict]:
    return sorted((score_hook(h, lang) for h in hooks if h and h.strip()), key=lambda r: -r["verdict"])
