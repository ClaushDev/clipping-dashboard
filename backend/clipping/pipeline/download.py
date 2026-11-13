"""Obtención del vídeo de origen: URL (yt-dlp) o archivo local."""
from __future__ import annotations

from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from ..config import find_exe


def is_local(url: str) -> bool:
    return Path(url).expanduser().is_file()


def is_tiktok(url: str) -> bool:
    host = (urlparse(url.strip()).hostname or "").lower()
    return host == "tiktok.com" or host.endswith(".tiktok.com")


# TikTok ofrece un formato «download» con la marca de agua; los demás (play_addr) salen limpios.
TIKTOK_FORMAT = "b[format_id!=download][vcodec!=none]/bv*[format_id!=download]+ba/b[format_id!=download]"
DEFAULT_FORMAT = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b"


def format_options(max_height: int) -> dict:
    """Formato de yt-dlp hasta `max_height` en el lado CORTO (res = el menor de ancho y alto): un vertical 1080x1920
    cuenta como 1080p, no como 1920 (con height<=1080 bajaba a 608x1080). Hasta 1080p se prefiere H.264, que Remotion
    lee rápido sin copia de edición; por encima YouTube solo da AV1/VP9 (editcopy.py lo convierte). Audio m4a: el mp4
    lo admite sin recodificar."""
    h = max(360, int(max_height or 1080))
    sort = [f"res:{h}"] + (["vcodec:h264"] if h <= 1080 else []) + ["acodec:m4a"]
    return {"format": "bv*+ba/b", "format_sort": sort}


def video_format(max_height: int) -> str:
    """Compatibilidad: el formato se elige ahora con format_options (orden por resolución del lado corto)."""
    return format_options(max_height)["format"]


def _impersonate_target():
    """Con curl_cffi instalado, yt-dlp se hace pasar por un navegador; sin él TikTok bloquea a menudo la IP."""
    try:
        import curl_cffi  # noqa: F401
        from yt_dlp.networking.impersonate import ImpersonateTarget
    except ImportError:
        return None
    return ImpersonateTarget("chrome")


def _max_height() -> int:
    try:
        from ..config import load_settings
        return int(load_settings().source_max_height)
    except Exception:  # noqa: BLE001 — ajustes ilegibles: la calidad de siempre
        return 1080


# Calidad automática (0): cuanto más largo el vídeo, menos resolución. Por encima de 1080p YouTube solo da AV1/VP9 y
# hay que hacer una copia H.264 para editar (editcopy.py), que tarda y ocupa: en un directo de 2 h a 1440p, 36 GB.
# Hasta 1080p YouTube da H.264 directamente: sin copia, descarga y render rápidos.
AUTO_STEPS = ((15 * 60, 2160), (45 * 60, 1440))  # hasta 15 min: 4K · hasta 45 min: 1440p · más: 1080p
QUALITY_LABELS = {0: "Automática", 1080: "Rápida (1080p)", 1440: "Alta (1440p)", 2160: "Máxima (4K)"}


def auto_height(duration: float) -> int:
    for limit, h in AUTO_STEPS:
        if duration and duration <= limit:
            return h
    return 1080 if duration else 1440  # sin duración conocida: término medio


def resolve_height(choice: int, duration: float) -> int:
    """`choice`: 0 = automática; si no, la altura máxima elegida (1080, 1440, 2160)."""
    return int(choice) if choice else auto_height(duration)


def js_options() -> dict:
    """YouTube exige resolver un reto en JavaScript para dar todos los formatos. yt-dlp solo busca deno por defecto y,
    sin él, avisa de que «pueden faltar formatos»; Node ya está instalado (lo usa Remotion), así que se le pasa ese."""
    node = find_exe("node")
    return {"js_runtimes": {"node": {"path": str(node)}}} if node else {}


def fetch(url: str, dest_dir: Path, on_progress: Callable[[float], None] | None = None,
          edit_copy: bool = True, max_height: int | None = None) -> tuple[Path, str]:
    """Devuelve (ruta del vídeo, título). Los archivos locales se usan en su sitio, sin copiarlos.
    `edit_copy`: si el vídeo descargado es AV1/VP9 (4K de YouTube), se convierte a H.264 con la gráfica para que
    Remotion lo lea rápido (editcopy.py); quien quiera enseñar esa etapa aparte pasa False y llama a editcopy.ensure."""
    if is_local(url):
        path = Path(url).expanduser().resolve()
        return path, path.stem

    import yt_dlp

    dest_dir.mkdir(parents=True, exist_ok=True)

    def hook(d: dict) -> None:
        if on_progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                on_progress(min(d.get("downloaded_bytes", 0) / total, 1.0))

    ffmpeg = find_exe("ffmpeg")
    opts = {
        "format": TIKTOK_FORMAT,
        "merge_output_format": "mp4",
        "outtmpl": str(dest_dir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        "progress_hooks": [hook],
    }
    if ffmpeg:
        opts["ffmpeg_location"] = str(Path(ffmpeg).parent)
    opts.update(js_options())
    if is_tiktok(url) and (target := _impersonate_target()):
        opts["impersonate"] = target
    choice = _max_height() if max_height is None else max_height
    with yt_dlp.YoutubeDL(opts) as ydl:
        if not is_tiktok(url):
            # Primero los datos (duración) para elegir la calidad; después se descarga con ese formato
            info = ydl.extract_info(url, download=False, process=False)
            height = resolve_height(choice, float(info.get("duration") or 0))
            ydl.params.update(format_options(height))
            ydl.format_selector = ydl.build_format_selector(ydl.params["format"])
            info = ydl.process_ie_result(info, download=True)
        else:
            info = ydl.extract_info(url, download=True)
        if is_tiktok(url) and any(f.get("format_id") == "download" for f in info.get("requested_formats") or [info]):
            raise RuntimeError("TikTok solo ofreció la versión con marca de agua; no se ha usado.")
        title = info.get("title") or "Sin título"
        try:  # «Más reproducido» de YouTube, en la carpeta de destino (lista vacía = no hay)
            from . import heatmap
            heatmap.save(dest_dir / heatmap.FILE, heatmap.from_info(info))
        except Exception:  # noqa: BLE001 — es una pista extra, nunca impide la descarga
            pass
        if is_tiktok(url) and title.startswith("TikTok video #"):
            caption = " ".join((info.get("description") or "").split())
            title = caption[:90] or f"TikTok de @{info.get('uploader') or 'desconocido'}"
    files = sorted(dest_dir.glob("source.*"), key=lambda p: p.stat().st_size, reverse=True)
    files = [f for f in files if f.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov")]
    if not files:
        raise RuntimeError("yt-dlp terminó pero no se encontró el vídeo descargado.")
    if edit_copy:
        from . import editcopy
        return editcopy.ensure(files[0], dest_dir, replace=True), title
    return files[0], title
