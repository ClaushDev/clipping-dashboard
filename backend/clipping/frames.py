"""Fotogramas y objetos del vídeo original: extraer un fotograma, localizar un objeto por texto (detector local) y
pasar un punto del original al lienzo. Los usa el chat del editor."""
from __future__ import annotations

import logging
from pathlib import Path

from . import mlrun as ml
from .config import require_exe
from .pipeline.media import run as run_cmd

log = logging.getLogger("clipping.frames")
CANVAS = (1080, 1920)


def source_to_canvas(layout: str, src_w: int, src_h: int, nx: float, ny: float) -> tuple[float, float]:
    """Punto del original (0-1) → punto del lienzo 9:16 (0-1) para los encuadres recorte o vídeo entero."""
    W, H = CANVAS
    if layout == "crop":  # recorte centrado, zoom 1 (como cropRect en schema.ts)
        if src_w / src_h > W / H:
            ch, cw = src_h, src_h * W / H
        else:
            cw, ch = src_w, src_w * H / W
        left, top = (src_w - cw) / 2, (src_h - ch) / 2
        return (min(1, max(0, (nx * src_w - left) / cw)), min(1, max(0, (ny * src_h - top) / ch)))
    scale = min(W / src_w, H / src_h)
    vw, vh = src_w * scale, src_h * scale
    return ((W - vw) / 2 + nx * vw) / W, ((H - vh) / 2 + ny * vh) / H


def extract_frame(video: Path, t: float, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    run_cmd([require_exe("ffmpeg"), "-hide_banner", "-y", "-ss", f"{max(0.0, t):.3f}", "-i", str(video),
             "-frames:v", "1", "-q:v", "3", str(out)], timeout=60)
    return out


def locate(items: list[dict]) -> dict[str, dict]:
    """[{id, image, query}] → {id: {box, score}} con el detector local. Sin entorno ML, nada (se usa el centro)."""
    if not items or not ml.available():
        return {}
    found: dict[str, dict] = {}
    try:
        ml.run("detect.py", {"items": items, "threshold": 0.3}, on_item=lambda it: found.__setitem__(it["id"], it),
               timeout=900)
    except Exception:
        log.exception("El detector de objetos falló; los efectos van al centro")
    return found
