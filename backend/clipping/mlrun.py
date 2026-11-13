"""Lanza los scripts del entorno ml/ (SAM 2 y detector de objetos) como procesos aparte.

Cada proceso carga su modelo, trabaja y muere: así libera toda la VRAM antes del siguiente paso.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from .config import MODELS_DIR, ROOT
from .pipeline.media import NO_WINDOW

ML_DIR = ROOT / "ml"
# Entorno «ml» (PyTorch CUDA + transformers): seguimiento de puntos y recortes (SAM 2) y detector de objetos.
PYTHONS = {"ml": ML_DIR / ".venv" / "Scripts" / "python.exe"}
SETUP = {"ml": "ml/setup.ps1"}
ML_PYTHON = PYTHONS["ml"]


def available(env_name: str = "ml") -> bool:
    return PYTHONS[env_name].exists()


def run(script: str, job: dict, on_progress: Callable[[float], None] | None = None,
        on_item: Callable[[dict], None] | None = None, timeout: float = 6 * 3600, env_name: str = "ml") -> None:
    if not available(env_name):
        raise RuntimeError(f"El entorno de modelos «{env_name}» no está instalado. Ejecuta {SETUP.get(env_name, 'ml\\setup.ps1')} desde una terminal.")
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump(job, fh)
        job_path = fh.name
    env = {**os.environ, "HF_HOME": str(MODELS_DIR / "hf"), "CLIPPING_MODELS": str(MODELS_DIR),
           "TORCH_HOME": str(MODELS_DIR / "torch"),
           "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
    from . import activity

    label, model = activity.ml_names(script)
    n = len(job.get("items") or [])
    with activity.step("ml", label, model, detail=f"{n} elemento{'s' if n != 1 else ''}" if n else "") as st:
        def progress(v: float) -> None:
            st.progress = v
            if on_progress:
                on_progress(v)

        _run(script, job, job_path, env, env_name, progress, on_item, timeout)


def _run(script: str, job: dict, job_path: str, env: dict, env_name: str, on_progress, on_item, timeout: float) -> None:
    try:
        proc = subprocess.Popen(
            [str(PYTHONS[env_name]), str(ML_DIR / script), job_path], cwd=ML_DIR, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
            creationflags=NO_WINDOW,
        )
        error, tail = "", []
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                if line:
                    tail = (tail + [line])[-25:]
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "progress" in event and on_progress:
                on_progress(float(event["progress"]))
            if "item" in event and on_item:
                on_item(event["item"])
            if "error" in event:
                error = event["error"]
        if proc.wait(timeout=timeout) != 0:
            raise RuntimeError(f"{script} falló: {(error or chr(10).join(tail))[-1500:]}")
    finally:
        Path(job_path).unlink(missing_ok=True)
