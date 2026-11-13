"""Rutas del proyecto, ajustes persistentes y localización de ejecutables externos."""
from __future__ import annotations

import glob
import json
import logging
import os
import shutil
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("CLIPPING_DATA", ROOT / "data"))
SOURCES_DIR = DATA_DIR / "sources"
CLIPS_DIR = DATA_DIR / "clips"
UPLOADS_DIR = DATA_DIR / "uploads"
MODELS_DIR = DATA_DIR / "models"
LOGS_DIR = DATA_DIR / "logs"
SETTINGS_PATH = DATA_DIR / "settings.json"
DB_PATH = DATA_DIR / "app.db"
FRONTEND_DIST = ROOT / "frontend" / "dist"

log = logging.getLogger("clipping")


class Settings(BaseModel):
    llm_provider: str = "claude"  # "claude" | "ollama"
    claude_model: str = ""  # vacío = el modelo por defecto de Claude Code
    # Modelo por tarea (llm/router.py): tarea → auto | ollama | default | ID exacto (claude-opus-5-5…). Falta = auto.
    llm_task_models: dict[str, str] = Field(default_factory=dict)
    # esfuerzo por tarea (low | medium | high | xhigh | max; falta = el recomendado)
    llm_task_effort: dict[str, str] = Field(default_factory=dict)

    @field_validator("llm_task_models", "claude_model", mode="before")
    @classmethod
    def _migrate_routes(cls, v):  # alias de familia («opus», «sonnet», «haiku») → ID exacto
        from .llm.router import migrate_route  # el router importa config: aquí, al validar
        return {k: migrate_route(r) for k, r in v.items()} if isinstance(v, dict) else migrate_route(v) \
            if isinstance(v, str) else v
    llm_cache: bool = True  # reutilizar la respuesta si se repite la misma petición con el mismo modelo
    llm_cache_days: int = 30
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen3.5:9b"
    # modelo de Ollama que ve imágenes para describir planos ("" = el primero instalado que tenga visión)
    ollama_vision_model: str = ""
    whisper_model: str = "large-v3-turbo"
    whisper_device: str = "cuda"
    whisper_compute_type: str = "float16"
    language: str = ""  # idioma del audio para Whisper; "" = detectarlo
    encoder: str = "auto"  # "auto" | "nvenc" | "x264" (solo para utilidades de FFmpeg)
    render_speed: str = "balanced"  # fast | balanced | quality (RENDER_SPEEDS): preset de x264, JPEG intermedio y núcleos
    master_export: str = "youtube_shorts"  # preset con el que se renderiza la versión de revisión
    # Altura máxima al descargar de YouTube y similares. Un 16:9 de 1080 p recortado a 9:16 deja ~607 px de ancho
    # que hay que ampliar: medido con VMAF, 1080 → 67, 1440 → 82, 2160 → 97. Más alto = más disco y render algo más lento.
    source_max_height: int = 0  # 0 = automática según la duración (download.auto_height); 1080, 1440, 2160
    # Valores por defecto al procesar un vídeo (cada vídeo puede cambiarlos)
    clips_per_source: int = 5
    min_duration: float = 30
    max_duration: float = 60
    default_template_id: int | None = None  # plantilla de subtítulos por defecto (None = la primera)
    # Contexto general para la IA al elegir momentos (nicho, público, qué buscas). Vacío = sin contexto extra.
    guidance: str = ""
    # Tu galería de sonidos: carpeta con subcarpetas por categoría; se importa a data/sfx/pack. Vacío = sin galería
    sfx_pack_dir: str = ""
    # Efectos automáticos: la IA los coloca al crear el vídeo y se retocan en el editor
    fx_auto: bool = True
    fx_speaker_zoom: bool = True  # clips con persona: zoom suave mientras habla
    fx_punch_in: bool = True  # punch-in en los momentos fuertes
    fx_numbers: bool = True  # cifras grandes que cuentan desde 0
    fx_stickers: bool = True  # emojis que entran con pop y flotan
    fx_transitions: str = "some"  # none | some (una cada ~7 s como mucho) | many
    fx_camera: bool = True  # cámara en mano sobre las imágenes fijas
    # Gancho adelantado: si el inicio natural de un clip es flojo, la IA propone un tramo de 2-4 s para verlo primero
    cold_open: str = "auto"  # auto | off
    cold_open_transition: str = "flash"  # flash (destello) | glitch (rebobinado) | text («unos segundos antes…»)
    cold_open_mode: str = "repeat"  # repeat (se ve otra vez en su sitio) | trim (se quita del cuerpo)


