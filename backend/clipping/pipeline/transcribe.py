"""Transcripción con faster-whisper (GPU) y marcas de tiempo por palabra."""
from __future__ import annotations

import gc
import logging
import multiprocessing as mp
import os
import site
import subprocess
import sys
from pathlib import Path
from queue import Empty
from typing import Callable

import numpy as np

from .. import jobctl, punctuation
from ..config import MODELS_DIR, Settings, require_exe
from .media import NO_WINDOW

log = logging.getLogger("clipping.transcribe")
_dlls_ready = False


def _setup_cuda_dlls() -> None:
    """Expone a CTranslate2 las DLL de cuBLAS/cuDNN instaladas con los paquetes pip de NVIDIA."""
    global _dlls_ready
    if _dlls_ready or sys.platform != "win32":
        return
    roots = [Path(p) for p in site.getsitepackages()] + [Path(sys.prefix) / "Lib" / "site-packages"]
    for root in roots:
        for bin_dir in (root / "nvidia").glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
    _dlls_ready = True


def _child(media: str, settings_json: str, queue) -> None:
    try:
        settings = Settings.model_validate_json(settings_json)
        data = transcribe(Path(media), settings, lambda p: queue.put(("progress", p)))
        queue.put(("result", data))
    except Exception as exc:
        queue.put(("error", str(exc)))


def transcribe_isolated(media: Path, settings: Settings,
                        on_progress: Callable[[float], None] | None = None) -> dict:
    """Transcribe en un proceso hijo. Al terminar, el proceso muere y libera toda la VRAM:
    CTranslate2 conserva memoria de CUDA aunque se borre el modelo, y Ollama la necesita después."""
    from .. import activity

    with activity.step("whisper", "Transcribir la voz", f"faster-whisper {settings.whisper_model}",
                       detail=Path(media).name) as st:
        def progress(v: float) -> None:
            st.progress = v
            if on_progress:
                on_progress(v)

        return _transcribe_isolated(media, settings, progress)


def _transcribe_isolated(media: Path, settings: Settings, on_progress: Callable[[float], None] | None) -> dict:
    ctx = mp.get_context("spawn")
    queue = ctx.Queue()
    proc = ctx.Process(target=_child, args=(str(media), settings.model_dump_json(), queue), daemon=True)
    proc.start()
    jobctl.track(proc)
    try:
        while True:
            jobctl.check()
            try:
                kind, payload = queue.get(timeout=5)
            except Empty:
                if not proc.is_alive():
                    raise RuntimeError(f"El proceso de transcripción terminó inesperadamente (código {proc.exitcode})")
                continue
            if kind == "progress":
                if on_progress:
                    on_progress(payload)
            elif kind == "result":
                return payload
            else:
                raise RuntimeError(payload)
    finally:
        jobctl.untrack(proc)
        proc.join(timeout=0 if jobctl.cancelled() else 30)
        if proc.is_alive():
            proc.kill()


def transcribe(media: Path, settings: Settings, on_progress: Callable[[float], None] | None = None) -> dict:
    _setup_cuda_dlls()
    attempts = [(settings.whisper_device, settings.whisper_compute_type)]
    if settings.whisper_device != "cpu":
        attempts.append(("cpu", "int8"))
    error: Exception | None = None
    for device, compute_type in attempts:
        try:
            return _run(media, settings, device, compute_type, on_progress)
        except Exception as exc:  # p. ej. DLL de CUDA ausente: se reintenta en CPU
            log.warning("Transcripción en %s falló: %s", device, exc)
            error = exc
    raise RuntimeError(f"La transcripción falló: {error}")


def load_audio(media: Path, sample_rate: int = 16000) -> np.ndarray:
    """Decodifica con FFmpeg a PCM mono 16 kHz (evita depender de la API de PyAV, que cambia a menudo)."""
    proc = subprocess.run(
        [require_exe("ffmpeg"), "-nostdin", "-v", "error", "-i", str(media), "-vn", "-ac", "1",
         "-ar", str(sample_rate), "-f", "s16le", "-"],
        capture_output=True, creationflags=NO_WINDOW,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg no pudo extraer el audio: {proc.stderr.decode(errors='replace')[-500:]}")
    return np.frombuffer(proc.stdout, np.int16).astype(np.float32) / 32768.0


def _run(media: Path, settings: Settings, device: str, compute_type: str,
         on_progress: Callable[[float], None] | None) -> dict:
    from faster_whisper import WhisperModel

    audio = load_audio(media)
    model = WhisperModel(settings.whisper_model, device=device, compute_type=compute_type,
                         download_root=str(MODELS_DIR / "whisper"))
    try:
        # una frase bien puntuada en el idioma del vídeo hace que Whisper siga poniendo signos (sin ella, a veces
        # los deja de poner durante minutos). Si no se sabe el idioma, se detecta antes con los primeros 30 s.
        lang = settings.language or ""
        if not lang:
            try:
                lang = model.detect_language(audio[: 16000 * 30])[0]
            except Exception:  # noqa: BLE001 — versiones sin detect_language: sin prompt
                lang = ""
        segments, info = model.transcribe(
            audio, language=settings.language or None, word_timestamps=True,
            vad_filter=True, beam_size=5, initial_prompt=punctuation.initial_prompt(lang),
        )
        out_segments: list[dict] = []
        words: list[dict] = []
        for seg in segments:
            out_segments.append({"s": round(float(seg.start), 3), "e": round(float(seg.end), 3), "text": seg.text.strip()})
            for w in seg.words or []:
                text = w.word.strip()
                if text:
                    words.append({"w": text, "s": round(float(w.start), 3), "e": round(float(w.end), 3),
                                  "p": round(float(w.probability), 3)})
            if on_progress and info.duration:
                on_progress(min(seg.end / info.duration, 1.0))
        return {
            "language": info.language,
            "duration": info.duration,
            "model": settings.whisper_model,
            "device": device,
            "segments": out_segments,
            "words": words,
        }
    finally:
        del model
        gc.collect()
