"""Selección de momentos virales con un LLM y ajuste de los cortes a límites de palabra/frase."""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Callable

from ..llm.base import LLMProvider

log = logging.getLogger("clipping.moments")

# rúbrica de «punch». Los momentos correctos pero planos se quedaban arriba; con la rúbrica, la nota mira lo que
# hace que un clip se comparta.
PUNCH_KEYS = ("hook", "tension", "emotion", "standalone", "quotable")
RUBRIC = """
PUNCH RUBRIC (score each 0-20; a moment's score is roughly their sum):
- hook: the first 2 seconds stop the scroll (bold claim, question, conflict, shout, striking image).
- tension: it builds tension and pays it off (setup, then punchline, reveal or twist), not a flat explanation.
- emotion: a clear emotion the viewer feels (laughter, shock, anger, awe, tenderness, cringe).
- standalone: someone who never saw this creator understands it with zero context.
- quotable: it has a line people would quote, argue with or write in the comments.
Correct but flat moments (informative, no tension, no emotion) score low even if they are on topic.
"""
PUNCH_SCHEMA = {"type": "object", "properties": {k: {"type": "integer"} for k in PUNCH_KEYS}}

PROMPT = """You are a senior short-form video editor. You find the moments in long-form videos that become viral YouTube Shorts and TikToks.

Niche: {niche}
Extra guidance from the user: {guidance}
The video is in {language}. Write title, hook and tags in {language} (the language its audience speaks) and the reason in Spanish (it is read by the editor). Never penalize a moment for its language.
{brief}{refs}
Below is a transcript excerpt with timestamps in seconds. Find up to {k} moments that work as standalone vertical clips of {min_d:.0f}-{max_d:.0f} seconds.

A great moment:
- Opens with a strong hook in its first 3 seconds: a bold claim, surprising fact, question, conflict or emotional peak. It never starts mid-sentence or with filler ("so", "and", "um", "yeah").
- Is self-contained: a viewer with zero context understands it.
- Has a payoff before it ends (punchline, insight, answer or twist) and ends on a complete sentence.
- Is specific and concrete (numbers, stories, contrarian takes) rather than generic advice.

Skip intros, sponsor reads, housekeeping and small talk. Only return genuinely strong moments; returning fewer, or none, is fine.
{rubric}

For each moment return:
- start, end: seconds, taken from the transcript timestamps ({min_d:.0f}-{max_d:.0f} s long)
- title: YouTube Shorts title, max 70 characters, curiosity-driven but truthful, no hashtags
- hook: on-screen text shown during the first seconds, max 8 words, in {language}
- reason: one sentence in Spanish on why it will retain viewers
- score: 0-100 predicted viral potential, roughly the sum of the punch rubric. Be strict: 80+ only for exceptional moments.
- punch: the rubric breakdown, 0-20 each
- tags: 1-4 short topic tags
- hook_start, hook_end: a COLD OPEN, only when the natural first seconds are weak but the moment contains a stronger
  2-4 second line or reaction later on (the punchline, a shout, a shocking sentence). Seconds from the transcript,
  inside start-end and not in its first 3 seconds; the clip will show that bit first and then play from the start.
  Use 0 and 0 when the natural opening already hooks.

Respond with JSON only, in exactly this shape:
{{"moments": [{{"start": 0.0, "end": 0.0, "title": "", "hook": "", "reason": "", "score": 0, "punch": {{"hook": 0, "tension": 0, "emotion": 0, "standalone": 0, "quotable": 0}}, "tags": [""], "hook_start": 0.0, "hook_end": 0.0}}]}}

TRANSCRIPT ({chunk_start:.0f}s - {chunk_end:.0f}s):
{transcript}
{signals}{visual}"""

# la idea general del vídeo, sacada de la transcripción entera antes de buscar momentos. Sin ella, cada bloque se
# juzgaba sin saber de qué va el vídeo y las notas de bloques distintos no se podían comparar.
BRIEF_PROMPT = """You are a senior short-form video editor about to cut a long video into YouTube Shorts / TikToks.
Before looking for moments, read the whole transcript below (it may be sampled) and write the brief of the video.

Niche: {niche}
Extra guidance from the user: {guidance}

Answer in Spanish (the editor reads it), with JSON only:
{{"topic": "what the video is about, 1-2 sentences",
 "tone": "tone and format: interview, tutorial, comedy, debate, vlog…",
 "audience": "who watches this and what they want from it",
 "good_moment": "for THIS video: what a great standalone clip looks like (the kind of story, claim, reaction or payoff that works here), 2-3 sentences",
 "avoid": "what to skip in THIS video (recurring filler, inside jokes that need context, sponsor reads…), 1-2 sentences"}}

TRANSCRIPT ({duration:.0f} s, in {language}):
{transcript}"""

