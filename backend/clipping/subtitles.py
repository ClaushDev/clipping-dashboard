"""subtítulos de un clip como archivo SRT o VTT (paso 6), para subirlos aparte a YouTube o TikTok.

Salen de las palabras de la composición en tiempo de timeline (las mismas que se queman en el vídeo), agrupadas en
líneas cortas: corte en pausas, en signos de final de frase y al llegar al máximo de palabras o de segundos."""
from __future__ import annotations

import json
import re
import unicodedata

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from sqlmodel import Session

from .db import Clip, engine
from .quality import timeline_words

router = APIRouter(prefix="/api/clips", tags=["subtitles"])

MAX_WORDS = 7
MAX_SECS = 3.5
GAP = 0.6  # una pausa más larga abre línea nueva
END = re.compile(r"[.!?…]$")


def cues(words: list[dict], *, max_words: int = MAX_WORDS, max_secs: float = MAX_SECS, gap: float = GAP) -> list[dict]:
    """Palabras ({w, s, e}) → líneas {s, e, text}, sin solaparse."""
    out: list[dict] = []
    cur: list[dict] = []

    def flush():
        if cur:
            out.append({"s": cur[0]["s"], "e": max(cur[-1]["e"], cur[0]["s"] + 0.3),
                        "text": " ".join(w["w"].strip() for w in cur if w["w"].strip())})
            cur.clear()

    for w in sorted((w for w in words if str(w.get("w", "")).strip()), key=lambda w: w["s"]):
        if cur and (w["s"] - cur[-1]["e"] > gap or len(cur) >= max_words or w["e"] - cur[0]["s"] > max_secs):
            flush()
        cur.append(w)
        if END.search(w["w"].strip()):
            flush()
    flush()
    for a, b in zip(out, out[1:]):  # sin solapes: cada línea acaba como tarde donde empieza la siguiente
        a["e"] = min(a["e"], b["s"])
    return [c for c in out if c["text"] and c["e"] > c["s"]]


def _stamp(t: float, sep: str) -> str:
    ms = max(0, round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_srt(lines: list[dict]) -> str:
    return "\n".join(f"{i}\n{_stamp(c['s'], ',')} --> {_stamp(c['e'], ',')}\n{c['text']}\n"
                     for i, c in enumerate(lines, 1))


def to_vtt(lines: list[dict]) -> str:
    return "WEBVTT\n\n" + "\n".join(f"{_stamp(c['s'], '.')} --> {_stamp(c['e'], '.')}\n{c['text']}\n" for c in lines)


def _filename(title: str, clip_id: int) -> str:
    ascii_ = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode()  # la cabecera va en latin-1
    base = re.sub(r"[^A-Za-z0-9\- ]+", "", ascii_).strip().replace(" ", "_")[:60]
    return base or f"clip_{clip_id}"


@router.get("/{clip_id}/subtitles.{fmt}")
def clip_subtitles(clip_id: int, fmt: str) -> Response:
    if fmt not in ("srt", "vtt"):
        raise HTTPException(404, "Formato no válido: srt o vtt")
    with Session(engine) as s:
        clip = s.get(Clip, clip_id)
        if not clip:
            raise HTTPException(404, "Clip no encontrado")
        comp = json.loads(clip.composition) if clip.composition else None
        title = clip.title
    lines = cues(timeline_words(comp)) if comp else []
    if not lines:
        raise HTTPException(404, "Este vídeo no tiene subtítulos")
    body = to_srt(lines) if fmt == "srt" else to_vtt(lines)
    name = f"{_filename(title, clip_id)}.{fmt}"
    return Response(body.encode("utf-8"), media_type="application/x-subrip" if fmt == "srt" else "text/vtt",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
