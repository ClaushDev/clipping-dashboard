"""Render de composiciones con Remotion (frontend/render.mjs) y acabado con FFmpeg."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from .. import jobctl
from ..config import ROOT, ExportOptions, require_exe
from .compose import absolutize
from .media import NO_WINDOW, run

RENDER_SCRIPT = ROOT / "frontend" / "render.mjs"
ASPECT_SIZE = {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "16:9": (1920, 1080)}
BACKEND_URL = os.environ.get("CLIPPING_URL", "http://127.0.0.1:8765")


def render_speed_job(speed: str | None = None) -> dict:
    """Campos del trabajo de render según el ajuste «Velocidad de render» (config.RENDER_SPEEDS)."""
    from ..config import RENDER_SPEEDS, load_settings

    key = speed or getattr(load_settings(), "render_speed", "balanced")
    sp = RENDER_SPEEDS.get(key) or RENDER_SPEEDS["balanced"]
    cores = os.cpu_count() or 4
    return {"x264_preset": sp["x264_preset"], "jpeg_quality": sp["jpeg_quality"],
            "concurrency": max(1, int(cores * sp["cpu_share"]))}


def render_composition(composition: dict, out: Path, options: ExportOptions | None = None,
                       on_progress: Callable[[float], None] | None = None) -> Path:
    """Renderiza la composición en `out`. Las opciones de exportación pueden cambiar formato, resolución y fps."""
    opts = options or ExportOptions()
    comp = dict(composition)
    if opts.aspect:
        comp["aspect"] = opts.aspect
    if opts.fps:
        comp["fps"] = opts.fps
    w, h = ASPECT_SIZE.get(comp.get("aspect", "9:16"), (1080, 1920))
    # Tamaño exacto en vez de "scale": Remotion exige píxeles enteros y los componentes trabajan en proporciones.
    factor = opts.short_side / min(w, h)
    comp["size"] = [round(w * factor / 2) * 2, round(h * factor / 2) * 2]

    out.parent.mkdir(parents=True, exist_ok=True)
    raw = out.with_name(out.stem + ".raw.mp4") if opts.loudness else out
    job = {
        "id": "Main",
        "composition": absolutize(comp, BACKEND_URL),
        "out": str(raw),
        "codec": opts.codec,
        "crf": opts.crf,
        "scale": 1,
        "audio_bitrate": opts.audio_bitrate,
        **render_speed_job(),
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump(job, fh)
        job_path = fh.name
    try:
        _run_node(job_path, on_progress)
    finally:
        os.unlink(job_path)

    if opts.loudness:
        # Normaliza el volumen sin recodificar el vídeo.
        run([require_exe("ffmpeg"), "-hide_banner", "-y", "-i", str(raw), "-c:v", "copy",
             "-af", f"loudnorm=I={opts.loudness}:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", opts.audio_bitrate,
             "-ar", "48000", "-movflags", "+faststart", str(out)], timeout=1800)
        raw.unlink(missing_ok=True)
    return out


def _run_node(job_path: str, on_progress: Callable[[float], None] | None, script: Path = RENDER_SCRIPT,
              on_event: Callable[[dict], None] | None = None, env: dict[str, str] | None = None) -> None:
    """`env`: variables de entorno extra para node (p. ej. REMOTION_TMP)."""
    from .. import activity

    with activity.step("render", "Render del vídeo", "Remotion · Chrome") as st:
        def progress(v: float) -> None:
            st.progress = v
            if on_progress:
                on_progress(v)

        _run_node_inner(job_path, progress, script, on_event, env)


def _run_node_inner(job_path: str, on_progress, script: Path, on_event, env) -> None:
    # stderr va al mismo tubo: dos tubos separados pueden bloquearse si uno se llena.
    proc = subprocess.Popen(
        [require_exe("node"), str(script), job_path], cwd=script.parent,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
        creationflags=NO_WINDOW, env={**os.environ, **env} if env else None,
    )
    jobctl.track(proc)  # «Parar» en la cola mata node, Chrome y el compositor
    try:
        _read_node(proc, on_progress, on_event)
    finally:
        if proc.poll() is None:
            jobctl.kill(proc)
            proc.wait()
        jobctl.untrack(proc)


def _read_node(proc: subprocess.Popen, on_progress, on_event) -> None:
    error = ""
    tail: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if not line.startswith("{"):
            if line and not line.startswith("at "):  # sin la pila: si no, tapa el mensaje del error
                tail = (tail + [line])[-30:]
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if on_event:
            on_event(event)
        if "progress" in event and on_progress:
            on_progress(float(event["progress"]))
        if "error" in event:
            error = event["error"]
    if proc.wait() != 0:
        jobctl.check()  # lo hemos matado nosotros: no es un error del render
        raise RuntimeError(f"El render de Remotion falló: {(error or chr(10).join(tail))[-1500:]}")