BRIEF_SCHEMA = {
    "type": "object",
    "properties": {k: {"type": "string"} for k in ("topic", "tone", "audience", "good_moment", "avoid")},
    "required": ["topic", "tone", "audience", "good_moment", "avoid"],
}
BRIEF_FIELDS = ("topic", "tone", "audience", "good_moment", "avoid")

# segunda pasada. Los candidatos de todos los bloques se puntúan juntos, con la misma vara (la idea general).
RANK_PROMPT = """You are a senior short-form video editor. Candidate clips were found in different parts of one long
video. Score them all together, with the same yardstick, so the best {count} can be published as YouTube Shorts.

Niche: {niche}
Extra guidance from the user: {guidance}
{brief}{refs}{examples}{viral}{rubric}
For every candidate return:
- index: the candidate number
- score: 0-100 viral potential compared with the OTHER candidates of this video, roughly the sum of the punch rubric.
  Be strict: 80+ only for exceptional clips; a clip that needs context or does not fit what works in this video goes
  below 50.
- punch: the rubric breakdown, 0-20 each
- reason: one sentence in Spanish on why it will (or will not) retain viewers, saying how it fits the video's idea
  (and the editor's past choices, when they apply).

Respond with JSON only: {{"ranking": [{{"index": 1, "score": 0, "punch": {{"hook": 0, "tension": 0, "emotion": 0, "standalone": 0, "quotable": 0}}, "reason": ""}}]}}

CANDIDATES:
{candidates}"""

RANK_SCHEMA = {
    "type": "object",
    "properties": {"ranking": {"type": "array", "items": {
        "type": "object",
        "properties": {"index": {"type": "integer"}, "score": {"type": "integer"}, "punch": PUNCH_SCHEMA,
                       "reason": {"type": "string"}},
        "required": ["index", "score", "reason"]}}},
    "required": ["ranking"],
}

# tercera pasada, «abogado del diablo». Revisa lo que se quedó fuera (y lo que solo vieron las señales) buscando
# lo que las otras pasadas no supieron ver.
ADVOCATE_PROMPT = """You are the devil's advocate on a team of short-form video editors. The team already picked the
best clips of one long video. Your job is to find what they MISSED among the clips they left out: a raw reaction, a
payoff, a twist, a line people would quote, a moment viewers rewatched (see the signals). Be fair: most left-out clips
deserve to stay out, so only score high what truly beats the weakest selected clips.

Niche: {niche}
Extra guidance from the user: {guidance}
The video is in {language}. Write title and hook in {language}; the reason in Spanish (the editor reads it).
{brief}{refs}{viral}{rubric}
SELECTED (for reference, with their scores):
{selected}

LEFT OUT (signals = evidence measured without AI: audio peaks, speech energy, turn phrases, YouTube most-replayed):
{candidates}

For EVERY left-out clip return index, score (0-100, the same scale as the selected ones), punch (0-20 each), title
(max 70 characters, curiosity-driven but truthful), hook (on-screen text, max 8 words) and reason (one sentence in
Spanish: what the others missed, or why it stays out).
Respond with JSON only: {{"review": [{{"index": 1, "score": 0, "punch": {{"hook": 0, "tension": 0, "emotion": 0, "standalone": 0, "quotable": 0}}, "title": "", "hook": "", "reason": ""}}]}}"""

ADVOCATE_SCHEMA = {
    "type": "object",
    "properties": {"review": {"type": "array", "items": {
        "type": "object",
        "properties": {"index": {"type": "integer"}, "score": {"type": "integer"}, "punch": PUNCH_SCHEMA,
                       "title": {"type": "string"}, "hook": {"type": "string"}, "reason": {"type": "string"}},
        "required": ["index", "score", "reason"]}}},
    "required": ["review"],
}

SCHEMA = {
    "type": "object",
    "properties": {
        "moments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "title": {"type": "string"},
                    "hook": {"type": "string"},
                    "reason": {"type": "string"},
                    "score": {"type": "integer"},
                    "punch": PUNCH_SCHEMA,
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "hook_start": {"type": "number"},
                    "hook_end": {"type": "number"},
                },
                "required": ["start", "end", "title", "hook", "reason", "score", "tags"],
            },
        }
    },
    "required": ["moments"],
}

