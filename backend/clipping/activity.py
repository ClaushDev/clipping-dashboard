"""Actividad en vivo: qué proceso y qué modelo está trabajando en cada momento.

Cada llamada a la IA (router LLM, agentes con herramientas) y cada proceso local largo (modelos de ml/, Whisper,
render de Remotion, FFmpeg) se abre con `step(...)`.
- **Mientras corre:** el paso está en memoria (`open_steps`). El panel «Actividad» del dashboard lo enseña con su
  modelo, el tiempo que lleva, lo que suele tardar y su límite.
- **Al cerrarse:** queda en la tabla `JobEvent`, ligado al trabajo de la cola que lo lanzó (0 = petición directa del
  dashboard). Así cada trabajo tiene su historial de pasos.

Los FFmpeg de menos de 2 s no se guardan: son cientos y no dicen nada.
"""
from __future__ import annotations

import itertools
import logging
import statistics
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlmodel import Session, select

from . import jobctl
from .db import JobEvent, engine

log = logging.getLogger("clipping.activity")

KINDS = {"llm": "IA", "agent": "Agente IA", "ml": "Modelo local", "whisper": "Transcripción", "render": "Render",
         "ffmpeg": "FFmpeg", "api": "Servicio externo"}
SHORT_FFMPEG = 2.0
_lock = threading.Lock()
_ids = itertools.count(1)
_open: dict[int, "Step"] = {}
_typical_cache: dict[tuple, tuple[float, float | None]] = {}


@dataclass
class Step:
    id: int
    job_id: int
    kind: str
    label: str
    model: str = ""
    detail: str = ""
    task: str = ""
    typical: float | None = None  # segundos que suele tardar (mediana de los anteriores)
    limit: float | None = None  # segundos a partir de los que se corta
    started: float = field(default_factory=time.time)
    tokens_in: int = 0
    tokens_out: int = 0
    progress: float | None = None

    def public(self) -> dict:
        return {"id": self.id, "job_id": self.job_id, "kind": self.kind, "kind_label": KINDS.get(self.kind, self.kind),
                "label": self.label, "model": self.model, "detail": self.detail, "task": self.task,
                "typical": self.typical, "limit": self.limit, "progress": self.progress,
                "started_at": datetime.fromtimestamp(self.started, timezone.utc).isoformat(timespec="seconds"),
                "elapsed": round(time.time() - self.started, 1)}


def typical(kind: str, label: str, model: str = "", task: str = "") -> float | None:
    """Lo que suele tardar un paso así: mediana de los últimos guardados (o del contador del LLM si es una tarea)."""
    key = (kind, label, model, task)
    now = time.time()
    hit = _typical_cache.get(key)
    if hit and now - hit[0] < 120:
        return hit[1]
    secs: list[float] = []
    try:
        with Session(engine) as s:
            q = select(JobEvent.secs).where(JobEvent.kind == kind, JobEvent.ok == True)  # noqa: E712
            q = q.where(JobEvent.task == task) if task else q.where(JobEvent.label == label)
            if model:
                q = q.where(JobEvent.model == model)
            secs = [float(x) for x in s.exec(q.order_by(JobEvent.id.desc()).limit(15)).all()]
    except Exception:  # noqa: BLE001 — sin base de datos (tests sin init) no hay histórico
        secs = []
    if len(secs) < 3 and task:
        from .llm import router

        secs = [float(r.get("secs") or 0) for r in router.usage_rows(task)[-15:] if r.get("ok", True)] or secs
    value = round(statistics.median(secs), 1) if len(secs) >= 2 else None
    value = value if value and value >= 1 else None
    _typical_cache[key] = (now, value)
    return value


def open_step(kind: str, label: str, model: str = "", detail: str = "", task: str = "",
              limit: float | None = None) -> Step:
    st = Step(id=next(_ids), job_id=jobctl.mine(), kind=kind, label=label, model=model, detail=detail[:200], task=task,
              limit=limit)
    try:
        st.typical = typical(kind, label, model, task)
    except Exception:  # noqa: BLE001
        log.debug("Sin duración típica para %s", label, exc_info=True)
    with _lock:
        _open[st.id] = st
    return st


