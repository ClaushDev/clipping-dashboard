"""Parar el trabajo en marcha desde el dashboard.

El worker llama a `begin(job_id)` antes de cada trabajo y a `end()` al acabar. Los procesos hijos que lance ese trabajo
(Remotion, FFmpeg, Whisper, Claude Code…) se apuntan con `track(proc)`; `cancel(job_id)` levanta la bandera y mata
esos procesos con todos sus hijos (Chrome, el compositor de Remotion…). Las barras de progreso llaman a `check()`, que
lanza `Cancelled` en cuanto la bandera está puesta. Solo se apuntan procesos del hilo del worker: los que lanza una
petición del dashboard al mismo tiempo no se tocan.
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import threading

log = logging.getLogger("clipping.jobctl")

STOPPED_MSG = "Parado por ti"


class Cancelled(Exception):
    def __init__(self, msg: str = STOPPED_MSG):
        super().__init__(msg)


_lock = threading.Lock()
_job_id: int | None = None
_thread: threading.Thread | None = None
_flag = threading.Event()
_procs: set = set()


def begin(job_id: int) -> None:
    global _job_id, _thread
    with _lock:
        _job_id, _thread = job_id, threading.current_thread()
        _flag.clear()
        _procs.clear()


def end() -> None:
    global _job_id, _thread
    with _lock:
        _job_id, _thread = None, None
        _procs.clear()


def current() -> int | None:
    return _job_id


def mine() -> int:
    """El trabajo de la cola que corre en este hilo (0 si es una petición del dashboard u otro hilo)."""
    return (_job_id or 0) if threading.current_thread() is _thread else 0


def cancelled() -> bool:
    """¿Se ha pedido parar el trabajo en marcha? (solo cuenta en el hilo del worker)"""
    return _flag.is_set() and threading.current_thread() is _thread


def check() -> None:
    if cancelled():
        raise Cancelled()


def _kill_tree(pid: int) -> None:
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=20,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001 — ya había terminado
        log.debug("No se pudo matar el proceso %s", pid, exc_info=True)


def track(proc) -> None:
    """Apunta un proceso hijo (Popen o multiprocessing.Process) del trabajo en marcha."""
    if threading.current_thread() is not _thread:
        return
    with _lock:
        _procs.add(proc)
    if _flag.is_set():
        _kill_tree(proc.pid)


def untrack(proc) -> None:
    with _lock:
        _procs.discard(proc)


def kill(proc) -> None:
    """Mata un proceso y sus hijos (p. ej. al salir de un render por una excepción)."""
    if proc.pid:
        _kill_tree(proc.pid)


def cancel(job_id: int) -> bool:
    """Pide parar `job_id` si es el que está en marcha. Devuelve False si no lo es."""
    with _lock:
        if job_id != _job_id:
            return False
        _flag.set()
        procs = list(_procs)
    for p in procs:
        if p.pid:
            _kill_tree(p.pid)
    log.info("Trabajo %s: parado por el usuario (%d procesos)", job_id, len(procs))
    return True


def stopping(job_id: int) -> bool:
    """¿Se ha pedido parar este trabajo y aún no ha terminado?"""
    return _job_id == job_id and _flag.is_set()