class ExportOptions(BaseModel):
    """Opciones de exportación. aspect "" = el de la composición."""
    aspect: str = ""
    short_side: int = 1080  # 720, 1080, 1440, 2160
    fps: int = 30
    codec: str = "h264"  # h264, h265
    crf: int = 18
    audio_bitrate: str = "192k"
    loudness: float = -14.0  # LUFS objetivo; 0 = no normalizar
    filename: str = "{id}_{title}"


# Velocidad de render (Remotion). Lo que más tarda es pintar cada fotograma en Chrome y leer el vídeo de origen; el
# códec y la calidad del JPEG intermedio pesan menos, pero suman. «quality» es lo de antes de este ajuste.
RENDER_SPEEDS: dict[str, dict] = {
    "fast": {"label": "Rápido", "x264_preset": "veryfast", "jpeg_quality": 90, "cpu_share": 0.75},
    "balanced": {"label": "Equilibrado", "x264_preset": "fast", "jpeg_quality": 95, "cpu_share": 0.6},
    "quality": {"label": "Máxima calidad", "x264_preset": "medium", "jpeg_quality": 100, "cpu_share": 0.5},
}


EXPORT_PRESETS: dict[str, dict] = {
    "youtube_shorts": {"label": "YouTube Shorts", "options": ExportOptions(aspect="9:16")},
    "tiktok": {"label": "TikTok", "options": ExportOptions(aspect="9:16", crf=20)},
    "reels": {"label": "Instagram Reels", "options": ExportOptions(aspect="9:16", crf=20)},
    "youtube_169": {"label": "YouTube 16:9", "options": ExportOptions(aspect="16:9")},
    "square": {"label": "Cuadrado 1:1", "options": ExportOptions(aspect="1:1", crf=20)},
    "feed_45": {"label": "Feed 4:5", "options": ExportOptions(aspect="4:5", crf=20)},
}


def ensure_dirs() -> None:
    for d in (DATA_DIR, SOURCES_DIR, CLIPS_DIR, UPLOADS_DIR, MODELS_DIR, LOGS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def load_settings() -> Settings:
    if SETTINGS_PATH.exists():
        try:
            return Settings(**json.loads(SETTINGS_PATH.read_text(encoding="utf-8")))
        except Exception:
            log.exception("settings.json no válido; uso valores por defecto")
    return Settings()


def save_settings(settings: Settings) -> None:
    ensure_dirs()
    SETTINGS_PATH.write_text(settings.model_dump_json(indent=2), encoding="utf-8")


def _first_existing(patterns: list[str]) -> str | None:
    for pattern in patterns:
        matches = sorted(glob.glob(os.path.expandvars(pattern)))
        if matches:
            return matches[-1]
    return None


def find_exe(name: str) -> str | None:
    """Busca un ejecutable en el PATH y, si no, en las rutas de instalación típicas de Windows.

    El servidor puede arrancar desde una terminal abierta antes de instalar la herramienta,
    así que no basta con el PATH. Solo se recuerdan los hallazgos: si algo se instala con el
    servidor ya en marcha, se detecta sin reiniciarlo.
    """
    found = _find_exe_cached(name)
    if not found:
        _find_exe_cached.cache_clear()
    return found


@lru_cache(maxsize=None)
def _find_exe_cached(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    candidates = {
        "ffmpeg": [r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg-*\bin\ffmpeg.exe"],
        "ffprobe": [r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg-*\bin\ffprobe.exe"],
        "ollama": [r"%LOCALAPPDATA%\Programs\Ollama\ollama.exe"],
        "claude": [
            r"%USERPROFILE%\.local\bin\claude.exe",
            r"%APPDATA%\npm\claude.cmd",
        ],
    }
    return _first_existing(candidates.get(name, []))


def require_exe(name: str) -> str:
    exe = find_exe(name)
    if not exe:
        raise RuntimeError(f"No se encuentra '{name}'. Instálalo o añádelo al PATH.")
    return exe
