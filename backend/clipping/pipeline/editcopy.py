"""Copia de edición: vídeos de origen que Remotion lee rápido.

Las fuentes se descargan en la mejor calidad, y por encima de 1080p YouTube solo da AV1 o VP9. Remotion saca
cada fotograma decodificando el original con el procesador, y en 4K AV1 eso hace que un clip de 30 s tarde ~17 min
(frente a ~1 min con H.264 1080p). Aquí se convierte el original una sola vez a H.264 con la gráfica (NVENC), con la
misma resolución y un fotograma clave por segundo (saltar a cualquier punto es inmediato). Sin NVENC, libx264.
"""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Callable

from .. import jobctl
from ..config import require_exe
from .media import NO_WINDOW, nvenc_available

log = logging.getLogger("clipping.editcopy")

FAST_CODECS = {"h264"}  # lo que Remotion decodifica deprisa
MAX_GOP_SECS = 2.0  # H.264 con fotogramas clave más separados también se convierte


def _video_info(path: Path) -> dict:
    out = subprocess.run(
        [require_exe("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,avg_frame_rate,width,height:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, creationflags=NO_WINDOW, timeout=60,
    )
    data = json.loads(out.stdout or "{}")
    v = (data.get("streams") or [{}])[0]
    num, _, den = (v.get("avg_frame_rate") or "30/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    return {"codec": v.get("codec_name", ""), "fps": fps or 30.0, "width": int(v.get("width") or 0),
            "height": int(v.get("height") or 0), "duration": float((data.get("format") or {}).get("duration") or 0)}


def needs_copy(path: Path) -> bool:
    """¿Hay que convertirlo? Sí si no es H.264 (AV1, VP9, HEVC…). Los H.264 de YouTube ya renderizan rápido."""
    try:
        return _video_info(path)["codec"] not in FAST_CODECS
    except Exception:  # noqa: BLE001 — si no se puede leer, se deja como está
        log.warning("No se pudo leer el códec de %s", path, exc_info=True)
        return False


def max_rate(height: int) -> int:
    """Techo de bitrate de la copia en Mbps. Antes era 60 para todo y un directo de 2 h a 1440p ocupó 36 GB (44 Mbps):
    con un fotograma clave por segundo ya se ve bien con mucho menos. YouTube sirve 1440p a ~10-18 Mbps."""
    return 12 if height <= 1080 else 20 if height <= 1440 else 35


def _cmd(src: Path, dest: Path, fps: float, encoder: str, hw_decode: bool, height: int = 1080,
         scale_to: int = 0) -> list[str]:
    gop = str(max(1, round(fps)))
    cmd = [require_exe("ffmpeg"), "-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1"]
    if hw_decode:
        cmd += ["-hwaccel", "cuda"]
    cmd += ["-i", str(src), "-map", "0:v:0", "-map", "0:a?"]
    if scale_to:  # aligerar: el lado corto a `scale_to` (1080 en un 2560x1440 → 1920x1080; en vertical, 1080x1920)
        cmd += ["-vf", f"scale='if(gt(iw,ih),-2,{scale_to})':'if(gt(iw,ih),{scale_to},-2)'"]
        height = scale_to
    if encoder == "nvenc":
        # Calidad alta (cq 21) con techo de bitrate según la resolución (max_rate)
        rate = max_rate(height)
        cmd += ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-maxrate", f"{rate}M",
                "-bufsize", f"{rate * 2}M", "-profile:v", "high"]
    else:
        rate = max_rate(height)
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-maxrate", f"{rate}M", "-bufsize", f"{rate * 2}M"]
    cmd += ["-g", gop, "-keyint_min", gop, "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "copy",
            "-movflags", "+faststart", str(dest)]
    return cmd


def make_copy(src: Path, dest: Path, on_progress: Callable[[float], None] | None = None, scale_to: int = 0) -> Path:
    """Convierte `src` en `dest` (H.264, misma resolución, GOP de 1 s). Escribe en un temporal y lo renombra al
    terminar, así nunca queda un archivo a medias con el nombre bueno."""
    info = _video_info(src)
    tmp = dest.with_name(dest.stem + ".part.mp4")
    # Con escala, la decodificación por GPU deja los fotogramas en la gráfica y el filtro scale de CPU no los ve
    attempts = ([("nvenc", not scale_to)] + ([("nvenc", False)] if not scale_to else [])) if nvenc_available() else []
    attempts.append(("x264", False))
    error = ""
    for encoder, hw in attempts:
        proc = subprocess.Popen(_cmd(src, tmp, info["fps"], encoder, hw, min(info["width"], info["height"]) or 1080, scale_to), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                                creationflags=NO_WINDOW)
        jobctl.track(proc)
        for line in proc.stdout:  # -progress: líneas clave=valor
            if on_progress and line.startswith("out_time_us=") and info["duration"]:
                try:
                    on_progress(min(1.0, int(line.split("=", 1)[1]) / 1e6 / info["duration"]))
                except ValueError:
                    pass
        error = proc.stderr.read()[-800:]
        jobctl.untrack(proc)
        if proc.wait() != 0 and jobctl.cancelled():
            tmp.unlink(missing_ok=True)
            jobctl.check()
        if proc.wait() == 0 and tmp.exists() and tmp.stat().st_size > 0:
            tmp.replace(dest)
            log.info("Copia de edición lista (%s%s): %s", encoder, ", decodifica la GPU" if hw else "", dest)
            return dest
        log.warning("La copia de edición con %s (hw=%s) falló: %s", encoder, hw, error)
        tmp.unlink(missing_ok=True)
    raise RuntimeError(f"No se pudo preparar el vídeo para editar: {error}")


def ensure(video: Path, folder: Path, replace: bool,
           on_progress: Callable[[float], None] | None = None) -> Path:
    """Devuelve el vídeo que deben usar el editor y el render. Si hace falta, crea la copia de edición:
    - `replace=True` (descargado por la app): sustituye al original, que solo ocupaba sitio.
    - `replace=False` (archivo tuyo): se guarda aparte en `folder/edit.mp4` y el tuyo no se toca."""
    if not needs_copy(video):
        return video
    if replace:
        dest = video.with_name(video.stem + ".h264.mp4")
        make_copy(video, dest, on_progress)
        video.unlink(missing_ok=True)
        final = video.with_suffix(".mp4") if video.suffix.lower() != ".mp4" else video
        dest.replace(final)
        return final
    dest = folder / "edit.mp4"
    if dest.exists() and not needs_copy(dest):
        return dest
    folder.mkdir(parents=True, exist_ok=True)
    return make_copy(video, dest, on_progress)
