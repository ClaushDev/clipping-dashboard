"""la idea general de cada vídeo y cuánto acierta la IA eligiendo momentos.

- Idea general (`data/sources/<id>/brief.json`): tema, tono, público, qué es un buen momento en ESE vídeo y qué evitar.
  La escribe la IA antes de buscar momentos (pipeline/process.py); se puede corregir aquí y volver a buscar.
- Acierto, sin gastar IA: de los clips que propuso la IA, cuántos aprobaste y cuántos descartaste, si su
  nota los ordena bien y qué clips marcaste tú a mano que la IA no vio.
- Prueba contra tus clips a mano (gasta IA): en un vídeo donde marcaste clips a mano, la IA busca momentos como si
  fuera la primera vez (sin crear clips) y se cuenta cuántos de los tuyos encuentra.
- bolsa de descartados. Todo lo que la IA o las señales vieron y se quedó fuera se guarda con su motivo
  (`candidates.json`) y se puede rescatar con un clic (clip con origin «rescued»).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from . import worker
from .config import SOURCES_DIR, load_settings
from .db import Clip, Job, Source, engine
from .llm import get_provider
from .pipeline import moments, process

log = logging.getLogger("clipping.moment_eval")
router = APIRouter(prefix="/api/moments", tags=["moments"])
BENCH_FILE = "benchmark.json"
MATCH = 0.5  # un clip tuyo cuenta como encontrado si una propuesta cubre la mitad o más de él (o él de ella)


def overlap(a: tuple[float, float], b: tuple[float, float]) -> float:
    inter = min(a[1], b[1]) - max(a[0], b[0])
    if inter <= 0:
        return 0.0
    return inter / max(0.01, min(a[1] - a[0], b[1] - b[0]))


def _kept(c: Clip) -> bool:
    return c.status == "approved"


def _discarded(c: Clip) -> bool:
    return c.status == "rejected"


def spearman(xs: list[float], ys: list[float]) -> float | None:
    """Correlación de Spearman (rangos con empates promediados). None si alguna serie es constante."""
    def ranks(v: list[float]) -> list[float]:
        order = sorted(range(len(v)), key=lambda i: v[i])
        out = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                out[order[k]] = (i + j) / 2 + 1
            i = j + 1
        return out

    if len(xs) < 2 or len(set(xs)) < 2 or len(set(ys)) < 2:
        return None
    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return round(num / den, 3) if den else None


def accuracy() -> dict:
    """Acierto de las propuestas de la IA según lo que hiciste con ellas (sin IA)."""
    with Session(engine) as s:
        clips = s.exec(select(Clip).where(Clip.source_id > 0)).all()
        sources = {src.id: src for src in s.exec(select(Source)).all()}
    by_src: dict[int, list[Clip]] = {}
    for c in clips:
        by_src.setdefault(c.source_id, []).append(c)

    rows, scores, outcome = [], [], []
    totals = {"proposed": 0, "kept": 0, "discarded": 0, "pending": 0, "manual": 0, "missed": 0, "rescued": 0}
    for sid, group in sorted(by_src.items(), reverse=True):
        ai = [c for c in group if c.origin == "ai"]
        manual = [c for c in group if c.origin == "manual"]
        src = sources.get(sid)
        bench = load_benchmark(sid)
        if not ai and not bench:
            continue
        kept = [c for c in ai if _kept(c)]
        discarded = [c for c in ai if _discarded(c)]
        # Los que marcaste tú en un vídeo donde la IA ya había propuesto: momentos que no vio
        missed = [m for m in manual if ai and all(overlap((m.start, m.end), (c.start, c.end)) < MATCH for c in ai)]
        for c in kept + discarded:
            scores.append(c.score)
            outcome.append(1.0 if _kept(c) else 0.0)
        row = {"source_id": sid, "title": (src.title or src.url)[:120] if src else f"Vídeo {sid}",
               "proposed": len(ai), "kept": len(kept), "discarded": len(discarded),
               "pending": len(ai) - len(kept) - len(discarded), "manual": len(manual), "missed": len(missed),
               "rescued": sum(1 for c in group if c.origin == "rescued"),
               "score_kept": _avg([c.score for c in kept]), "score_discarded": _avg([c.score for c in discarded]),
               "has_brief": process.load_brief(sid) is not None, "benchmark": _bench_summary(bench)}
        rows.append(row)
        for k in totals:
            totals[k] += row[k]
    decided = totals["kept"] + totals["discarded"]
    benches = [r["benchmark"] for r in rows if r["benchmark"]]
    found = sum(b["found"] for b in benches)
    wanted = sum(b["manual"] for b in benches)
    return {
        **totals,
        "hit_rate": round(totals["kept"] / decided, 3) if decided else None,
        "score_kept": _avg([sc for sc, o in zip(scores, outcome) if o]),
        "score_discarded": _avg([sc for sc, o in zip(scores, outcome) if not o]),
        # ¿La nota de la IA ordena bien? (Spearman entre nota y aprobado: 1 = perfecto, 0 = al azar)
        "score_corr": spearman(scores, outcome) if len(set(outcome)) > 1 and len(scores) >= 4 else None,
        "bench_recall": round(found / wanted, 3) if wanted else None,
        "bench_found": found, "bench_manual": wanted,
        "sources": rows,
        "candidates": manual_sources(),
    }


def _clip_excerpt(c: Clip, cache: dict[int, list[dict]], words: int = 30) -> str:
    if c.source_id not in cache:
        with Session(engine) as s:
            src = s.get(Source, c.source_id)
        try:
            cache[c.source_id] = json.loads(Path(src.transcript_path).read_text(encoding="utf-8"))["words"]
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            cache[c.source_id] = []
    inside = [w["w"] for w in cache[c.source_id] if w["s"] >= c.start - 0.05 and w["e"] <= c.end + 0.05]
    return " ".join(inside[:words]) + (" …" if len(inside) > words else "")


def examples_text(exclude_source: int = 0, limit: int = 6) -> str:
    """Para el prompt: clips que el editor se quedó (aprobados o marcados a mano) y que descartó, los más recientes.
    `exclude_source`: no mirar los de ese vídeo (la prueba de acierto no puede ver la respuesta)."""
    with Session(engine) as s:
        q = select(Clip).where(Clip.source_id > 0, Clip.source_id != exclude_source).order_by(Clip.updated_at.desc())
        clips = s.exec(q).all()
    kept = [c for c in clips if c.origin in ("manual", "rescued") or _kept(c)][:limit]
    gone = [c for c in clips if c.origin == "ai" and _discarded(c)][:limit]
    if not kept and not gone:
        return ""
    cache: dict[int, list[dict]] = {}

    def line(c: Clip) -> str:
        how = ("picked by hand" if c.origin == "manual" else "rescued from the AI's rejects" if c.origin == "rescued"
               else "approved")
        tag = how if c in kept else "rejected"
        return f"- [{tag}] \"{c.title or '(sin título)'}\" ({c.end - c.start:.0f} s): {_clip_excerpt(c, cache)}"

    parts = ["\nTHE EDITOR'S PAST CHOICES (learn their taste; a rejection may also be about length or"
             " a bad cut, so weigh the pattern, not single cases):"]
    if kept:
        parts += ["Kept:"] + [line(c) for c in kept]
    if gone:
        parts += ["Rejected:"] + [line(c) for c in gone]
    return "\n".join(parts) + "\n"


def _avg(xs: list[float]) -> float | None:
    return round(sum(xs) / len(xs), 1) if xs else None


def manual_sources() -> list[dict]:
    """Vídeos con clips marcados a mano en los que se puede probar a la IA."""
    with Session(engine) as s:
        q = select(Clip).where(Clip.source_id > 0, Clip.origin == "manual")
        counts: dict[int, int] = {}
        for c in s.exec(q).all():
            counts[c.source_id] = counts.get(c.source_id, 0) + 1
        out = []
        for sid, n in sorted(counts.items(), reverse=True):
            src = s.get(Source, sid)
            if src and src.transcript_path and Path(src.transcript_path).exists():
                out.append({"source_id": sid, "title": (src.title or src.url)[:120], "manual": n,
                            "duration": src.duration, "benchmark": _bench_summary(load_benchmark(sid))})
    return out


# ---------- Prueba contra tus clips marcados a mano ----------

def load_benchmark(source_id: int) -> dict | None:
    try:
        return json.loads((SOURCES_DIR / str(source_id) / BENCH_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _bench_summary(b: dict | None) -> dict | None:
    if not b:
        return None
    return {**{k: b.get(k) for k in ("at", "manual", "found", "proposed", "recall", "in_pool", "reach", "status", "error")},
            "prev": (b.get("history") or [None])[-1]}


def compare(manual: list[tuple[float, float]], proposals: list[dict], pool: list[dict] | None = None) -> dict:
    """Cuántos de tus clips encontró la IA y en qué puesto de su lista. `pool`: la bolsa de descartados; un clip
    tuyo que no está arriba pero sí ahí se puede rescatar con un clic (cuenta en `reach`, no en `recall`)."""
    matches = []
    for i, (a, b) in enumerate(manual):
        best = max(((overlap((a, b), (p["start"], p["end"])), rank) for rank, p in enumerate(proposals, 1)),
                   default=(0.0, 0))
        in_pool = best[0] < MATCH and any(overlap((a, b), (p["start"], p["end"])) >= MATCH for p in pool or [])
        matches.append({"manual": i + 1, "start": a, "end": b, "rank": best[1] if best[0] >= MATCH else 0,
                        "overlap": round(best[0], 2), "in_pool": in_pool})
    found = sum(1 for m in matches if m["rank"])
    pooled = sum(1 for m in matches if m["in_pool"])
    return {"manual": len(manual), "found": found, "proposed": len(proposals),
            "recall": round(found / len(manual), 3) if manual else None, "in_pool": pooled,
            "reach": round((found + pooled) / len(manual), 3) if manual else None, "matches": matches}


def run_benchmark(source_id: int) -> None:
    path = SOURCES_DIR / str(source_id) / BENCH_FILE
    stamp = datetime.now().isoformat(timespec="seconds")

    old = load_benchmark(source_id) or {}
    history = list(old.get("history") or [])
    if old.get("status") == "done":  # las pruebas anteriores se guardan para ver si la nota sube
        history = (history + [{k: old.get(k) for k in ("at", "manual", "found", "recall", "in_pool", "reach")}])[-10:]

    def save(data: dict) -> None:  # con el historial
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"at": stamp, **data, "history": history}, ensure_ascii=False, indent=1),
                        encoding="utf-8")

    save({"status": "running"})
    try:
        settings = load_settings()
        with Session(engine) as s:
            src = s.get(Source, source_id)
            manual = [(c.start, c.end) for c in s.exec(select(Clip).where(
                Clip.source_id == source_id, Clip.origin == "manual")).all()]
            guidance = process.selection_guidance(src)
            provider_name = src.llm_provider or settings.llm_provider
            min_d = src.min_duration or settings.min_duration
            max_d = src.max_duration or settings.max_duration
            transcript_path, url = src.transcript_path, src.url
        if not manual:
            raise RuntimeError("Este vídeo no tiene clips marcados a mano con los que comparar.")
        manual.sort()
        transcript = json.loads(Path(transcript_path).read_text(encoding="utf-8"))
        provider = get_provider(provider_name, settings, task="moments")
        brief = process.load_brief(source_id)
        if not brief:
            brief = moments.video_brief(transcript, provider, guidance=guidance)
            process.save_brief(source_id, brief, edited=False)
        sig = None
        sig_path = SOURCES_DIR / str(source_id) / "signals.json"
        if sig_path.exists():
            from .pipeline import heatmap
            sig = json.loads(sig_path.read_text(encoding="utf-8"))
            sig["heatmap"] = heatmap.ensure(SOURCES_DIR / str(source_id) / heatmap.FILE, url)
        # Se piden el doble de propuestas que clips tuyos (como mínimo 5): mide si tus clips están entre las primeras
        count = max(5, 2 * len(manual))
        pool: list[moments.Moment] = []
        found = moments.find_moments(transcript, provider, count=count, min_d=min_d, max_d=max_d,
                                     guidance=guidance, signals=sig, brief=brief,
                                     examples=examples_text(exclude_source=source_id), discarded=pool)
        proposals = [{"start": m.start, "end": m.end, "title": m.title, "score": m.score, "reason": m.reason,
                      "breakdown": m.breakdown()} for m in found]
        rejects = [{"start": m.start, "end": m.end, "title": m.title, "score": m.score, "discard": m.discard}
                   for m in pool]
        save({"status": "done", **compare(manual, proposals, rejects), "proposals": proposals, "pool": rejects})
    except Exception as exc:
        save({"status": "error", "error": str(exc)[:300]})
        raise


worker.register("moments_benchmark", run_benchmark, Source)


# ---------- API ----------

class BriefIn(BaseModel):
    topic: str = ""
    tone: str = ""
    audience: str = ""
    good_moment: str = ""
    avoid: str = ""


def _source(source_id: int) -> Source:
    with Session(engine) as s:
        src = s.get(Source, source_id)
    if not src:
        raise HTTPException(404, "Fuente no encontrada")
    return src


@router.get("/sources/{source_id}")
def get_source_idea(source_id: int) -> dict:
    """Idea general y última prueba de acierto de una fuente."""
    src = _source(source_id)
    return {**process.brief_info(source_id), "benchmark": load_benchmark(source_id), "duration": src.duration}


@router.put("/sources/{source_id}/brief")
def put_brief(source_id: int, data: BriefIn) -> dict:
    _source(source_id)
    process.save_brief(source_id, data.model_dump(), edited=True)
    return process.brief_info(source_id)


@router.delete("/sources/{source_id}/brief")
def delete_brief(source_id: int) -> dict:
    """Borra la idea general: la próxima búsqueda de momentos la vuelve a escribir."""
    _source(source_id)
    (SOURCES_DIR / str(source_id) / process.BRIEF_FILE).unlink(missing_ok=True)
    return process.brief_info(source_id)


@router.get("/sources/{source_id}/candidates")
def get_candidates(source_id: int) -> dict:
    """la bolsa de descartados de la última búsqueda, con los que ya tienen clip marcados."""
    _source(source_id)
    data = process.load_candidates(source_id)
    with Session(engine) as s:
        clips = s.exec(select(Clip).where(Clip.source_id == source_id)).all()
    for it in data.get("items", []):
        hit = next((c for c in clips if overlap((it["start"], it["end"]), (c.start, c.end)) >= MATCH), None)
        it["clip_id"] = hit.id if hit else 0
    return data


@router.post("/sources/{source_id}/candidates/{cand_id}/rescue")
def rescue_candidate(source_id: int, cand_id: int) -> dict:
    """convierte un descartado en clip (va a la cola de render como los demás)."""
    data = process.load_candidates(source_id)
    it = next((x for x in data.get("items", []) if x.get("id") == cand_id), None)
    if not it:
        raise HTTPException(404, "Ese momento ya no está en la bolsa de descartados (¿has vuelto a buscar momentos?).")
    with Session(engine) as s:
        src = s.get(Source, source_id)
        if not src:
            raise HTTPException(404, "Fuente no encontrada")
        for c in s.exec(select(Clip).where(Clip.source_id == source_id)).all():
            if overlap((it["start"], it["end"]), (c.start, c.end)) >= MATCH:
                return {"clip_id": c.id, "already": True}
        clip = Clip(source_id=source_id, start=it["start"], end=it["end"],
                    hook_start=it.get("hook_start") or 0, hook_end=it.get("hook_end") or 0,
                    title=it.get("title") or "", hook=it.get("hook") or "",
                    reason=f"Rescatado de los descartados. {it.get('reason') or ''}".strip(), score=it.get("score") or 0,
                    breakdown=json.dumps({**(it.get("breakdown") or {}), "via": "rescued"}, ensure_ascii=False),
                    tags=json.dumps(it.get("tags") or []), origin="rescued", status="queued",
                    template_id=process.template_for(src))
        s.add(clip)
        s.commit()
        s.refresh(clip)
        clip_id = clip.id
    worker.enqueue("render_clip", clip_id)
    return {"clip_id": clip_id, "already": False}


@router.get("/accuracy")
def get_accuracy() -> dict:
    return accuracy()


@router.post("/sources/{source_id}/benchmark")
def start_benchmark(source_id: int) -> dict:
    _source(source_id)
    with Session(engine) as s:
        n = len(s.exec(select(Clip).where(Clip.source_id == source_id, Clip.origin == "manual")).all())
        busy = s.exec(select(Job).where(Job.kind == "moments_benchmark", Job.ref_id == source_id,
                                        Job.status.in_(["queued", "running"]))).first()
    if not n:
        raise HTTPException(400, "Este vídeo no tiene clips marcados a mano con los que comparar.")
    if busy:
        raise HTTPException(400, "La prueba ya está en marcha.")
    worker.enqueue("moments_benchmark", source_id)
    return {"ok": True}
