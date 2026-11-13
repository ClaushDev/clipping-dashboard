"""Mejora de voz local (como «Mejorar voz» de Premiere): quita ruido de fondo y deja la voz más clara.

Usa el filtro `arnndn` de FFmpeg (RNNoise, red neuronal pequeña que corre en la CPU) con el modelo libre
«somnolent-hogwash» (voz con ruido general) de github.com/richardpl/arnndn-models, que se baja solo la primera vez
(~300 KB). Encima: corte de graves (zumbidos), un poco de presencia y un compresor suave.

Se limpia el sonido de todo el archivo una vez por nivel; el tramo lo usa con los mismos tiempos que el vídeo
(`Segment.voice` en schema.ts)."""
from __future__ import annotations

import hashlib
import logging
import subprocess
import urllib.request
from pathlib import Path

from ..config import CLIPS_DIR, MODELS_DIR, require_exe

log = logging.getLogger(__name__)

MODEL_URL = "https://raw.githubusercontent.com/richardpl/arnndn-models/master/sh.rnnn"
MODEL = MODELS_DIR / "rnnoise" / "sh.rnnn"
LEVELS = {"light": 0.6, "strong": 1.0}


def ensure_model() -> Path:
    if MODEL.exists() and MODEL.stat().st_size > 1000:
        return MODEL
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    part = MODEL.with_suffix(".part")
    log.info("Descargando el modelo de RNNoise para mejorar la voz")
    try:
        urllib.request.urlretrieve(MODEL_URL, part)
    except OSError as exc:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"No se pudo bajar el modelo de limpieza de voz: {exc}") from exc
    part.replace(MODEL)
    return MODEL


def audio_filter(level: str) -> str:
    """Cadena de filtros. El modelo va por nombre relativo: FFmpeg se ejecuta en su carpeta (así las rutas de Windows,
    con «C:», no rompen el filtro)."""
    mix = LEVELS[level]
    return ",".join([
        "highpass=f=75",
        f"arnndn=m={MODEL.name}:mix={mix}",
        # RNNoise suelta a veces un bloque de 10 ms con NaN (visto en un vídeo de 29 min): sin esto el codificador AAC
        # falla, y pasado a 16 bits sería un chasquido a todo volumen. Así queda un silencio de 10 ms. (Canal a canal:
        # con «c=same» FFmpeg 9.0.2 se cuelga en algunos vídeos cortos.)
        "aeval=exprs='" + "|".join(f"if(isnan(val({c}))+isinf(val({c})),0,val({c}))" for c in (0, 1)) + "':channel_layout=stereo",
        "equalizer=f=3000:t=q:w=1.2:g=2.5",  # presencia
        "acompressor=threshold=-22dB:ratio=2.5:attack=8:release=120:makeup=2",
    ])


def enhance(video: Path, clip_id: int, level: str) -> str:
    """Sonido limpio de `video` (todo el archivo) para el clip; devuelve su URL. Se recuerda por archivo y nivel."""
    if level not in LEVELS:
        raise ValueError("Nivel de mejora de voz no válido")
    if not video.exists():
        raise ValueError("No encuentro el vídeo de ese tramo")
    ensure_model()
    key = hashlib.sha1(f"{video.resolve()}|{video.stat().st_mtime}|{level}|3".encode()).hexdigest()[:12]
    out_dir = CLIPS_DIR / str(clip_id) / "voice"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{key}.m4a"
    if not out.exists():
        part = out.with_suffix(".part.m4a")
        cmd = [require_exe("ffmpeg"), "-v", "error", "-y", "-i", str(video.resolve()), "-vn", "-ac", "2", "-ar", "48000",
               "-af", audio_filter(level), "-c:a", "aac", "-b:a", "192k", str(part.resolve())]
        r = subprocess.run(cmd, cwd=MODEL.parent, capture_output=True, text=True, timeout=1800)
        if r.returncode or not part.exists():
            part.unlink(missing_ok=True)
            raise RuntimeError(f"FFmpeg no pudo limpiar la voz: {(r.stderr or '').strip()[-300:]}")
        part.replace(out)
    return f"/media/clips/{clip_id}/voice/{out.name}"
