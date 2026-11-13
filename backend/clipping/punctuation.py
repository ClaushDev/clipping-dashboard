"""Puntuación de las transcripciones.

Whisper suele devolver puntos, comas e interrogaciones, pero a veces los deja de poner durante un rato largo (al
encadenar segmentos sin signos se «contagia») y solo quedan mayúsculas sueltas. Aquí:
- `initial_prompt(lang)`: una frase bien puntuada en el idioma del vídeo para que Whisper arranque puntuando.
- `missing_runs(words)`: los tramos largos sin ningún signo.
- `restore(words, provider, lang)`: pide a un modelo barato (Ollama o, si no está, Haiku) que puntúe esos tramos y
  copia solo los signos y las mayúsculas sobre las palabras: nunca cambia, añade ni quita palabras ni tiempos.
"""
from __future__ import annotations

import logging
import re
from difflib import SequenceMatcher

log = logging.getLogger("clipping.punctuation")

PUNCT = re.compile(r"[.,!?;:…¿¡]")
RUN_MIN = 22  # palabras seguidas sin signos a partir de las que se restaura
BATCH = 160  # palabras por llamada al modelo
CONTEXT = 6  # palabras de contexto a cada lado de un tramo

# Una frase con puntos, comas, interrogación y exclamación en cada idioma: Whisper imita el estilo del prompt.
PROMPTS = {
    "es": "Hola, ¿qué tal? Bien, gracias. Hoy os cuento algo increíble, de verdad. ¡Vamos!",
    "en": "Hello, how are you? Fine, thanks. Today I'll tell you something incredible, really. Let's go!",
    "pt": "Olá, tudo bem? Tudo, obrigado. Hoje vou contar algo incrível, de verdade. Vamos lá!",
    "fr": "Bonjour, ça va ? Oui, merci. Aujourd'hui je vais vous raconter un truc incroyable, vraiment. Allez !",
    "it": "Ciao, come stai? Bene, grazie. Oggi vi racconto una cosa incredibile, davvero. Andiamo!",
    "de": "Hallo, wie geht's? Gut, danke. Heute erzähle ich euch etwas Unglaubliches, wirklich. Los geht's!",
    "ca": "Hola, com va? Bé, gràcies. Avui us explico una cosa increïble, de veritat. Som-hi!",
}


def initial_prompt(lang: str) -> str | None:
    return PROMPTS.get((lang or "").split("-")[0].lower())


def norm(word: str) -> str:
    """La palabra sin signos ni mayúsculas: lo que no puede cambiar al puntuar."""
    return re.sub(r"[^\w'’-]", "", word.lower())


def missing_runs(words: list[dict], min_len: int = RUN_MIN) -> list[tuple[int, int]]:
    """Tramos [i, j) de al menos `min_len` palabras seguidas sin ningún signo de puntuación."""
    runs, start = [], 0
    for k, w in enumerate(words + [{"w": "."}]):
        if PUNCT.search(w["w"]):
            if k - start >= min_len:
                runs.append((start, k))
            start = k + 1
    return runs


def stats(words: list[dict]) -> dict:
    """Cuántas palabras llevan signo y cuántas están en tramos largos sin ninguno (para el panel)."""
    runs = missing_runs(words)
    return {"words": len(words), "with_punct": sum(1 for w in words if PUNCT.search(w["w"])),
            "missing": sum(j - i for i, j in runs), "runs": len(runs)}


PROMPT = """Add punctuation and capitalization to this {lang} speech transcript (a spoken clip, informal).
Rules: keep EVERY word exactly as it is and in the same order. Do not add, remove, translate or fix any word.
Only add punctuation marks ({marks}) and change capital letters where a sentence starts.
Reply only with JSON: {{"text": "<the punctuated transcript>"}}

Transcript:
{text}"""


def _apply(words: list[dict], text: str) -> int:
    """Copia signos y mayúsculas de `text` sobre `words` (en el sitio) si cada palabra coincide sin signos."""
    tokens = [t for t in text.split() if norm(t) or PUNCT.fullmatch(t.strip())]
    # Signos sueltos («¿ Qué», «hola ,»): se pegan a la palabra vecina
    merged: list[str] = []
    lead = ""
    for t in tokens:
        if not norm(t):
            if t.strip() in ("¿", "¡"):
                lead += t.strip()
            elif merged:
                merged[-1] += t.strip()
            continue
        merged.append(lead + t)
        lead = ""
    a = [norm(w["w"]) for w in words]
    b = [norm(t) for t in merged]
    changed = 0
    for tag, i0, i1, j0, j1 in SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag != "equal":
            continue
        for k in range(i1 - i0):
            new = merged[j0 + k]
            if new != words[i0 + k]["w"]:
                words[i0 + k]["w"] = new
                changed += 1
    return changed


def restore(words: list[dict], provider, lang: str = "") -> tuple[list[dict], int]:
    """Devuelve (palabras, cuántas cambiaron). Solo toca los tramos largos sin signos; las palabras con signos que ya
    estaban bien no se reescriben. Si el modelo falla en un tramo, ese tramo se queda como estaba."""
    out = [dict(w) for w in words]
    runs = missing_runs(out)
    if not runs:
        return out, 0
    marks = "¿ ? ¡ ! . , ; :" if (lang or "").startswith("es") else ". , ? ! ; :"
    for i, j in runs:
        for b0 in range(i, j, BATCH):
            b1 = min(j, b0 + BATCH)
            lo, hi = max(0, b0 - CONTEXT), min(len(out), b1 + CONTEXT)
            text = " ".join(w["w"] for w in out[lo:hi])
            try:
                res = provider.complete_json(PROMPT.format(lang=lang or "the original language", marks=marks, text=text),
                                             task="punctuation")
            except Exception as exc:  # noqa: BLE001 — sin modelo, se queda sin signos (no se rompe nada)
                log.warning("No se pudo restaurar la puntuación: %s", exc)
                continue
            got = str((res or {}).get("text") or "")
            if not got:
                continue
            seg = out[lo:hi]
            before = [w["w"] for w in seg]
            _apply(seg, got)
            # Solo se aceptan los cambios dentro del tramo; el contexto se restaura salvo su signo final
            for k, w in enumerate(seg):
                pos = lo + k
                if b0 <= pos < b1 or (pos == b0 - 1 and not PUNCT.search(before[k])):
                    out[pos] = w
                else:
                    w["w"] = before[k]
    return out, sum(1 for x, y in zip(words, out) if x["w"] != y["w"])