LANGUAGE_NAMES = {"es": "Spanish", "en": "English", "pt": "Portuguese", "fr": "French", "de": "German", "it": "Italian",
                  "ca": "Catalan", "nl": "Dutch", "ja": "Japanese", "ko": "Korean", "ru": "Russian"}


def language_name(transcript: dict) -> str:
    code = (transcript.get("language") or "en").lower()
    return LANGUAGE_NAMES.get(code, code)


SENTENCE_END = (".", "?", "!", "…", '."', '?"', '!"')


@dataclass(eq=False)  # se compara por identidad (la bolsa de descartados)
class Moment:
    start: float
    end: float
    title: str
    hook: str
    reason: str
    score: int
    tags: list[str] = field(default_factory=list)
    hook_start: float = 0  # gancho adelantado (cold open): tramo que se ve primero; 0-0 = sin él
    hook_end: float = 0
    # desglose de la nota
    ai_score: int = 0  # la nota de la IA antes de sumar las señales
    punch: dict = field(default_factory=dict)  # rúbrica de punch (hook, tension, emotion, standalone, quotable: 0-20)
    signals: dict = field(default_factory=dict)  # punch.signal_score: {score, parts, notes}
    via: str = ""  # "" = elegido por la IA · advocate = rescatado en la segunda pasada · signals = entra por sus señales
    discard: str = ""  # por qué se quedó fuera (solo en los descartados)

    def breakdown(self) -> dict:
        """Lo que se guarda en el clip y en la bolsa de descartados para enseñar el desglose."""
        return {"ai": self.ai_score, "punch": self.punch, "signals": self.signals, "via": self.via}


def parse_punch(raw) -> dict:
    """La rúbrica que devuelve la IA, limpia (0-20 por apartado); {} si no viene."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k in PUNCH_KEYS:
        try:
            out[k] = max(0, min(20, int(raw.get(k) or 0)))
        except (TypeError, ValueError):
            out[k] = 0
    return out if any(out.values()) else {}


def cold_open(raw: dict, start: float, end: float, words: list[dict]) -> tuple[float, float]:
    """El tramo de gancho adelantado que propone el LLM, ajustado a palabras enteras: 1,5-4,5 s, dentro del clip y
    después de sus 3 primeros segundos. (0, 0) si no hay o no es válido."""
    try:
        a, b = float(raw.get("hook_start") or 0), float(raw.get("hook_end") or 0)
    except (TypeError, ValueError):
        return 0.0, 0.0
    if b <= a or a < start + 3 or b > end:
        return 0.0, 0.0
    inside = [w for w in words if w["s"] >= a - 0.3 and w["e"] <= b + 0.3 and w["s"] >= start]
    if inside:
        a, b = inside[0]["s"], inside[-1]["e"]
    a, b = round(max(start, a - 0.08), 3), round(min(end, b + 0.15), 3)
    if not 1.5 <= b - a <= 4.5:
        return 0.0, 0.0
    return a, b


def _ends_sentence(word: str) -> bool:
    return word.endswith(SENTENCE_END)


def build_chunks(segments: list[dict], chunk_seconds: float, overlap: float) -> list[tuple[float, float, list[dict]]]:
    if not segments:
        return []
    total = segments[-1]["e"]
    chunks = []
    start = 0.0
    while start < total:
        end = start + chunk_seconds
        segs = [s for s in segments if s["e"] > start and s["s"] < end]
        if segs:
            chunks.append((segs[0]["s"], segs[-1]["e"], segs))
        if end >= total:
            break
        start = end - overlap
    return chunks


def snap(start: float, end: float, words: list[dict], min_d: float, max_d: float,
         media_duration: float) -> tuple[float, float] | None:
    """Ajusta un corte propuesto para que empiece al inicio de una frase y termine en un final de frase."""
    if not words:
        return None
    i = next((k for k, w in enumerate(words) if w["s"] >= start - 0.5), None)
    if i is None:
        return None
    # Si el LLM cortó a mitad de frase, avanza hasta el inicio de la siguiente (máx. 2,5 s).
    if i > 0 and not _ends_sentence(words[i - 1]["w"]):
        for k in range(i + 1, len(words)):
            if words[k]["s"] - words[i]["s"] > 2.5:
                break
            if _ends_sentence(words[k - 1]["w"]):
                i = k
                break
    s = words[i]["s"]

    j = max((k for k in range(i, len(words)) if words[k]["e"] <= end + 0.5), default=i)
    if not _ends_sentence(words[j]["w"]):
        for k in range(j + 1, len(words)):
            if words[k]["e"] - s > max_d or words[k]["e"] - words[j]["e"] > 4:
                break
            if _ends_sentence(words[k]["w"]):
                j = k
                break

    if words[j]["e"] - s < min_d:
        k = j
        while k + 1 < len(words) and words[k + 1]["e"] - s <= max_d:
            k += 1
            if words[k]["e"] - s >= min_d and _ends_sentence(words[k]["w"]):
                break
        j = k

    if words[j]["e"] - s > max_d:
        within = [k for k in range(i, j + 1) if words[k]["e"] - s <= max_d]
        if not within:
            return None
        sentence_ends = [k for k in within if _ends_sentence(words[k]["w"]) and words[k]["e"] - s >= min_d]
        j = sentence_ends[-1] if sentence_ends else within[-1]

    e = words[j]["e"]
    if e - s < min_d * 0.75:
        return None
    return round(max(0.0, s - 0.12), 3), round(min(media_duration, e + 0.35), 3)


def _overlap_ratio(a: Moment, b: Moment) -> float:
    inter = min(a.end, b.end) - max(a.start, b.start)
    if inter <= 0:
        return 0.0
    return inter / min(a.end - a.start, b.end - b.start)


def dedupe(moments: list[Moment]) -> list[Moment]:
    kept: list[Moment] = []
    for m in sorted(moments, key=lambda m: m.score, reverse=True):
        if all(_overlap_ratio(m, k) < 0.4 for k in kept):
            kept.append(m)
    return kept


SCORE_PROMPT = """You are a senior short-form video editor. A human editor hand-picked the clips below from a long-form video to publish as YouTube Shorts / TikToks.