def close_step(st: Step, ok: bool = True, error: str = "") -> None:
    with _lock:
        _open.pop(st.id, None)
    secs = round(time.time() - st.started, 1)
    if st.kind == "ffmpeg" and ok and secs < SHORT_FFMPEG:
        return
    try:
        with Session(engine) as s:
            s.add(JobEvent(job_id=st.job_id, kind=st.kind, label=st.label, model=st.model, detail=st.detail,
                           task=st.task, ok=ok, error=error[-500:], secs=secs, tokens_in=st.tokens_in,
                           tokens_out=st.tokens_out,
                           started_at=datetime.fromtimestamp(st.started, timezone.utc)))
            s.commit()
    except Exception:  # noqa: BLE001 — la actividad nunca debe romper el trabajo
        log.debug("No se pudo guardar el paso %s", st.label, exc_info=True)


@contextmanager
def step(kind: str, label: str, model: str = "", detail: str = "", task: str = "", limit: float | None = None):
    st = open_step(kind, label, model, detail, task, limit)
    try:
        yield st
    except BaseException as exc:
        close_step(st, ok=False, error=str(exc) or exc.__class__.__name__)
        raise
    close_step(st)


def instant(kind: str, label: str, model: str = "", detail: str = "", task: str = "") -> None:
    """Un paso sin duración (p. ej. una respuesta que salió de la caché)."""
    close_step(open_step(kind, label, model, detail, task))


def open_steps() -> list[dict]:
    with _lock:
        steps = list(_open.values())
    return [s.public() for s in sorted(steps, key=lambda x: x.started)]


def events(job_id: int, limit: int = 60) -> list[dict]:
    with Session(engine) as s:
        rows = s.exec(select(JobEvent).where(JobEvent.job_id == job_id).order_by(JobEvent.id.desc()).limit(limit)).all()
    return [event_out(e) for e in reversed(rows)]


def recent_direct(minutes: int = 10, limit: int = 6) -> list[dict]:
    """Pasos de peticiones directas (fuera de la cola) de los últimos minutos."""
    since = datetime.now(timezone.utc).timestamp() - minutes * 60
    with Session(engine) as s:
        rows = s.exec(select(JobEvent).where(JobEvent.job_id == 0).order_by(JobEvent.id.desc()).limit(limit)).all()
    out = []
    for e in rows:
        ts = e.started_at if e.started_at.tzinfo else e.started_at.replace(tzinfo=timezone.utc)
        if ts.timestamp() + e.secs >= since:
            out.append(event_out(e))
    return out


def event_out(e: JobEvent) -> dict:
    return {"id": e.id, "job_id": e.job_id, "kind": e.kind, "kind_label": KINDS.get(e.kind, e.kind), "label": e.label,
            "model": e.model, "detail": e.detail, "task": e.task, "ok": e.ok, "error": e.error, "secs": e.secs,
            "tokens_in": e.tokens_in, "tokens_out": e.tokens_out, "started_at": e.started_at}


def totals(job_id: int) -> dict:
    with Session(engine) as s:
        rows = s.exec(select(JobEvent).where(JobEvent.job_id == job_id)).all()
    return {"steps": len(rows), "tokens": sum(e.tokens_in + e.tokens_out for e in rows)}


# ---------- Nombres de los procesos locales ----------

ML_SCRIPTS = {
    "segment.py": ("Recortar el sujeto", "SAM 2.1 · GPU"),
    "track.py": ("Seguir un punto", "SAM 2.1 · GPU"),
    "detect.py": ("Buscar objetos en fotogramas", "Grounding DINO · GPU"),
}


def ml_names(script: str) -> tuple[str, str]:
    return ML_SCRIPTS.get(script, (f"Proceso local {script}", script.removesuffix(".py")))
