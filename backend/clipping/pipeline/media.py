"""Utilidades de FFmpeg / FFprobe."""
from __future__ import annotations

import json
import subprocess
from functools import lru_cache
from pathlib import Path

from .. import jobctl
from ..config import require_exe

# Evita que cada proceso hijo abra una ventana de consola en Windows.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def run(cmd: list[str], cwd: Path | None = None, timeout: float | None = None) -> subprocess.CompletedProcess:
    from .. import activity

    tool = Path(str(cmd[0])).stem.lower() if cmd else "ffmpeg"
    with activity.step("ffmpeg", "Procesar audio y vídeo" if tool == "ffmpeg" else f"Leer el archivo ({tool})", "FFmpeg"):
        return _run(cmd, cwd, timeout)


def _run(cmd: list[str], cwd: Path | None, timeout: float | None) -> subprocess.CompletedProcess:
    # Popen en vez de run: así «Parar» en la cola de trabajos puede matar el FFmpeg en marcha (jobctl)
    p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                         errors="replace", creationflags=NO_WINDOW)
    jobctl.track(p)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        p.communicate()
        raise
    finally:
        jobctl.untrack(p)
    proc = subprocess.CompletedProcess(cmd, p.returncode, out, err)
    if proc.returncode != 0:
        jobctl.check()
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise RuntimeError(f"{Path(cmd[0]).name} falló (código {proc.returncode}):\n{tail}")
    return proc


def probe(path: str | Path) -> dict:
    out = run([
        require_exe("ffprobe"), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]).stdout
    data = json.loads(out)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not video:
        raise RuntimeError("El archivo no contiene vídeo.")
    width, height = int(video["width"]), int(video["height"])
    rotation = 0
    for side in video.get("side_data_list", []) or []:
        if "rotation" in side:
            rotation = abs(int(side["rotation"]))
    if rotation in (90, 270):
        width, height = height, width
    num, _, den = (video.get("avg_frame_rate") or "30/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    return {
        "duration": float(data["format"].get("duration") or video.get("duration") or 0),
        "width": width,
        "height": height,
        "fps": fps or 30.0,
        "has_audio": audio is not None,
    }


@lru_cache(maxsize=1)
def nvenc_available() -> bool:
    try:
        run([
            require_exe("ffmpeg"), "-hide_banner", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.2",
            "-c:v", "h264_nvenc", "-f", "null", "-",
        ], timeout=30)
        return True
    except Exception:
        return False


def video_encoder_args(preference: str) -> list[str]:
    use_nvenc = preference == "nvenc" or (preference == "auto" and nvenc_available())
    if use_nvenc:
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0",
                "-profile:v", "high", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]


def probe_audio_duration(path: str | Path) -> float:
    """Duración de un archivo de audio (probe() exige pista de vídeo)."""
    out = run([require_exe("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of",
               "default=noprint_wrappers=1:nokey=1", str(path)]).stdout.strip()
    return round(float(out or 0), 2)