Niche: {niche}
Extra guidance from the user: {guidance}
The video is in {language}. Write title, hook and tags in {language} (the language its audience speaks) and the reason in Spanish (it is read by the editor). Never penalize a moment for its language.

For every clip return, in the same order:
- index: the clip number
- title: YouTube Shorts title, max 70 characters, curiosity-driven but truthful, no hashtags
- hook: on-screen text shown during the first seconds, max 8 words, in {language}
- reason: one sentence in Spanish on why it will (or will not) retain viewers; mention a weak opening or ending if there is one
- score: 0-100 predicted viral potential. Be strict and honest: 80+ only for exceptional clips.
- tags: 1-4 short topic tags

Respond with JSON only, in exactly this shape:
{{"clips": [{{"index": 1, "title": "", "hook": "", "reason": "", "score": 0, "tags": [""]}}]}}

CLIPS:
{clips}
"""

SCORE_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "title": {"type": "string"},
                    "hook": {"type": "string"},
                    "reason": {"type": "string"},
                    "score": {"type": "integer"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["index", "title", "hook", "reason", "score", "tags"],
            },
        }
    },
    "required": ["clips"],
}


def snap_to_words(start: float, end: float, words: list[dict], media_duration: float) -> tuple[float, float]:
    """Ajuste suave de un corte manual: no corta palabras a medias (empieza y termina en límites de palabra)."""
    inside = [w for w in words if w["e"] > start + 0.05 and w["s"] < end - 0.05]
    if not inside:
        return round(start, 3), round(end, 3)
    s = min(start, inside[0]["s"]) if inside[0]["s"] - start < 0.6 else start
    e = max(end, inside[-1]["e"]) if end - inside[-1]["e"] < 0.6 else end
    return round(max(0.0, s - 0.08), 3), round(min(media_duration or e + 0.3, e + 0.25), 3)


def score_ranges(transcript: dict, ranges: list[tuple[float, float]], provider: LLMProvider, *,
                 niche: str = "", guidance: str = "", batch: int = 8) -> list[Moment | None]:
    """Puntúa clips elegidos a mano (título, gancho, motivo, puntuación). Devuelve None en los que la IA omita."""
    words = transcript["words"]
    out: list[Moment | None] = [None] * len(ranges)
    for b in range(0, len(ranges), batch):
        part = ranges[b:b + batch]
        blocks = []
        for n, (start, end) in enumerate(part, 1):
            text = " ".join(w["w"] for w in words if w["s"] >= start - 0.05 and w["e"] <= end + 0.05)
            blocks.append(f"[{n}] ({end - start:.0f} s) {text}")
        data = provider.complete_json(SCORE_PROMPT.format(niche=niche or "general", guidance=guidance or "none",
                                                          language=language_name(transcript),
                                                          clips="\n\n".join(blocks)), SCORE_SCHEMA, task="score")
        for raw in data.get("clips", []):
            try:
                i = int(raw["index"]) - 1
            except (KeyError, TypeError, ValueError):
                continue
            if not 0 <= i < len(part):
                continue
            start, end = part[i]
            out[b + i] = Moment(
                start=start, end=end, title=str(raw.get("title", ""))[:100].strip(),
                hook=str(raw.get("hook", "")).strip(), reason=str(raw.get("reason", "")).strip(),
                score=max(0, min(100, int(raw.get("score", 0) or 0))),
                tags=[str(t) for t in raw.get("tags", [])][:4],
            )
    return out


def sample_text(segments: list[dict], limit: int = 16000) -> str:
    """La transcripción en líneas con su segundo; si no cabe, tramos repartidos por todo el vídeo (no solo el principio)."""
    lines = [f"[{s['s']:.0f}] {s['text']}" for s in segments if s.get("text")]
    if sum(len(x) + 1 for x in lines) <= limit:
        return "\n".join(lines)
    parts, n = [], 12  # 12 tramos seguidos, repartidos a lo largo del vídeo
    per = limit // n
    for i in range(n):
        at, size, block = len(lines) * i // n, 0, []
        while at < len(lines) and size + len(lines[at]) < per:
            block.append(lines[at])
            size += len(lines[at]) + 1
            at += 1
        parts.append("\n".join(block))
    return "\n[…]\n".join(parts)


def video_brief(transcript: dict, provider: LLMProvider, *, niche: str = "", guidance: str = "") -> dict:
    """la idea general del vídeo (tema, tono, público, qué es un buen momento aquí y qué evitar)."""
    segments = transcript.get("segments") or []
    duration = transcript.get("duration") or (segments[-1]["e"] if segments else 0)
    data = provider.complete_json(BRIEF_PROMPT.format(
        niche=niche or "general", guidance=guidance or "none", duration=duration,
        language=language_name(transcript), transcript=sample_text(segments)), BRIEF_SCHEMA, task="moments")
    return {k: str(data.get(k, "")).strip()[:600] for k in BRIEF_FIELDS}


def brief_text(brief: dict | None) -> str:
    """El bloque de la idea general para los prompts ("" si no hay)."""
    if not brief or not any(str(brief.get(k, "")).strip() for k in BRIEF_FIELDS):
        return ""
    names = {"topic": "Topic", "tone": "Tone/format", "audience": "Audience",
             "good_moment": "A great clip in THIS video", "avoid": "Avoid in THIS video"}
    lines = [f"- {names[k]}: {str(brief[k]).strip()}" for k in BRIEF_FIELDS if str(brief.get(k, "")).strip()]
    return ("\nTHE IDEA OF THIS VIDEO (written after reading the whole transcript; the editor may have corrected it). "
            "Judge every moment against it:\n" + "\n".join(lines) + "\n")


def _excerpt(words: list[dict], start: float, end: float, head: int = 55, tail: int = 20) -> str:
    inside = [w["w"] for w in words if w["s"] >= start - 0.05 and w["e"] <= end + 0.05]
    if len(inside) <= head + tail:
        return " ".join(inside)
    return " ".join(inside[:head]) + " […] " + " ".join(inside[-tail:])


def rank_moments(candidates: list[Moment], transcript: dict, provider: LLMProvider, *, count: int,
                 brief: dict | None = None, niche: str = "", guidance: str = "", examples: str = "",
                 viral: str = "", refs: str = "") -> list[Moment]:
    """puntúa todos los candidatos juntos con la idea general y los ordena. `examples`: clips que el editor
    aprobó o descartó antes (moment_eval.examples_text), para que la nota se parezca a su criterio. Si la IA falla, quedan las notas de
    cada bloque. Solo se repuntúan los mejores (3 por clip pedido, 12 como mínimo); el resto queda detrás.
    `viral`: ejemplos de clips virales como referencia (opcional)."""
    pool = sorted(candidates, key=lambda m: m.score, reverse=True)
    size = max(12, count * 3)
    top, rest = pool[:size], pool[size:]
    if len(top) < 2:
        return pool
    words = transcript["words"]
    blocks = [f"[{i}] {m.start:.0f}-{m.end:.0f}s ({m.end - m.start:.0f} s) · first-pass score {m.score} · "
              f"{m.title}\n{_excerpt(words, m.start, m.end)}" for i, m in enumerate(top, 1)]
    try:
        data = provider.complete_json(RANK_PROMPT.format(
            count=count, niche=niche or "general", guidance=guidance or "none", brief=brief_text(brief), examples=examples,
            viral=viral_text(viral), refs=refs, rubric=RUBRIC, candidates="\n\n".join(blocks)), RANK_SCHEMA, task="moments")
    except Exception:  # noqa: BLE001 — sin la segunda pasada siguen valiendo las notas de cada bloque
        log.exception("Fallo al puntuar los candidatos juntos; se quedan las notas de cada bloque")
        return pool
    seen: set[int] = set()
    for raw in data.get("ranking", []):
        try:
            i = int(raw["index"]) - 1
            score = max(0, min(100, int(raw.get("score", 0) or 0)))
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= i < len(top) and i not in seen:
            seen.add(i)
            top[i].score = score
            if reason := str(raw.get("reason", "")).strip():
                top[i].reason = reason
            if punch := parse_punch(raw.get("punch")):
                top[i].punch = punch
    if not seen:  # respuesta vacía o rara: mejor las notas de cada bloque que nada
        return pool
    for i, m in enumerate(top):  # los que la IA se saltó no ganan a los que sí puntuó
        if i not in seen:
            m.score = min(m.score, 40)
    return sorted(top, key=lambda m: m.score, reverse=True) + rest


def visual_block(ctx: dict | None, start: float, end: float, limit: int = 5000) -> str:
    """Lo que se ve en el bloque, si hay una transcripción visual. Esta herramienta no la genera: siempre vacío."""
    return ""


def viral_text(viral: str) -> str:
    """El bloque de ejemplos virales para los prompts."""
    if not viral.strip():
        return ""
    return ("\nWHAT GOES VIRAL IN THIS NICHE (reference only: the mechanics, never the content):\n" + viral.strip() + "\n")


def _signal_lines(m: Moment) -> str:
    sg = m.signals or {}
    if not sg.get("notes"):
        return "no strong signals"
    return f"signals {sg.get('score', 0)}/100: " + "; ".join(sg["notes"])


def advocate(selected: list[Moment], left: list[Moment], transcript: dict, provider: LLMProvider, *,
             brief: dict | None = None, niche: str = "", guidance: str = "", viral: str = "", refs: str = "") -> int:
    """tercera pasada. La IA revisa los descartados (y los candidatos que solo vieron las señales) y les pone nota,
    título y gancho. Devuelve cuántos revisó; si falla, nada cambia."""
    if not left or not selected:
        return 0
    words = transcript["words"]
    sel = "\n".join(f"- {m.start:.0f}-{m.end:.0f}s · score {m.score} · {m.title}" for m in selected)
    blocks = [f"[{i}] {m.start:.0f}-{m.end:.0f}s ({m.end - m.start:.0f} s) · "
              + (f"first-pass score {m.ai_score} · {m.title} · " if m.title else "found only by the signals · ")
              + f"{_signal_lines(m)}\n{_excerpt(words, m.start, m.end)}" for i, m in enumerate(left, 1)]
    try:
        data = provider.complete_json(ADVOCATE_PROMPT.format(
            niche=niche or "general", guidance=guidance or "none", language=language_name(transcript),
            brief=brief_text(brief), refs=refs, viral=viral_text(viral), rubric=RUBRIC, selected=sel,
            candidates="\n\n".join(blocks)), ADVOCATE_SCHEMA, task="moments")
    except Exception:  # noqa: BLE001 — sin abogado del diablo se queda la selección de antes
        log.exception("Fallo en la pasada del abogado del diablo; se queda la selección")
        return 0
    seen: set[int] = set()
    for raw in data.get("review", []):
        try:
            i = int(raw["index"]) - 1
            score = max(0, min(100, int(raw.get("score", 0) or 0)))
        except (KeyError, TypeError, ValueError):
            continue
        if not 0 <= i < len(left) or i in seen:
            continue
        seen.add(i)
        m = left[i]
        m.ai_score = score
        if punch := parse_punch(raw.get("punch")):
            m.punch = punch
        if reason := str(raw.get("reason", "")).strip():
            m.reason = reason
        if not m.title and (title := str(raw.get("title", "")).strip()):
            m.title = title[:100]
        if not m.hook and (hook := str(raw.get("hook", "")).strip()):
            m.hook = hook
    return len(seen)


def _final(m: Moment) -> int:
    from .punch import bonus
    return min(100, m.ai_score + bonus((m.signals or {}).get("score", 0)))


def signal_candidates(transcript: dict, sig: dict | None, taken: list[Moment], *, min_d: float, max_d: float,
                      limit: int = 6) -> list[Moment]:
    """clips alrededor de lo que las señales marcan como fuerte (puntos calientes de YouTube, picos de +12 dB)
    que ningún bloque propuso. El momento fuerte queda hacia el 60 % del clip: antes, lo que lo prepara."""
    from .punch import spots

    words = transcript["words"]
    duration = transcript.get("duration") or (words[-1]["e"] if words else 0)
    length = (min_d + max_d) / 2
    out: list[Moment] = []
    for t in spots(sig, limit=limit * 2):
        start = max(0.0, t - 0.6 * length)
        cut = snap(start, start + length, words, min_d, max_d, duration)
        if not cut:
            continue
        m = Moment(start=cut[0], end=cut[1], title="", hook="", reason="", score=0, via="signals")
        if all(_overlap_ratio(m, k) < 0.5 for k in taken + out):
            out.append(m)
        if len(out) >= limit:
            break
    return out


def find_moments(transcript: dict, provider: LLMProvider, *, count: int, min_d: float, max_d: float,
                 niche: str = "", guidance: str = "", signals: dict | None = None, brief: dict | None = None,
                 visual: dict | None = None, rank: bool = True, examples: str = "", viral: str = "",
                 second_look: bool = True, discarded: list[Moment] | None = None, refs: str = "",
                 on_progress: Callable[[float], None] | None = None) -> list[Moment]:
    """`signals`: picos de volumen y cambios de plano (pipeline/signals.py), como pistas para el LLM.
    `brief`: la idea general del vídeo.
    `rank`: segunda pasada que puntúa juntos los candidatos de todos los bloques.
    `viral` = ejemplos de clips virales (opcional); `second_look` = pasada del abogado del diablo sobre los descartados;
    `discarded` = lista que se rellena con todo lo que se quedó fuera, con el motivo (la bolsa de descartados).
    `refs` = ganchos y picos de vídeos de referencia (opcional), en las tres pasadas.
    A la nota de la IA se suman las señales sin IA (pipeline/punch.py) y un momento con señales muy fuertes entra
    aunque la IA lo puntúe bajo."""
    from .punch import STRONG, signal_score, speech_rate
    from .signals import prompt_block

    segments, words = transcript["segments"], transcript["words"]
    duration = transcript.get("duration") or (segments[-1]["e"] if segments else 0)
    lang = (transcript.get("language") or "")[:2]
    chunks = build_chunks(segments, provider.chunk_seconds, overlap=max_d)
    if not chunks:
        return []
    brief_block = brief_text(brief)
    steps = len(chunks) + (1 if rank and len(chunks) > 1 else 0) + (1 if second_look else 0)

    candidates: list[Moment] = []
    for n, (c_start, c_end, segs) in enumerate(chunks):
        share = (c_end - c_start) / max(duration, 1)
        k = max(2, min(8, math.ceil(count * share * 2)))
        prompt = PROMPT.format(
            niche=niche or "general", guidance=guidance or "none", k=k, min_d=min_d, max_d=max_d,
            language=language_name(transcript), brief=brief_block, refs=refs, rubric=RUBRIC,
            chunk_start=c_start, chunk_end=c_end,
            transcript="\n".join(f"[{s['s']:.1f}] {s['text']}" for s in segs),
            signals=prompt_block(signals, c_start, c_end),
            visual=visual_block(visual, c_start, c_end),
        )
        try:
            data = provider.complete_json(prompt, SCHEMA, task="moments")
        except Exception:
            if len(chunks) == 1:
                raise
            log.exception("Fallo del LLM en el bloque %d/%d; se omite", n + 1, len(chunks))
            continue
        for raw in data.get("moments", []):
            try:
                cut = snap(float(raw["start"]), float(raw["end"]), words, min_d, max_d, duration)
            except (KeyError, TypeError, ValueError):
                continue
            if not cut:
                continue
            candidates.append(Moment(
                start=cut[0], end=cut[1],
                title=str(raw.get("title", ""))[:100].strip(),
                hook=str(raw.get("hook", "")).strip(),
                reason=str(raw.get("reason", "")).strip(),
                score=max(0, min(100, int(raw.get("score", 0)))),
                tags=[str(t) for t in raw.get("tags", [])][:4],
                punch=parse_punch(raw.get("punch")),
                **dict(zip(("hook_start", "hook_end"), cold_open(raw, cut[0], cut[1], words))),
            ))
        if on_progress:
            on_progress((n + 1) / steps)
    found = dedupe(candidates)
    lost: list[Moment] = []  # la bolsa de descartados
    for m in candidates:
        if all(m is not f for f in found):
            m.discard = "Se solapa con otro momento mejor puntuado"
            lost.append(m)
    if rank and len(chunks) > 1:  # con un solo bloque la IA ya los comparó todos a la vez
        found = rank_moments(found, transcript, provider, count=count, brief=brief, niche=niche, guidance=guidance,
                             examples=examples, viral=viral, refs=refs)
        if on_progress:
            on_progress((len(chunks) + 1) / steps)

    # Señales sin IA: se suman a la nota
    base = speech_rate(words)
    extra = signal_candidates(transcript, signals, found, min_d=min_d, max_d=max_d)
    for m in found + extra:
        m.ai_score = m.score
        m.signals = {k: v for k, v in signal_score(m.start, m.end, words, signals, lang, base).items() if k != "turns"}
        m.score = _final(m) if m.via != "signals" else 0
    found.sort(key=lambda m: m.score, reverse=True)
    chosen, left = found[:count], found[count:]
    for m in left:
        m.discard = f"Fuera de los {count} mejores"

    # Abogado del diablo: revisa lo que se quedó fuera y lo que solo vieron las señales
    review = sorted(left, key=lambda m: ((m.signals or {}).get("score", 0), m.score), reverse=True)[:10] + extra[:6]
    if second_look and review and provider is not None:
        advocate(chosen, review, transcript, provider, brief=brief, niche=niche, guidance=guidance, viral=viral,
                 refs=refs)
        for m in review:
            if m.title:  # los de solo señales sin título no se pueden publicar tal cual
                m.score = _final(m)
        if on_progress:
            on_progress(1.0)
        floor = min((m.score for m in chosen), default=0) if len(chosen) >= count else 49
        for m in sorted(review, key=lambda m: m.score, reverse=True):
            if not m.title or m.score <= floor or any(_overlap_ratio(m, k) >= 0.4 for k in chosen):
                continue
            m.via = "advocate"
            m.discard = ""
            if len(chosen) >= count:
                out = min(chosen, key=lambda x: x.score)
                chosen.remove(out)
                out.discard = "Lo desplazó un momento rescatado en la segunda pasada"
                left.append(out)
            chosen.append(m)
            floor = min(x.score for x in chosen) if len(chosen) >= count else 49

    # Un momento con señales muy fuertes no puede quedar fuera
    for m in sorted(left + extra, key=lambda m: -(m.signals or {}).get("score", 0)):
        if m in chosen or (m.signals or {}).get("score", 0) < STRONG or any(_overlap_ratio(m, k) >= 0.4 for k in chosen):
            continue
        weak = [x for x in chosen if (x.signals or {}).get("score", 0) < STRONG]
        if len(chosen) >= count and not weak:
            break
        if not m.title:
            text = [w["w"] for w in words if w["s"] >= m.start - 0.05 and w["e"] <= m.end + 0.05]
            m.title = " ".join(text[:9]).strip(" ,.") + "…"
            m.reason = m.reason or "Entra por sus señales: la IA no lo propuso."
        m.via = "signals"
        m.discard = ""
        m.score = max(m.score, _final(m))
        if len(chosen) >= count:
            out = min(weak, key=lambda x: x.score)
            chosen.remove(out)
            out.discard = "Lo desplazó un momento con señales muy fuertes"
            left.append(out)
        chosen.append(m)
    chosen.sort(key=lambda m: m.score, reverse=True)

    if signals and signals.get("heatmap"):  # se ve en el motivo del clip si coincide con lo más repetido en YouTube
        from .heatmap import note
        for m in chosen:
            if extra_note := note(signals["heatmap"], m.start, m.end):
                m.reason = f"{m.reason} {extra_note}".strip()
    if discarded is not None:
        for m in left + extra + lost:
            if m in chosen or m in discarded:
                continue
            if not m.discard:
                m.discard = ("Solo lo vieron las señales; la IA no lo revisó" if not m.title
                             else "Lo vieron las señales y la IA lo dejó fuera" if m.via == "signals"
                             else "Fuera de los mejores")
            discarded.append(m)
        discarded.sort(key=lambda m: m.score, reverse=True)
    return chosen
