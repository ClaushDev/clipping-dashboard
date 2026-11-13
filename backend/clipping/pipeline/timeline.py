"""Forma de onda y tira de miniaturas de un vídeo largo, para las líneas de tiempo donde se marcan tramos a mano
(editor y «Marcar a mano»). Se calculan una vez y se guardan en la carpeta que se indique."""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Callable

import numpy as np

from ..config import require_exe
from .media import run
from .transcribe import load_audio

PEAK_STEP = 0.1  # segundos por barra de la forma de onda

_filmstrip_lock = threading.Lock()


def peaks(video: Path, cache: Path) -> dict:
    """Máximo del audio por cada 0,1 s, de 0 a 255."""
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    rate = 8000
    audio = np.abs(load_audio(video, rate))
    hop = int(rate * PEAK_STEP)
    n = len(audio) // hop
    bars = audio[: n * hop].reshape(n, hop).max(axis=1) if n else np.zeros(0)
    top = float(np.percentile(bars, 99)) if n else 1.0
    data = {"step": PEAK_STEP, "peaks": np.clip(bars / max(top, 1e-4) * 255, 0, 255).astype(int).tolist()}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data), encoding="utf-8")
    return data


def filmstrip(video: Path, folder: Path, start: float, end: float, duration: float, width: int, height: int,
              url_of: Callable[[str], str]) -> dict:
    """Miniaturas de un tramo en una sola imagen (rejilla de 20 columnas).

    Solo decodifica el tramo pedido (redondeado a 30 s) y se guarda: abrir otra vez el editor es inmediato."""
    duration = duration or end
    a = max(0, int(start // 30) * 30)
    b = int(-(-max(end, start + 1) // 30) * 30)
    if duration:
        b = min(b, int(duration) + 1)
    step = max(0.5, round((b - a) / 600, 1))
    count = max(1, int((b - a) / step))
    cols = 20
    rows = -(-count // cols)
    name = f"filmstrip_{a}_{b}.jpg"
    out = folder / name
    meta = out.with_suffix(".json")
    with _filmstrip_lock:
        if not meta.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            run([require_exe("ffmpeg"), "-hide_banner", "-v", "error", "-y", "-ss", f"{a}", "-t", f"{b - a}",
                 "-i", str(video), "-vf", f"fps=1/{step},scale=-2:72,tile={cols}x{rows}", "-frames:v", "1",
                 "-q:v", "6", str(out)], timeout=300)
            h = 72
            w = round(h * (width or 16) / (height or 9) / 2) * 2
            meta.write_text(json.dumps({"url": url_of(name), "start": a, "end": b, "step": step, "count": count,
                                        "cols": cols, "tile_w": w, "tile_h": h}), encoding="utf-8")
    return json.loads(meta.read_text(encoding="utf-8"))
