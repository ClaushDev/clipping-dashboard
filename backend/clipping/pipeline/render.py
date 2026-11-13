"""Utilidades de FFmpeg sobre vídeos ya renderizados (el render en sí lo hace Remotion, ver remotion.py)."""
from __future__ import annotations

from pathlib import Path

from ..config import require_exe
from .media import run


def thumbnail(video: Path, out: Path, at: float = 1.0) -> Path:
    run([require_exe("ffmpeg"), "-hide_banner", "-y", "-ss", f"{at:.2f}", "-i", str(video),
         "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", str(out)], timeout=120)
    return out


def frame(video: Path, out: Path, at: float) -> Path:
    """Fotograma a resolución completa (fondo de las miniaturas de la fase 9)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    run([require_exe("ffmpeg"), "-hide_banner", "-y", "-ss", f"{max(at, 0):.2f}", "-i", str(video),
         "-frames:v", "1", "-q:v", "2", str(out)], timeout=120)
    return out
