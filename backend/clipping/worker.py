"""Cola de trabajos en SQLite procesada por un único hilo (la GPU se usa de uno en uno).

Se puede parar el trabajo en marcha o uno en cola, cambiar el orden (rank) y pausar la cola (jobctl.py y la página
«Cola de trabajos» del dashboard)."""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable

from sqlmodel import Session, select

from . import jobctl
from .llm import router as llm_router
from .db import Clip, Export, Job, Source, engine, utcnow
from .pipeline import process

log = logging.getLogger("clipping.worker")

# tipo de trabajo -> (función que lo ejecuta, modelo cuyo status/error se marca si falla)
HANDLERS: dict[str, tuple[Callable[[int], None], type]] = {
    "process_source": (process.process_source, Source),
    "render_clip": (process.render_clip, Clip),
    "export": (process.run_export, Export),
    "manual_clips": (process.score_manual_clips, Source),
}


# tipo de trabajo -> función que se llama después de marcar el error (avisar a quien esperaba el resultado)
FAIL_HOOKS: dict[str, Callable[[int], None]] = {}


def register(kind: str, func: Callable[[int], None], model: type, on_fail: Callable[[int], None] | None = None) -> None:
    HANDLERS[kind] = (func, model)
    if on_fail:
        FAIL_HOOKS[kind] = on_fail


def enqueue(kind: str, ref_id: int) -> Job:
    req = llm_router.REQUEST.get()
    with Session(engine) as s:
        job = Job(kind=kind, ref_id=ref_id, llm=0 if req is None else 2 if req.get("fresh") else 1)
        s.add(job)
        s.flush()
        job.rank = float(job.id)  # al final de la cola
        s.add(job)
        s.commit()
        s.refresh(job)
        return job


# Cola en pausa: el trabajo en marcha acaba y no empieza otro hasta reanudar (no sobrevive a un reinicio)
_paused = threading.Event()


def set_paused(value: bool) -> None:
    (_paused.set if value else _paused.clear)()


def is_paused() -> bool:
    return _paused.is_set()


def queued_ids() -> list[int]:
    with Session(engine) as s:
        return [j.id for j in s.exec(select(Job).where(Job.status == "queued").order_by(Job.rank, Job.id)).all()]


def move(job_id: int, where: str) -> list[int]:
    """Cambia el orden de un trabajo en cola: "top", "up", "down" o "bottom". Devuelve el nuevo orden."""
    order = queued_ids()
    if job_id not in order:
        raise ValueError("Ese trabajo ya no está en la cola")
    i = order.index(job_id)
    order.pop(i)
    j = {"top": 0, "up": max(0, i - 1), "down": min(len(order), i + 1), "bottom": len(order)}.get(where)
    if j is None:
        raise ValueError("Movimiento no válido")
    order.insert(j, job_id)
    with Session(engine) as s:  # 1, 2, 3…: los que se encolen después (rank = su id, mayor) van detrás
        for n, jid in enumerate(order, start=1):
            job = s.get(Job, jid)
            if job and job.status == "queued":
                job.rank = float(n)
                s.add(job)
        s.commit()
    return order


def _mark_stopped(job: Job) -> None:
    """Trabajo parado: su objeto vuelve a un estado tranquilo. Un clip con una versión anterior la conserva; lo demás
    queda con el aviso «Parado por ti» y se puede relanzar."""
    with Session(engine) as s:
        handler = HANDLERS.get(job.kind)
        obj = s.get(handler[1], job.ref_id) if handler else None
        if obj is not None and hasattr(obj, "status"):
            if isinstance(obj, Clip) and obj.video_path:
                obj.status, obj.error = "review", ""
            else:
                obj.status = "error"
                if hasattr(obj, "error"):
                    obj.error = jobctl.STOPPED_MSG
            if hasattr(obj, "progress") and obj.status != "review":
                obj.progress = 0
            s.add(obj)
        db_job = s.get(Job, job.id)
        db_job.status, db_job.error, db_job.finished_at = "cancelled", jobctl.STOPPED_MSG, utcnow()
        s.add(db_job)
        s.commit()
    if hook := FAIL_HOOKS.get(job.kind):
        try:
            hook(job.ref_id)
        except Exception:  # noqa: BLE001
            log.exception("Aviso de parada de %s", job.kind)


