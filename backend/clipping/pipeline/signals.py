"""Señales del vídeo para buscar momentos: picos de volumen (risas, gritos, golpes) y cambios de plano,
sacados con FFmpeg. No sustituyen al LLM: se le pasan junto a la transcripción como pistas de dónde pasa algo."""
from __future__ import annotations

import json
import logging
import math
import re
import subprocess
from array import array
from pathlib import Path

from .. import jobctl
from ..config import require_exe
from .media import NO_WINDOW

log = logging.getLogger("clipping.signals")

RATE = 8000  # Hz: de sobra para el volumen y ligero de leer
WIN = 0.25  # segundos por ventana de volumen
SCENE = 0.35  # umbral de cambio de plano del filtro select de FFmpeg (0-1)


def loudness(video: Path) -> list[float]:
    """Volumen (dBFS) de cada ventana de 0,25 s, leyendo el audio en mono a 8 kHz por partes."""
    proc = subprocess.Popen([require_exe("ffmpeg"), "-hide_banner", "-v", "error", "-i", str(video), "-vn", "-ac", "1",
                             "-ar", str(RATE), "-f", "s16le", "-"], stdout=subprocess.PIPE, creationflags=NO_WINDOW)
    jobctl.track(proc)
    step = int(RATE * WIN) * 2  # bytes por ventana
    out: list[float] = []
    buf = b""
    while True:
        data = proc.stdout.read(step * 64)
        if not data:
            break
        buf += data
        while len(buf) >= step:
            win, buf = buf[:step], buf[step:]
            samples = array("h", win)
            rms = math.sqrt(sum(x * x for x in samples) / len(samples)) if samples else 0
            out.append(20 * math.log10(max(rms, 1) / 32768))
    proc.wait()
    return out


def audio_peaks(db: list[float], limit: int = 400) -> list[dict]:
    """Tramos claramente más fuertes que el nivel normal de la voz (el percentil 75 de las ventanas con sonido) en 6 dB
    o más, con su segundo de inicio, duración y cuánto destacan. Los picos separados por menos de 0,5 s se unen."""
    if len(db) < 20:
        return []
    voiced = sorted(d for d in db if d > -55) or sorted(db)
    med = voiced[int(len(voiced) * 0.75)]
    thr = med + 6
    peaks: list[dict] = []
    for i, d in enumerate(db):
        if d < thr:
            continue
        t = round(i * WIN, 2)
        if peaks and t - (peaks[-1]["t"] + peaks[-1]["d"]) <= 0.5:
            p = peaks[-1]
            p["d"] = round(t + WIN - p["t"], 2)
            p["db"] = max(p["db"], round(d - med, 1))
        else:
            peaks.append({"t": t, "d": WIN, "db": round(d - med, 1)})
    return sorted(peaks, key=lambda p: -p["db"])[:limit]


def shot_changes(video: Path) -> list[float]:
    """Segundos donde cambia el plano (filtro scene de FFmpeg sobre una copia diminuta del vídeo)."""
    proc = subprocess.run([require_exe("ffmpeg"), "-hide_banner", "-i", str(video), "-an", "-vf",
                           f"scale=160:-2,select='gt(scene,{SCENE})',showinfo", "-f", "null", "-"],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    return [round(float(m), 2) for m in re.findall(r"pts_time:([\d.]+)", proc.stderr)]


def analyze(video: Path, cache: Path) -> dict:
    """Las dos señales, guardadas junto a la fuente para no repetir el análisis al regenerar."""
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except ValueError:
            pass
    out = {"peaks": [], "shots": []}
    try:
        out["peaks"] = audio_peaks(loudness(video))
    except Exception:
        log.exception("No se pudo medir el volumen de %s", video)
    try:
        out["shots"] = shot_changes(video)
    except Exception:
        log.exception("No se pudieron leer los cambios de plano de %s", video)
    cache.write_text(json.dumps(out), encoding="utf-8")
    return out


def prompt_block(sig: dict | None, start: float, end: float) -> str:
    """Texto para el prompt de momentos con las señales de un bloque de la transcripción."""
    if not sig:
        return ""
    from .heatmap import prompt_block as heat_block

    peaks =sorted((p for p in sig.get("peaks", []) if start <= p["t"] < end), key=lambda p: p["t"])[:30]
    shots = [t for t in sig.get("shots", []) if start <= t < end]
    lines = []
    if peaks:
        lines.append("AUDIO PEAKS (much louder than usual: laughter, shouting, impacts, music hits) — [second] +dB over "
                     "the video's normal level, duration:\n" + "\n".join(f"[{p['t']:.1f}] +{p['db']:.0f} dB, {p['d']:.1f} s" for p in peaks))
    if shots:
        per_min = len(shots) / max((end - start) / 60, 1 / 60)
        busy = []  # minutos con muchos cambios de plano: acción, montaje o reacción
        for m in range(int(start // 60), int(end // 60) + 1):
            n = sum(1 for t in shots if m * 60 <= t < m * 60 + 60)
            if n >= max(6, per_min * 1.8):
                busy.append(f"{m * 60}-{m * 60 + 60}s ({n} cuts)")
        lines.append(f"SHOT CHANGES: {len(shots)} in this excerpt ({per_min:.1f}/min)."
                     + (f" Busiest stretches: {', '.join(busy[:8])}." if busy else "")
                     + " First ones: " + ", ".join(f"{t:.1f}" for t in shots[:40]))
    if heat := heat_block(sig.get("heatmap"), start, end):
        lines.insert(0, heat)
    if not lines:
        return ""
    return ("\nSIGNALS FROM THE VIDEO (supporting evidence only; the transcript decides). A strong moment often contains "
            "a reaction peak; a peak can also be the payoff or the best line to open with.\n" + "\n".join(lines) + "\n")