def cancel(job_id: int) -> str:
    """Para un trabajo: si está en cola, sale de ella; si está en marcha, se matan sus procesos y se marca parado."""
    with Session(engine) as s:
        job = s.get(Job, job_id)
        if job is None:
            raise ValueError("No existe ese trabajo")
        status = job.status
        s.expunge(job)
    if status == "queued":
        _mark_stopped(job)
        return "cancelled"
    if status == "running":
        if not jobctl.cancel(job_id):
            raise ValueError("El trabajo está terminando")
        return "stopping"
    raise ValueError("El trabajo ya ha terminado")


def _recover() -> None:
    """Tras un cierre inesperado, los trabajos que estaban en marcha vuelven a la cola."""
    with Session(engine) as s:
        for job in s.exec(select(Job).where(Job.status == "running")).all():
            job.status = "queued"
            s.add(job)
        s.commit()


def _fail(job: Job, exc: Exception) -> None:
    message = str(exc)[-1500:] or exc.__class__.__name__
    with Session(engine) as s:
        handler = HANDLERS.get(job.kind)
        obj = s.get(handler[1], job.ref_id) if handler else None
        if obj is not None and getattr(obj, "status", None) != "error":
            obj.status = "error"
            obj.error = message
            s.add(obj)
        db_job = s.get(Job, job.id)
        db_job.status = "error"
        db_job.error = message
        db_job.finished_at = utcnow()
        s.add(db_job)
        s.commit()
    if hook := FAIL_HOOKS.get(job.kind):
        try:
            hook(job.ref_id)
        except Exception:  # noqa: BLE001
            log.exception("Aviso de fallo de %s", job.kind)


class Worker(threading.Thread):
    def __init__(self) -> None:
        super().__init__(daemon=True, name="clipping-worker")
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        _recover()
        while not self._stop_event.is_set():
            job = None if _paused.is_set() else self._claim()
            if job is None:
                self._stop_event.wait(1.0)
                continue
            log.info("Trabajo %s: %s #%s", job.id, job.kind, job.ref_id)
            started = time.monotonic()
            jobctl.begin(job.id)
            try:
                handler = HANDLERS.get(job.kind)
                if handler is None:
                    raise ValueError(f"Tipo de trabajo desconocido: {job.kind}")
                # El trabajo hereda de la petición que lo lanzó si la IA puede reutilizar respuestas guardadas
                token = llm_router.REQUEST.set({"fresh": job.llm == 2, "cached": False, "notes": []} if job.llm else None)
                try:
                    handler[0](job.ref_id)
                finally:
                    llm_router.REQUEST.reset(token)
            except Exception as exc:
                stopped = isinstance(exc, jobctl.Cancelled) or jobctl.cancelled()
                jobctl.end()
                if stopped:
                    log.info("Trabajo %s parado por el usuario", job.id)
                    _mark_stopped(job)
                else:
                    log.exception("Trabajo %s falló", job.id)
                    _fail(job, exc)
                continue
            if jobctl.cancelled():  # se pidió parar justo al acabar: ya está hecho, se da por bueno
                log.info("Trabajo %s terminó antes de poder pararlo", job.id)
            jobctl.end()
            with Session(engine) as s:
                db_job = s.get(Job, job.id)
                db_job.status = "done"
                db_job.finished_at = utcnow()
                s.add(db_job)
                s.commit()
            log.info("Trabajo %s terminado en %.1f s", job.id, time.monotonic() - started)

    def _claim(self) -> Job | None:
        with Session(engine) as s:
            job = s.exec(select(Job).where(Job.status == "queued").order_by(Job.rank, Job.id)).first()
            if job is None:
                return None
            job.status = "running"
            job.started_at = utcnow()
            s.add(job)
            s.commit()
            s.refresh(job)
            s.expunge(job)
            return job
