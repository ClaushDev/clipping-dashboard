"""API REST del dashboard. Arranque: uvicorn clipping.api:app --port 8765"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlmodel import Session, select

from . import activity, blocks, clip_types, cutout, editor_agent, fxauto, jobctl, moment_eval, quality, sfx, subtitles
from . import worker as jobqueue
from .config import (CLIPS_DIR, DATA_DIR, EXPORT_PRESETS, FRONTEND_DIST, LOGS_DIR, RENDER_SPEEDS, SOURCES_DIR,
                     UPLOADS_DIR, ExportOptions, Settings, ensure_dirs, find_exe, load_settings, save_settings)
from .db import CaptionTemplate, Clip, Export, Job, Source, engine, init_db, touch
from .llm import router as llm_router
from .pipeline import camera, compose, download, heatmap, moments, reframe, timeline
from .pipeline.media import nvenc_available, probe
from .pipeline.process import template_for
from .worker import Worker, enqueue

ensure_dirs()
ASSETS_DIR = DATA_DIR / "assets"
EXPORTS_DIR = DATA_DIR / "exports"
for _d in (ASSETS_DIR, EXPORTS_DIR, sfx.SFX_DIR):
    _d.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(LOGS_DIR / "app.log", encoding="utf-8")],
)
logging.getLogger("httpx").setLevel(logging.WARNING)  # el chequeo de Ollama cada 15 s llenaba el log
log = logging.getLogger("clipping.api")

worker = Worker()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    worker.start()
    sfx.start_sync()  # tu galería de sonidos se reimporta sola al añadir archivos a su carpeta
    yield
    worker.stop()


app = FastAPI(title="Clipping Tool", lifespan=lifespan)
app.include_router(moment_eval.router)
app.include_router(subtitles.router)
app.include_router(blocks.router)


@app.middleware("http")
async def log_unhandled_errors(request: Request, call_next):
    """Un 500 sin más no dice nada: se registra la traza en app.log y se devuelve el motivo al dashboard."""
    try:
        return await call_next(request)
    except Exception as exc:
        log.exception("Error interno en %s %s", request.method, request.url.path)
        return JSONResponse({"detail": f"Error interno ({exc.__class__.__name__}): {exc}"}, status_code=500)


@app.middleware("http")
async def llm_request(request: Request, call_next):
    """«Regenerar» (cabecera X-LLM-Fresh: no leer la caché) y avisos de la IA de vuelta al dashboard: si la respuesta salió
    de la caché (X-LLM-Cached) o si Ollama falló y se usó Claude Haiku (X-LLM-Note)."""
    if not request.url.path.startswith("/api/"):
        return await call_next(request)
    state = {"fresh": request.headers.get("x-llm-fresh") == "1", "cached": False, "notes": []}
    token = llm_router.REQUEST.set(state)
    try:
        response = await call_next(request)
    finally:
        llm_router.REQUEST.reset(token)
    if state["cached"]:
        response.headers["X-LLM-Cached"] = "1"
    if state["notes"]:
        response.headers["X-LLM-Note"] = quote(state["notes"][-1])
    return response


# Solo se exponen clips, recursos subidos y sonidos (no la base de datos ni los ajustes).
app.mount("/media/clips", StaticFiles(directory=CLIPS_DIR), name="media")
app.mount("/media/assets", StaticFiles(directory=ASSETS_DIR), name="assets")
app.mount("/media/sfx", StaticFiles(directory=sfx.SFX_DIR), name="sfx")


def _404(what: str):
    raise HTTPException(404, f"{what} no encontrado")


# ---------- Estado y ajustes ----------

@app.get("/api/health")
def health() -> dict:
    settings = load_settings()
    ollama_models: list[str] = []
    ollama_ok = False
    try:
        r = httpx.get(f"{settings.ollama_url.rstrip('/')}/api/tags", timeout=2)
        ollama_ok = r.status_code == 200
        ollama_models = [m["name"] for m in r.json().get("models", [])]
    except Exception:
        pass
    from . import mlrun

    return {
        "ffmpeg": bool(find_exe("ffmpeg")),
        "nvenc": nvenc_available() if find_exe("ffmpeg") else False,
        "node": bool(find_exe("node")),
        "claude_cli": bool(find_exe("claude")),
        "ollama": ollama_ok,
        "ollama_models": ollama_models,
        "ollama_model_ready": settings.ollama_model in ollama_models,
        "ml": mlrun.available(),
    }


@app.get("/api/clip-types")
def get_clip_types() -> dict:
    """Tipos de clip (reglas para la IA) y presets de encuadre de «Nuevo vídeo»."""
    return clip_types.public()


@app.get("/api/llm")
def llm_info() -> dict:
    """Tabla «tarea → modelo» con la recomendación, si Ollama está disponible y el tamaño de la caché."""
    s = load_settings()
    R = llm_router

    def effective(k: str) -> list[str]:
        kind, model, _ = R.resolve(k, s.llm_provider, s)
        return [kind, model, R.effort_for(k, model, s) if kind == "claude" else ""]

    return {
        "provider": s.llm_provider,
        "routes": list(R.ROUTES),
        "models": [{"id": k, "label": m["label"], "price": list(m["price"]), "effort": m["effort"], "why": m["why"]}
                   for k, m in R.MODELS.items()],
        "efforts": [{"id": k, "label": e["label"], "why": e["why"]} for k, e in R.EFFORTS.items()],
        "tasks": [{"id": k, "label": label, "tier": tier, "recommended": R.recommended(k),
                   "recommended_model": R.RECOMMEND.get(k, R.RECOMMEND["general"])[0],
                   "recommended_effort": R.recommended_effort(k), "why": R.RECOMMEND.get(k, R.RECOMMEND["general"])[2],
                   "route": R.migrate_route((s.llm_task_models or {}).get(k, "auto")),
                   "effort": (s.llm_task_effort or {}).get(k, ""),
                   "effective": effective(k)} for k, (label, tier) in R.TASKS.items()],
        "ollama": {"available": llm_router.ollama_available(s), "model": s.ollama_model, "url": s.ollama_url},
        "cache": {"enabled": s.llm_cache, "days": s.llm_cache_days, "size": llm_router.cache_size()},
    }


class LlmTestIn(BaseModel):
    model: str


@app.post("/api/llm/test")
def llm_test(body: LlmTestIn) -> dict:
    """«Probar»: llamada mínima a Claude con ese modelo para saber si tu cuenta lo tiene."""
    if body.model not in llm_router.MODELS:
        raise HTTPException(400, "Modelo desconocido")
    return llm_router.probe(body.model)


@app.get("/api/llm/usage")
def llm_usage(days: int = 7) -> dict:
    return llm_router.usage(max(1, min(90, days)))


@app.delete("/api/llm/cache")
def llm_cache_clear() -> dict:
    return {"removed": llm_router.cache_clear()}


@app.get("/api/settings")
def get_settings() -> Settings:
    return load_settings()


@app.put("/api/settings")
def put_settings(settings: Settings) -> Settings:
    if settings.llm_provider not in ("claude", "ollama"):
        raise HTTPException(400, "Proveedor de IA no válido")
    if any(k not in llm_router.TASKS or v not in llm_router.ROUTES for k, v in settings.llm_task_models.items()):
        raise HTTPException(400, "Tabla de modelos por tarea no válida")
    if any(k not in llm_router.TASKS or v not in llm_router.EFFORTS for k, v in settings.llm_task_effort.items()):
        raise HTTPException(400, "Esfuerzo por tarea no válido")
    if settings.claude_model and settings.claude_model not in llm_router.MODELS:
        settings.claude_model = llm_router.migrate_route(settings.claude_model)
    if not 1 <= settings.llm_cache_days <= 365:
        raise HTTPException(400, "Días de caché entre 1 y 365")
    if settings.master_export not in EXPORT_PRESETS:
        raise HTTPException(400, "Preset de exportación no válido")
    if settings.render_speed not in RENDER_SPEEDS:
        raise HTTPException(400, "Velocidad de render no válida")
    _validate_durations(settings.min_duration, settings.max_duration)
    if not 1 <= settings.clips_per_source <= 20:
        raise HTTPException(400, "Clips por vídeo entre 1 y 20")
    settings.guidance = settings.guidance.strip()[:2000]
    save_settings(settings)
    return settings


def _validate_durations(min_d: float, max_d: float) -> None:
    if not (5 <= min_d < max_d <= 180):
        raise HTTPException(400, "Duraciones no válidas: mínimo ≥ 5 s, máximo ≤ 180 s y mínimo < máximo")


# ---------- Plantillas de subtítulos ----------

class TemplateIn(BaseModel):
    name: str
    font: str = "Montserrat"
    font_size: int = 86
    font_weight: int = 900
    primary_color: str = "#FFFFFF"
    highlight_color: str = "#FFD400"
    highlight_mode: str = "color"
    box_color: str = "#7C3AED"
    outline_color: str = "#000000"
    outline_width: float = 6
    shadow: float = 3
    uppercase: bool = True
    words_per_chunk: int = 3
    margin_v: int = 560
    animation: str = "pop"
    chunk_bg_color: str = ""
    chunk_bg_opacity: float = 0.6
    hook_enabled: bool = True
    hook_font_size: int = 64
    hook_text_color: str = "#000000"
    hook_bg_color: str = "#FFFFFF"
    hook_duration: float = 3.0


HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
# Mantener sincronizado con ANIMATIONS en frontend/src/remotion/Captions.tsx
ANIMATIONS = ("pop", "bounce", "glow", "none", "chunk_fade", "fade_in", "dim", "reveal_up", "blur_in", "typewriter",
              "sweep")


def _validate_template(data: TemplateIn) -> None:
    if not data.name.strip():
        raise HTTPException(400, "La plantilla necesita un nombre")
    for field in ("primary_color", "highlight_color", "box_color", "outline_color", "hook_text_color", "hook_bg_color"):
        if not HEX.match(getattr(data, field)):
            raise HTTPException(400, f"Color no válido en {field}: usa formato #RRGGBB")
    if data.highlight_mode not in ("color", "box", "underline"):
        raise HTTPException(400, "Modo de resaltado no válido")
    if data.animation not in ANIMATIONS:
        raise HTTPException(400, "Animación no válida")
    if data.chunk_bg_color and not HEX.match(data.chunk_bg_color):
        raise HTTPException(400, "Color de la caja no válido: usa formato #RRGGBB o déjalo vacío")
    if not (0 <= data.chunk_bg_opacity <= 1):
        raise HTTPException(400, "La opacidad de la caja va de 0 a 1")


@app.get("/api/templates")
def list_templates() -> list[CaptionTemplate]:
    with Session(engine) as s:
        return list(s.exec(select(CaptionTemplate).order_by(CaptionTemplate.id)).all())


@app.post("/api/templates")
def create_template(data: TemplateIn) -> CaptionTemplate:
    _validate_template(data)
    with Session(engine) as s:
        tpl = CaptionTemplate(**data.model_dump(), pop=data.animation != "none")
        s.add(tpl)
        s.commit()
        s.refresh(tpl)
        return tpl


@app.put("/api/templates/{template_id}")
def update_template(template_id: int, data: TemplateIn) -> CaptionTemplate:
    _validate_template(data)
    with Session(engine) as s:
        tpl = s.get(CaptionTemplate, template_id) or _404("Plantilla")
        for k, v in data.model_dump().items():
            setattr(tpl, k, v)
        tpl.pop = data.animation != "none"
        s.add(tpl)
        s.commit()
        s.refresh(tpl)
        return tpl


@app.delete("/api/templates/{template_id}")
def delete_template(template_id: int) -> dict:
    with Session(engine) as s:
        tpl = s.get(CaptionTemplate, template_id) or _404("Plantilla")
        if len(s.exec(select(CaptionTemplate)).all()) <= 1:
            raise HTTPException(400, "Debe quedar al menos una plantilla")
        s.delete(tpl)
        s.commit()
    settings = load_settings()
    if settings.default_template_id == template_id:
        save_settings(settings.model_copy(update={"default_template_id": None}))
    return {"ok": True}


# ---------- Fuentes (vídeos largos) ----------

LAYOUTS = ("auto", "face", "center", "duo", "gaming", "fit_black", "fit_blur", "fit_color")
ASPECTS = ("9:16", "1:1", "4:5", "16:9")


class SourceOptions(BaseModel):
    permission_note: str
    requested_clips: int | None = None
    llm_provider: str = ""
    layout: str = "auto"
    bg_color: str = "#111111"
    aspect: str = "9:16"
    template_id: int | None = None
    hook_enabled: bool = True
    min_duration: float = 0
    max_duration: float = 0
    instructions: str = ""
    caption_style: dict = {}  # cambios sobre la plantilla (placement, margin_v, font_size, …)
    selection: str = "auto"  # auto (la IA propone clips) o manual (solo transcribe; los marcas tú)
    typology: str = ""  # tipo de clip (clip_types.py)
    max_height: int = 0  # calidad de descarga: 0 = automática según la duración; 1080, 1440 o 2160


class SourceIn(SourceOptions):
    url: str


def _create_source(url: str, opts: SourceOptions) -> Source:
    if not opts.permission_note.strip():
        raise HTTPException(400, "Indica de dónde viene el permiso para usar este vídeo")
    if opts.llm_provider not in ("", "claude", "ollama"):
        raise HTTPException(400, "Proveedor de IA no válido")
    if opts.layout not in LAYOUTS or opts.aspect not in ASPECTS:
        raise HTTPException(400, "Encuadre o formato no válido")
    if opts.selection not in ("auto", "manual"):
        raise HTTPException(400, "Modo de selección no válido")
    if opts.typology and opts.typology not in clip_types.TYPES:
        raise HTTPException(400, "Tipo de clip no válido")
    if opts.max_height not in (0, 720, 1080, 1440, 2160):
        raise HTTPException(400, "Calidad de descarga no válida")
    if opts.min_duration or opts.max_duration:
        _validate_durations(opts.min_duration, opts.max_duration)
    with Session(engine) as s:
        if opts.template_id is not None and not s.get(CaptionTemplate, opts.template_id):
            raise HTTPException(400, "La plantilla no existe")
        data = opts.model_dump(exclude={"url", "requested_clips", "permission_note", "instructions", "caption_style"})
        allowed = set(compose.STYLE_FIELDS) | {"placement", "punctuation"}
        caption_style = {k: v for k, v in opts.caption_style.items() if k in allowed}
        src = Source(url=url.strip(), permission_note=opts.permission_note.strip(),
                     instructions=opts.instructions.strip(), caption_style=json.dumps(caption_style),
                     requested_clips=max(1, min(20, opts.requested_clips or load_settings().clips_per_source)),
                     title=Path(url).stem if download.is_local(url) else "", **data)
        s.add(src)
        s.commit()
        s.refresh(src)
    enqueue("process_source", src.id)
    return src


@app.get("/api/sources")
def list_sources() -> list[dict]:
    with Session(engine) as s:
        sources = s.exec(select(Source).order_by(Source.id.desc())).all()
        clips = s.exec(select(Clip)).all()
    counts: dict[int, dict[str, int]] = {}
    thumbs: dict[int, str] = {}
    for c in sorted(clips, key=lambda c: -c.score):
        counts.setdefault(c.source_id, {}).setdefault(c.status, 0)
        counts[c.source_id][c.status] += 1
        if c.thumb_path and c.source_id not in thumbs:
            thumbs[c.source_id] = f"/media/{c.thumb_path}?v={c.version}"
    return [{**src.model_dump(), "clip_counts": counts.get(src.id, {}), "thumb_url": thumbs.get(src.id, "")}
            for src in sources]


@app.get("/api/sources/{source_id}")
def get_source(source_id: int) -> dict:
    with Session(engine) as s:
        src = s.get(Source, source_id) or _404("Vídeo")
        clips = s.exec(select(Clip).where(Clip.source_id == source_id)).all()
    counts: dict[str, int] = {}
    for c in clips:
        counts[c.status] = counts.get(c.status, 0) + 1
    return {**src.model_dump(), "clip_counts": counts, "thumb_url": ""}


@app.post("/api/sources")
def create_source(data: SourceIn) -> Source:
    url = data.url.strip()
    if not (url.startswith(("http://", "https://")) or download.is_local(url)):
        raise HTTPException(400, "Pega una URL (http/https) o la ruta de un archivo de vídeo que exista")
    return _create_source(url, data)


@app.post("/api/sources/upload")
async def upload_source(file: UploadFile = File(...), options: str = Form(...)) -> Source:
    opts = SourceOptions.model_validate_json(options)
    name = re.sub(r"[^\w.\- ]", "_", Path(file.filename or "video.mp4").name)
    dest = UPLOADS_DIR / name
    n = 1
    while dest.exists():
        dest = UPLOADS_DIR / f"{Path(name).stem}_{n}{Path(name).suffix}"
        n += 1
    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)
    return _create_source(str(dest), opts)


@app.get("/api/sources/{source_id}/video")
def source_video(source_id: int) -> FileResponse:
    """Vídeo original para el editor y el renderer (admite peticiones por rangos)."""
    with Session(engine) as s:
        src = s.get(Source, source_id) or _404("Vídeo")
    if not src.video_path or not Path(src.video_path).exists():
        raise HTTPException(404, "El vídeo original ya no está disponible")
    return FileResponse(src.video_path, media_type="video/mp4")


def _busy(s: Session, kind: str, ref_id: int) -> bool:
    return s.exec(select(Job).where(Job.kind == kind, Job.ref_id == ref_id,
                                    Job.status.in_(["queued", "running"]))).first() is not None


@app.post("/api/sources/{source_id}/retry")
def retry_source(source_id: int) -> dict:
    with Session(engine) as s:
        src = s.get(Source, source_id) or _404("Vídeo")
        if _busy(s, "process_source", source_id):
            raise HTTPException(400, "El vídeo ya se está procesando")
        src.status, src.error, src.progress, src.stage_detail = "queued", "", 0, ""
        touch(src)
        s.add(src)
        s.commit()
    enqueue("process_source", source_id)
    return {"ok": True}


@app.delete("/api/sources/{source_id}")
def delete_source(source_id: int) -> dict:
    with Session(engine) as s:
        src = s.get(Source, source_id) or _404("Vídeo")
        if _busy(s, "process_source", source_id):
            raise HTTPException(400, "No se puede borrar mientras se procesa")
        for clip in s.exec(select(Clip).where(Clip.source_id == source_id)).all():
            shutil.rmtree(CLIPS_DIR / str(clip.id), ignore_errors=True)
            s.delete(clip)
        s.delete(src)
        s.commit()
    # Solo se borra lo que la herramienta descargó; los archivos locales del usuario no se tocan.
    shutil.rmtree(SOURCES_DIR / str(source_id), ignore_errors=True)
    return {"ok": True}


# ---------- Marcado manual ----------

@app.get("/api/sources/{source_id}/transcript")
def source_transcript(source_id: int) -> dict:
    with Session(engine) as s:
        src = s.get(Source, source_id) or _404("Vídeo")
        clips = s.exec(select(Clip).where(Clip.source_id == source_id).order_by(Clip.start)).all()
    if not src.transcript_path or not Path(src.transcript_path).exists():
        raise HTTPException(400, "Este vídeo aún no está transcrito")
    data = json.loads(Path(src.transcript_path).read_text(encoding="utf-8"))
    return {"source": {"id": src.id, "title": src.title or src.url, "duration": src.duration, "width": src.width,
                       "height": src.height, "status": src.status, "video_url": f"/api/sources/{src.id}/video"},
            "segments": data["segments"], "words": data["words"],
            "clips": [{"id": c.id, "start": c.start, "end": c.end, "title": c.title, "score": c.score,
                       "origin": c.origin, "status": c.status} for c in clips]}


@app.get("/api/sources/{source_id}/peaks")
def source_peaks(source_id: int) -> dict:
    """Forma de onda del vídeo completo (máximo por cada 0,1 s, de 0 a 255). Se calcula una vez y se guarda."""
    with Session(engine) as s:
        src = s.get(Source, source_id) or _404("Vídeo")
    if not src.video_path or not Path(src.video_path).exists():
        raise HTTPException(404, "El vídeo original ya no está disponible")
    # En la carpeta de la herramienta, nunca junto al vídeo: si es un archivo local tuyo, no se toca su carpeta.
    data = timeline.peaks(Path(src.video_path), SOURCES_DIR / str(source_id) / "peaks.json")
    # Puntos calientes de YouTube («Más reproducido»), si los hay.
    return {**data, "heat": heatmap.ensure(SOURCES_DIR / str(source_id) / heatmap.FILE, src.url or "")}


@app.get("/api/sources/{source_id}/filmstrip")
def source_filmstrip(source_id: int, start: float = 0, end: float = 0) -> dict:
    """Miniaturas de un tramo del original en una sola imagen (rejilla), para la línea de tiempo del editor."""
    with Session(engine) as s:
        src = s.get(Source, source_id) or _404("Vídeo")
    if not src.video_path or not Path(src.video_path).exists():
        raise HTTPException(404, "El vídeo original ya no está disponible")
    return timeline.filmstrip(Path(src.video_path), SOURCES_DIR / str(source_id), start, end, src.duration,
                              src.width, src.height, lambda name: f"/api/sources/{source_id}/filmstrip/{name}")


@app.get("/api/sources/{source_id}/filmstrip/{name}")
def source_filmstrip_image(source_id: int, name: str) -> FileResponse:
    if not re.fullmatch(r"filmstrip_\d+_\d+\.jpg", name):
        raise HTTPException(404, "No existe")
    path = SOURCES_DIR / str(source_id) / name
    if not path.exists():
        raise HTTPException(404, "No existe")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


class Mark(BaseModel):
    start: float
    end: float
    title: str = ""


class MarksIn(BaseModel):
    marks: list[Mark]
    snap: bool = True


@app.post("/api/sources/{source_id}/marks")
def create_marks(source_id: int, data: MarksIn) -> dict:
    """Crea clips con los tramos marcados a mano. La IA los puntúa y después se renderizan."""
    if not data.marks:
        raise HTTPException(400, "Marca al menos un clip")
    with Session(engine) as s:
        src = s.get(Source, source_id) or _404("Vídeo")
        if not src.transcript_path or not Path(src.transcript_path).exists():
            raise HTTPException(400, "Este vídeo aún no está transcrito")
        words = json.loads(Path(src.transcript_path).read_text(encoding="utf-8"))["words"]
        template_id = template_for(src)
        ids = []
        for m in data.marks:
            if not (0 <= m.start < m.end <= (src.duration or m.end) + 0.5):
                raise HTTPException(400, f"Tramo fuera del vídeo: {m.start:.1f}–{m.end:.1f} s")
            start, end = (moments.snap_to_words(m.start, m.end, words, src.duration) if data.snap
                          else (round(m.start, 3), round(m.end, 3)))
            if not (3 <= end - start <= 180):
                raise HTTPException(400, f"Cada clip debe durar entre 3 s y 3 min ({end - start:.0f} s)")
            clip = Clip(source_id=source_id, start=start, end=end, title=m.title.strip()[:100], origin="manual",
                        status="scoring", template_id=template_id)
            s.add(clip)
            s.flush()
            ids.append(clip.id)
        s.commit()
    enqueue("manual_clips", source_id)
    return {"ok": True, "clip_ids": ids}


# ---------- Clips ----------

def _clip_out(c: Clip, full: bool = False) -> dict:
    d = c.model_dump(exclude={"composition", "quality"})
    d["tags"] = json.loads(c.tags or "[]")
    d["breakdown"] = json.loads(c.breakdown) if c.breakdown else None
    q = json.loads(c.quality) if c.quality else None
    d["quality"] = ({k: q[k] for k in ("score", "verdict", "counts", "version")} if q and not full else q)
    comp = json.loads(c.composition) if c.composition else None
    d["duration"] = round(compose.composition_duration(comp) if comp else c.end - c.start, 2)
    d["aspect"] = comp.get("aspect", "") if comp else ""
    # Hay texto para exportar como SRT/VTT (aunque los subtítulos no se quemen en el vídeo)
    d["has_captions"] = bool(comp and any(str(w.get("w", "")).strip() for w in (comp.get("captions") or {}).get("words") or []))
    d["video_url"] = f"/media/{c.video_path}?v={c.version}" if c.video_path else ""
    d["thumb_url"] = f"/media/{c.thumb_path}?v={c.version}" if c.thumb_path else ""
    if full:
        d["composition"] = comp
    return d


@app.get("/api/clips")
def list_clips(status: str | None = None, source_id: int | None = None) -> list[dict]:
    with Session(engine) as s:
        q = select(Clip)
        if status:
            q = q.where(Clip.status.in_(status.split(",")))
        if source_id:
            q = q.where(Clip.source_id == source_id)
        clips = s.exec(q.order_by(Clip.score.desc(), Clip.id.desc())).all()
        titles = {src.id: src.title or src.url for src in s.exec(select(Source)).all()}
    return [{**_clip_out(c), "source_title": titles.get(c.source_id, "")} for c in clips]


@app.get("/api/clips/{clip_id}")
def get_clip(clip_id: int) -> dict:
    with Session(engine) as s:
        clip = s.get(Clip, clip_id) or _404("Clip")
        src = s.get(Source, clip.source_id) if clip.source_id else None
        out = _clip_out(clip, full=True)
        out["source"] = {"id": src.id, "title": src.title, "duration": src.duration, "width": src.width,
                         "height": src.height, "video_url": compose.source_video_url(src.id)} if src else None
    if src is None:
        out["source_words"] = []
        return out
    try:
        words = json.loads(Path(src.transcript_path).read_text(encoding="utf-8"))["words"]
        # Transcripción con margen: el editor permite alargar el clip hacia atrás o hacia delante.
        out["source_words"] = [w for w in words if clip.start - 90 <= w["s"] <= clip.end + 90]
    except Exception:
        out["source_words"] = []
    return out


class ClipPatch(BaseModel):
    title: str | None = None
    status: str | None = None


@app.patch("/api/clips/{clip_id}")
def patch_clip(clip_id: int, data: ClipPatch) -> dict:
    with Session(engine) as s:
        clip = s.get(Clip, clip_id) or _404("Clip")
        if data.title is not None:
            clip.title = data.title.strip()[:100]
        if data.status is not None:
            if data.status not in ("review", "approved", "rejected"):
                raise HTTPException(400, "Estado no válido")
            if clip.status in ("queued", "rendering", "scoring"):
                raise HTTPException(400, "Espera a que termine el render")
            clip.status = data.status
        touch(clip)
        s.add(clip)
        s.commit()
        s.refresh(clip)
        return _clip_out(clip)


@app.delete("/api/clips/{clip_id}")
def delete_clip(clip_id: int) -> dict:
    with Session(engine) as s:
        clip = s.get(Clip, clip_id) or _404("Clip")
        if _busy(s, "render_clip", clip_id):
            raise HTTPException(400, "No se puede borrar mientras se renderiza")
        s.delete(clip)
        s.commit()
    shutil.rmtree(CLIPS_DIR / str(clip_id), ignore_errors=True)
    return {"ok": True}


class CompositionIn(BaseModel):
    composition: dict
    title: str | None = None
    hook: str | None = None


def _validate_composition(c: dict, source_duration: float) -> None:
    segs = c.get("segments") or []
    if c.get("aspect") not in ASPECTS:
        raise HTTPException(400, "Formato no válido")
    if not segs:
        raise HTTPException(400, "La composición está vacía: deja al menos un tramo")
    for seg in segs:
        if not (0 <= seg["src_in"] < seg["src_out"] <= (source_duration or seg["src_out"]) + 0.5):
            raise HTTPException(400, "Hay un tramo con un corte fuera del vídeo original")
    total = compose.composition_duration(c)
    if total > 180 and c.get("aspect") != "16:9":
        raise HTTPException(400, f"El vídeo dura {total:.0f} s: un Short no puede pasar de 3 minutos")


class RegenIn(BaseModel):
    composition: dict


@app.post("/api/clips/{clip_id}/captions/regenerate")
def regenerate_captions(clip_id: int, data: RegenIn) -> dict:
    """Las palabras de los subtítulos, releídas de la transcripción para los tramos que tiene ahora el editor."""
    with Session(engine) as s:
        s.get(Clip, clip_id) or _404("Clip")

    def load(source_id: int):
        with Session(engine) as s:
            src = s.get(Source, source_id)
        path = Path(src.transcript_path) if src and src.transcript_path else None
        return json.loads(path.read_text(encoding="utf-8"))["words"] if path and path.exists() else None

    try:
        return {"words": compose.regenerate_words(data.composition, load)}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/clips/{clip_id}/captions/punctuate")
def punctuate_captions(clip_id: int, data: RegenIn) -> dict:
    """Pone los signos que Whisper no puso (tramos largos sin puntos ni comas) con un modelo barato. Solo cambia
    signos y mayúsculas. También arregla la transcripción del original, para que «Regenerar subtítulos» y los clips
    nuevos de ese vídeo salgan ya puntuados."""
    from . import punctuation
    from .llm import get_provider

    with Session(engine) as s:
        clip = s.get(Clip, clip_id) or _404("Clip")
        src = s.get(Source, clip.source_id) if clip.source_id else None
    cap = data.composition.get("captions") or {}
    words = cap.get("words") or []
    if not punctuation.missing_runs(words):
        return {"words": words, "changed": 0}
    settings = load_settings()
    lang = (src.language if src else "") or settings.language
    fixed, changed = punctuation.restore(words, get_provider("", settings, task="punctuation"), lang)
    path = Path(src.transcript_path) if src and src.transcript_path else None
    if changed and path and path.exists() and cap.get("time_base") == "source":
        try:  # mismas palabras del original (por tiempo de inicio) → mismo texto puntuado
            tr = json.loads(path.read_text(encoding="utf-8"))
            mine = f"/api/sources/{src.id}/video"
            by_s = {round(w["s"], 2): w["w"] for w in fixed if not w.get("src") or mine in w["src"]}
            n = 0
            for w in tr.get("words", []):
                new = by_s.get(round(w["s"], 2))
                if new and new != w["w"] and punctuation.norm(new) == punctuation.norm(w["w"]):
                    w["w"], n = new, n + 1
            if n:
                path.write_text(json.dumps(tr, ensure_ascii=False), encoding="utf-8")
        except (OSError, ValueError, KeyError):
            log.warning("No se pudo actualizar la transcripción del original", exc_info=True)
    return {"words": fixed, "changed": changed}


WORD_PRESETS = DATA_DIR / "caption_word_presets.json"
WORD_STYLE_KEYS = {"color", "weight", "scale", "font", "italic", "anim", "out"}


def _word_presets() -> list[dict]:
    try:
        return json.loads(WORD_PRESETS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


class WordPresetIn(BaseModel):
    name: str
    style: dict


@app.get("/api/caption-word-presets")
def list_word_presets() -> list[dict]:
    """Estilos de palabra guardados: color, peso, tamaño, fuente, entrada y salida, para reusarlos en cualquier clip."""
    return _word_presets()


@app.post("/api/caption-word-presets")
def save_word_preset(data: WordPresetIn) -> list[dict]:
    name = data.name.strip()[:40]
    if not name:
        raise HTTPException(400, "Ponle un nombre al preset")
    style = {k: v for k, v in data.style.items() if k in WORD_STYLE_KEYS and v not in (None, "")}
    items = [p for p in _word_presets() if p["name"] != name] + [{"name": name, "style": style}]
    WORD_PRESETS.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    return items


@app.delete("/api/caption-word-presets/{name}")
def delete_word_preset(name: str) -> list[dict]:
    items = [p for p in _word_presets() if p["name"] != name]
    WORD_PRESETS.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    return items


@app.put("/api/clips/{clip_id}/composition")
def save_composition(clip_id: int, data: CompositionIn) -> dict:
    with Session(engine) as s:
        clip = s.get(Clip, clip_id) or _404("Clip")
        src = s.get(Source, clip.source_id) if clip.source_id else None
        if _busy(s, "render_clip", clip_id):
            raise HTTPException(400, "El clip ya se está renderizando")
        _validate_composition(data.composition, src.duration if src else 0)
        clip.composition = json.dumps(data.composition)
        if data.title is not None:
            clip.title = data.title.strip()[:100]
        if data.hook is not None:
            clip.hook = data.hook.strip()
        clip.status = "queued"
        touch(clip)
        s.add(clip)
        s.commit()
    enqueue("render_clip", clip_id)
    return {"ok": True}


@app.post("/api/clips/{clip_id}/render")
def rerender_clip(clip_id: int, reset: bool = False) -> dict:
    """Vuelve a renderizar. Con reset=true descarta las ediciones y regenera la composición automática."""
    with Session(engine) as s:
        clip = s.get(Clip, clip_id) or _404("Clip")
        if _busy(s, "render_clip", clip_id):
            raise HTTPException(400, "El clip ya se está renderizando")
        if reset:
            clip.composition = ""
        clip.status = "queued"
        touch(clip)
        s.add(clip)
        s.commit()
    enqueue("render_clip", clip_id)
    return {"ok": True}


@app.post("/api/clips/{clip_id}/quality")
def check_quality(clip_id: int) -> dict:
    """Vuelve a pasar los filtros de calidad al último render (y a la composición guardada)."""
    with Session(engine) as s:
        clip = s.get(Clip, clip_id) or _404("Clip")
        if not clip.composition:
            raise HTTPException(400, "El clip todavía no tiene composición")
        comp, video, version = json.loads(clip.composition), clip.video_path, clip.version
    report = quality.report_json(comp, DATA_DIR / video if video else None, version)
    if not report:
        raise HTTPException(500, "Los filtros de calidad fallaron; mira app.log")
    with Session(engine) as s:
        clip = s.get(Clip, clip_id)
        clip.quality = report
        s.add(clip)
        s.commit()
    return json.loads(report)


class PlanCheckIn(BaseModel):
    composition: dict


@app.post("/api/quality/plan")
def plan_quality(data: PlanCheckIn) -> dict:
    """Revisión rápida de una composición sin renderizar (el editor la usa con los cambios sin guardar)."""
    plan = quality.plan_check(data.composition)
    return quality.summarize(plan["issues"], plan["metrics"], rendered=False, sheet="", version=0,
                             opening=plan["opening"])


class FxAutoIn(BaseModel):
    composition: dict
    tool: str = "clip"
    only: list[str] = []  # opcional: limitar a speaker_zoom, punch_in, numbers, stickers, transitions, camera


@app.post("/api/fx/auto")
def fx_auto(data: FxAutoIn) -> dict:
    """Vuelve a colocar los efectos automáticos (sustituye solo los «auto_…») con los ajustes actuales."""
    opts = fxauto.options(load_settings())
    if data.only:
        opts = fxauto.Options(**{k: (v if k in data.only else ("none" if k == "transitions" else False))
                                 for k, v in vars(opts).items()})
    out = fxauto.decorate(data.composition, opts, data.tool or "clip")
    return {"composition": out, "summary": fxauto.summary(data.composition, out)}


OUT_SIZE = {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "16:9": (1920, 1080)}


def _clip_video(clip_id: int, src_url: str = "") -> tuple[Path, int, int]:
    """Vídeo original de un clip (o el de un tramo con otro vídeo) y su tamaño."""
    with Session(engine) as s:
        clip = s.get(Clip, clip_id) or _404("Clip")
        src = s.get(Source, clip.source_id) if clip.source_id else None
    if src is not None and not src_url:
        return Path(src.video_path), src.width, src.height
    video = editor_agent._media_path(src_url) if src_url else None
    if not video or not video.exists():
        raise HTTPException(400, "Este tramo no tiene vídeo original")
    info = probe(video)
    return video, info["width"], info["height"]


class AutoframeIn(BaseModel):
    src_in: float
    src_out: float
    mode: str = "face"  # face, duo, gaming · speaker (sigue a quien habla), cuts (solo los cortes del original)
    aspect: str = "9:16"
    src: str = ""  # vídeo del tramo si no es el original del clip


@app.post("/api/clips/{clip_id}/autoframe")
def autoframe(clip_id: int, data: AutoframeIn) -> dict:
    """Calcula puntos clave de encuadre siguiendo la cara para un tramo (tarda unos segundos)."""
    video, width, height = _clip_video(clip_id, data.src)
    if not (0 <= data.src_in < data.src_out):
        raise HTTPException(400, "Tramo no válido")
    if data.mode not in ("face", "duo", "gaming", "speaker", "cuts") or data.aspect not in ASPECTS:
        raise HTTPException(400, "Modo o formato no válido")
    out_w, out_h = OUT_SIZE[data.aspect]
    # Los cortes, transiciones y zooms del original van siempre (se marcan en la pista «Cámara»)
    cuts = camera.safe_source_cuts(video, data.src_in, data.src_out)
    rel = [c["t"] for c in cuts]
    source_cuts = camera.absolute(cuts, data.src_in)
    if data.mode == "cuts":
        return {"mode": "cuts", "keys": [], "panels": None, "note": "", "parts": None, "face_ratio": 0,
                "source_cuts": source_cuts}
    if data.mode == "speaker":
        try:
            plan = camera.follow_speaker(video, data.src_in, data.src_out, width, height, rel, out_w, out_h)
        except RuntimeError as exc:
            raise HTTPException(400, str(exc))
        if not plan:
            return {"mode": "fit", "keys": [], "panels": None, "note": "No se han encontrado caras en este tramo",
                    "parts": None, "face_ratio": 0, "source_cuts": source_cuts}
        return {"mode": "speaker", "keys": plan["keys"], "panels": None, "note": plan["note"], "parts": None,
                "face_ratio": 1, "speakers": plan["speakers"], "how": plan.get("how", ""), "source_cuts": source_cuts}
    plan = reframe.analyze(video, data.src_in, data.src_out, width, height, data.mode, out_w, out_h, cuts=rel)
    return {"mode": plan["mode"], "keys": plan["keys"], "panels": plan.get("panels"), "note": plan.get("note", ""),
            "parts": plan.get("parts"), "face_ratio": plan.get("face_ratio", 0), "source_cuts": source_cuts}


class TrackPointIn(BaseModel):
    src_in: float
    src_out: float
    t: float  # segundo del tramo (desde src_in) en el que se marca el punto
    x: float
    y: float
    aspect: str = "9:16"
    zoom: float = 1.0
    margin: float = 0.25
    smooth: float = 0.5
    src: str = ""


@app.post("/api/clips/{clip_id}/track-point")
def track_point(clip_id: int, data: TrackPointIn) -> dict:
    """Sigue lo que hay en (x, y) desde el segundo t hasta el final del tramo y devuelve puntos clave de encuadre."""
    from .pipeline import track

    video, width, height = _clip_video(clip_id, data.src)
    start = data.src_in + max(0.0, data.t)
    if not (0 <= data.src_in <= start < data.src_out - 0.2) or not (0 <= data.x <= 1 and 0 <= data.y <= 1):
        raise HTTPException(400, "Punto o tramo no válido")
    if data.aspect not in ASPECTS:
        raise HTTPException(400, "Formato no válido")
    out_w, out_h = OUT_SIZE[data.aspect]
    try:
        path = track.track_point(video, start, min(data.src_out, start + 60), (data.x, data.y))
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))
    return track.follow_keys(path, round(start - data.src_in, 3), width, height, out_w, out_h,
                             zoom=data.zoom, margin=data.margin, smooth=data.smooth)


class VoiceIn(BaseModel):
    src: str
    level: str = "light"


@app.post("/api/clips/{clip_id}/enhance-voice")
def enhance_voice(clip_id: int, data: VoiceIn) -> dict:
    """Sonido del archivo de un tramo con la voz limpia (RNNoise local). El editor lo pone en `Segment.voice`."""
    from .pipeline import voice

    with Session(engine) as s:
        s.get(Clip, clip_id) or _404("Clip")
    path = editor_agent._media_path(data.src)
    if not path:
        raise HTTPException(400, "No encuentro el vídeo de ese tramo")
    try:
        return {"src": voice.enhance(path, clip_id, data.level), "level": data.level}
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))


class MatteIn(BaseModel):
    composition: dict
    at: float
    query: str = "person"


@app.post("/api/clips/{clip_id}/matte")
def make_matte(clip_id: int, data: MatteIn) -> dict:
    """Rotoscopia: recorta el sujeto del plano que se ve en `at` con SAM 2 (tarda ~1 min por cada 10 s)."""
    with Session(engine) as s:
        s.get(Clip, clip_id) or _404("Clip")
    try:
        return cutout.make_matte(clip_id, data.composition, data.at, data.query)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))


class TrackLayerIn(BaseModel):
    composition: dict
    start: float
    end: float
    mode: str = "face"  # face | point
    x: float = 0.5
    y: float = 0.5


@app.post("/api/clips/{clip_id}/track")
def track_layer(clip_id: int, data: TrackLayerIn) -> dict:
    """Recorrido para que una capa siga una cara o un punto del vídeo."""
    with Session(engine) as s:
        s.get(Clip, clip_id) or _404("Clip")
    if data.mode not in ("face", "point") or not (0 <= data.start < data.end):
        raise HTTPException(400, "Seguimiento no válido")
    try:
        return {"follow": cutout.track(data.composition, data.start, data.end, data.mode, data.x, data.y)}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


class AgentIn(BaseModel):
    composition: dict
    message: str
    history: list[dict] = []
    playhead: float = 0
    selection: str = ""


@app.post("/api/clips/{clip_id}/agent")
def agent(clip_id: int, data: AgentIn) -> dict:
    """Chat del editor: devuelve la composición cambiada (sin guardarla) y la respuesta de la IA."""
    if not data.message.strip():
        raise HTTPException(400, "Escribe qué quieres cambiar")
    with Session(engine) as s:
        s.get(Clip, clip_id) or _404("Clip")
    try:
        return editor_agent.run_agent(clip_id, data.composition, data.message.strip()[:2000], data.history,
                                      data.playhead, data.selection)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))


@app.get("/api/clips/{clip_id}/download")
def download_clip(clip_id: int) -> FileResponse:
    with Session(engine) as s:
        clip = s.get(Clip, clip_id) or _404("Clip")
    if not clip.video_path:
        raise HTTPException(404, "El clip aún no está renderizado")
    slug = re.sub(r"[^\w\-]+", "_", clip.title or f"clip_{clip_id}").strip("_")[:60] or f"clip_{clip_id}"
    return FileResponse(DATA_DIR / clip.video_path, media_type="video/mp4", filename=f"{slug}.mp4")


# ---------- Recursos (imágenes, vídeos y música para las capas) ----------

ASSET_EXT = {".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
             ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio",
             ".mp4": "video", ".webm": "video", ".mov": "video"}


@app.get("/api/assets")
def list_assets() -> list[dict]:
    out = []
    for f in sorted(ASSETS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        kind = ASSET_EXT.get(f.suffix.lower())
        if kind:
            out.append({"name": f.name, "kind": kind, "url": f"/media/assets/{f.name}"})
    return out


@app.post("/api/assets")
async def upload_asset(file: UploadFile = File(...)) -> dict:
    name = re.sub(r"[^\w.\-]", "_", Path(file.filename or "recurso").name)
    if Path(name).suffix.lower() not in ASSET_EXT:
        raise HTTPException(400, "Formato no admitido: usa PNG, JPG, WEBP, GIF, MP3, WAV, M4A, OGG, MP4, WEBM o MOV")
    dest = ASSETS_DIR / name
    n = 1
    while dest.exists():
        dest = ASSETS_DIR / f"{Path(name).stem}_{n}{Path(name).suffix}"
        n += 1
    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)
    return {"name": dest.name, "kind": ASSET_EXT[dest.suffix.lower()], "url": f"/media/assets/{dest.name}"}


@app.delete("/api/assets/{name}")
def delete_asset(name: str) -> dict:
    path = ASSETS_DIR / Path(name).name
    if not path.exists():
        _404("Recurso")
    path.unlink()
    return {"ok": True}


# ---------- Sonidos (efectos para el editor) ----------

@app.get("/api/sfx")
def list_sfx() -> dict:
    return {"items": sfx.catalog(), "folders": sfx.folders(),
            "intents": {k: v[0] for k, v in sfx.INTENTS.items()},
            "gallery": {**sfx.pack_summary(), "dir": load_settings().sfx_pack_dir}}


class SfxFindIn(BaseModel):
    request: str
    intent: str = ""
    duration: float = 0


@app.post("/api/sfx/find")
def find_sfx(data: SfxFindIn) -> dict:
    """Un sonido pedido con palabras: de la biblioteca o, si es simple, sintetizado al momento."""
    if not data.request.strip():
        raise HTTPException(400, "Describe el sonido")
    return sfx.find_or_make(data.request, data.intent, data.duration)


class PackImportIn(BaseModel):
    dir: str = ""


@app.post("/api/sfx/gallery")
def import_gallery(data: PackImportIn) -> dict:
    """Importa (o vuelve a importar) tu galería de sonidos; la carpeta queda guardada en Ajustes."""
    settings = load_settings()
    folder = (data.dir or settings.sfx_pack_dir).strip().strip('"')
    if not folder:
        raise HTTPException(400, "Escribe la ruta de la carpeta de tus sonidos")
    try:
        result = sfx.import_pack(Path(folder))
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))
    if folder != settings.sfx_pack_dir:
        save_settings(settings.model_copy(update={"sfx_pack_dir": folder}))
    return {**result, "gallery": {**sfx.pack_summary(), "dir": folder}}


@app.post("/api/sfx")
async def upload_sfx(file: UploadFile = File(...), name: str = Form(...), category: str = Form("Propios"),
                     license: str = Form(...)) -> dict:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in sfx.AUDIO_EXT:
        raise HTTPException(400, "Formato no admitido: usa WAV, OGG, MP3 o M4A")
    if not license.strip():
        raise HTTPException(400, "Indica la licencia del sonido (por ejemplo «CC0, freesound.org/…» o «comprado en…»)")
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
    try:
        return sfx.add_file(Path(tmp.name), name, category, license)
    finally:
        Path(tmp.name).unlink(missing_ok=True)


@app.delete("/api/sfx/{sid}")
def delete_sfx(sid: str) -> dict:
    try:
        sfx.delete(sid)
    except KeyError:
        _404("Sonido")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


@app.post("/api/sfx/import")
async def import_bundle(file: UploadFile | None = File(None), dir: str = Form(""), category: str = Form(""),
                        license: str = Form("")) -> dict:
    """Paquete de sonidos (.zip subido o carpeta de tu PC), p. ej. los CC0 de Kenney descargados a mano."""
    tmp = None
    try:
        if file is not None and file.filename:
            if not file.filename.lower().endswith(".zip"):
                raise HTTPException(400, "Sube un .zip (o escribe la ruta de una carpeta)")
            with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as t:
                shutil.copyfileobj(file.file, t)
            tmp = Path(t.name)
            src, label = tmp, Path(file.filename).stem
        elif dir.strip():
            src, label = Path(dir.strip().strip('"')), ""
        else:
            raise HTTPException(400, "Elige un .zip o escribe la ruta de una carpeta")
        return sfx.import_bundle(src, category, license, label)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        raise HTTPException(400, str(exc))
    except zipfile.BadZipFile:
        raise HTTPException(400, "El .zip está dañado o no es un .zip")
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)


class SoundEditIn(BaseModel):
    name: str | None = None
    category: str | None = None
    intents: list[str] | None = None
    reset: bool = False


@app.patch("/api/sfx/{sid}")
def edit_sfx(sid: str, data: SoundEditIn) -> dict:
    try:
        return sfx.reset_sound(sid) if data.reset else sfx.edit_sound(sid, data.name, data.category, data.intents)
    except KeyError:
        _404("Sonido")
    except ValueError as exc:
        raise HTTPException(400, str(exc))


class FolderEditIn(BaseModel):
    category: str
    rename: str | None = None
    intents: list[str] | None = None
    ai: bool | None = None


@app.patch("/api/sfx-folders")
def edit_sfx_folder(data: FolderEditIn) -> dict:
    try:
        return sfx.edit_folder(data.category, data.rename, data.intents, data.ai)
    except KeyError:
        _404("Carpeta")


# ---------- Exportación ----------

@app.get("/api/export-presets")
def export_presets() -> dict:
    return {k: {"label": v["label"], "options": v["options"].model_dump()} for k, v in EXPORT_PRESETS.items()}


class ExportIn(BaseModel):
    clip_ids: list[int]
    options: ExportOptions


@app.post("/api/exports")
def create_export(data: ExportIn) -> Export:
    if not data.clip_ids:
        raise HTTPException(400, "Elige al menos un clip")
    o = data.options
    if o.aspect not in ("",) + ASPECTS or o.short_side not in (720, 1080, 1440, 2160) or o.fps not in (24, 25, 30, 50, 60):
        raise HTTPException(400, "Opciones de exportación no válidas")
    if o.codec not in ("h264", "h265") or not (12 <= o.crf <= 35) or not (-30 <= o.loudness <= 0):
        raise HTTPException(400, "Códec, calidad o volumen fuera de rango")
    with Session(engine) as s:
        exp = Export(clip_ids=json.dumps(data.clip_ids), options=o.model_dump_json())
        s.add(exp)
        s.commit()
        s.refresh(exp)
    enqueue("export", exp.id)
    return exp


@app.get("/api/exports")
def list_exports() -> list[Export]:
    with Session(engine) as s:
        return list(s.exec(select(Export).order_by(Export.id.desc()).limit(30)).all())


@app.get("/api/exports/{export_id}/download")
def download_export(export_id: int) -> FileResponse:
    with Session(engine) as s:
        exp = s.get(Export, export_id) or _404("Exportación")
    if exp.status != "done" or not exp.path:
        raise HTTPException(400, "La exportación aún no ha terminado")
    path = DATA_DIR / exp.path
    return FileResponse(path, media_type="application/zip", filename=path.name)


@app.post("/api/exports/{export_id}/open")
def open_export(export_id: int) -> dict:
    """Abre la carpeta de la exportación en el explorador de archivos."""
    with Session(engine) as s:
        exp = s.get(Export, export_id) or _404("Exportación")
    path = DATA_DIR / exp.path if exp.path else None
    if exp.status != "done" or not path or not path.exists():
        raise HTTPException(400, "La exportación aún no ha terminado")
    folder = path.with_suffix("") if path.with_suffix("").is_dir() else path.parent
    if sys.platform == "win32":
        os.startfile(folder)  # noqa: S606 — carpeta propia de la herramienta
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(folder)])
    return {"ok": True, "path": str(folder)}


# ---------- Cola de trabajos ----------

JOB_LABELS = {
    "process_source": "Procesar vídeo", "render_clip": "Render de clip", "export": "Exportar",
    "manual_clips": "Clips marcados a mano", "moments_benchmark": "Probar a la IA con tus clips",
}


def _job_row(s: Session, job: Job) -> dict:
    handler = jobqueue.HANDLERS.get(job.kind)
    obj = s.get(handler[1], job.ref_id) if handler else None
    title = ""
    for attr in ("title", "name", "url"):
        if obj is not None and getattr(obj, attr, ""):
            title = str(getattr(obj, attr))[:120]
            break
    link = {"render_clip": f"#/editor?clip={job.ref_id}", "process_source": f"#/video?id={job.ref_id}",
            "manual_clips": f"#/video?id={job.ref_id}", "moments_benchmark": f"#/video?id={job.ref_id}",
            "export": "#/exportar"}.get(job.kind, "")
    return {"id": job.id, "kind": job.kind, "label": JOB_LABELS.get(job.kind, job.kind.replace("_", " ")),
            "ref_id": job.ref_id, "title": title, "status": job.status, "error": job.error, "link": link,
            "progress": float(getattr(obj, "progress", 0) or 0) if job.status == "running" else 0,
            "stage": (getattr(obj, "stage_detail", "") or getattr(obj, "detail", "") or "") if job.status == "running" else "",
            "created_at": job.created_at, "started_at": job.started_at, "finished_at": job.finished_at,
            "stopping": job.status == "running" and jobctl.stopping(job.id)}


@app.get("/api/jobs/queue")
def job_queue(recent: int = 15) -> dict:
    """Cola de trabajos: el que está en marcha, los que esperan (en su orden) y los últimos terminados."""
    with Session(engine) as s:
        running = s.exec(select(Job).where(Job.status == "running")).all()
        queued = s.exec(select(Job).where(Job.status == "queued").order_by(Job.rank, Job.id)).all()
        done = s.exec(select(Job).where(Job.status.in_(["done", "error", "cancelled"]))
                      .order_by(Job.finished_at.desc()).limit(recent)).all()
        return {"paused": jobqueue.is_paused(), "running": [_job_row(s, j) for j in running],
                "queued": [_job_row(s, j) for j in queued], "recent": [_job_row(s, j) for j in done]}


def _job_typical(s: Session, kind: str) -> float | None:
    """Lo que suele durar un trabajo de este tipo: mediana de los últimos 10 terminados bien."""
    rows = s.exec(select(Job).where(Job.kind == kind, Job.status == "done", Job.started_at != None)  # noqa: E711
                  .order_by(Job.id.desc()).limit(10)).all()
    secs = sorted((j.finished_at - j.started_at).total_seconds() for j in rows if j.finished_at and j.started_at)
    mid = secs[len(secs) // 2] if len(secs) >= 2 else 0
    return round(mid, 1) if mid >= 1 else None


@app.get("/api/activity")
def get_activity() -> dict:
    """Lo que corre ahora: el trabajo de la cola con sus pasos (hechos y en curso, con modelo y tiempos), los
    pasos de peticiones directas del dashboard y cuántos esperan."""
    live = activity.open_steps()
    with Session(engine) as s:
        running = s.exec(select(Job).where(Job.status == "running")).all()
        queued = s.exec(select(Job).where(Job.status == "queued").order_by(Job.rank, Job.id)).all()
        jobs = []
        for j in running:
            row = _job_row(s, j)
            t = activity.totals(j.id)
            row.update(steps=activity.events(j.id, 12), current=[x for x in live if x["job_id"] == j.id],
                       typical=_job_typical(s, j.kind), step_count=t["steps"], tokens=t["tokens"])
            jobs.append(row)
        nxt = [_job_row(s, j) for j in queued[:5]]
    direct = [x for x in live if x["job_id"] == 0 or x["job_id"] not in {j.id for j in running}]
    return {"paused": jobqueue.is_paused(), "jobs": jobs, "queued": len(queued), "next": nxt, "direct": direct,
            "recent_direct": activity.recent_direct()}


@app.get("/api/sources/{source_id}/activity")
def source_activity(source_id: int) -> dict:
    """Lo que ha corrido y corre para un vídeo: sus trabajos (procesado, clips marcados y renders de sus clips) con los
    pasos y modelos de cada uno."""
    from .db import JobEvent
    with Session(engine) as s:
        src = s.get(Source, source_id) or _404("Vídeo")
        clip_ids = set(s.exec(select(Clip.id).where(Clip.source_id == source_id)).all())
        rows = s.exec(select(Job).where(Job.kind.in_(("process_source", "manual_clips", "render_clip")))
                      .order_by(Job.id.desc()).limit(400)).all()
        # SQLite reutiliza los ids de lo borrado: los trabajos de antes de crear el vídeo eran de otro
        jobs = [j for j in rows if j.created_at >= src.created_at and (
            (j.kind == "render_clip" and j.ref_id in clip_ids) or (j.kind != "render_clip" and j.ref_id == source_id))][:30]
        job_ids = [j.id for j in jobs]
        events = s.exec(select(JobEvent).where(JobEvent.job_id.in_(job_ids)).order_by(JobEvent.id.desc()).limit(60)).all() \
            if job_ids else []
    live = [x for x in activity.open_steps() if x["job_id"] in set(job_ids)]
    return {
        "jobs": [{"id": j.id, "kind": j.kind, "label": JOB_LABELS.get(j.kind, j.kind.replace("_", " ")), "status": j.status,
                  "error": j.error, "created_at": j.created_at, "started_at": j.started_at, "finished_at": j.finished_at}
                 for j in jobs],
        "events": [activity.event_out(e) for e in reversed(events)],
        "live": live,
        "tokens": sum(e.tokens_in + e.tokens_out for e in events),
        "secs": round(sum(e.secs for e in events), 1),
    }


@app.get("/api/jobs/{job_id}/events")
def job_events(job_id: int) -> dict:
    """Los pasos de un trabajo: proceso o modelo, duración, tokens y si fue bien."""
    return {"events": activity.events(job_id, 200), **activity.totals(job_id)}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: int) -> dict:
    try:
        return {"status": jobqueue.cancel(job_id)}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


class JobMoveIn(BaseModel):
    to: str  # top | up | down | bottom


@app.post("/api/jobs/{job_id}/move")
def move_job(job_id: int, data: JobMoveIn) -> dict:
    try:
        return {"order": jobqueue.move(job_id, data.to)}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


class PauseIn(BaseModel):
    paused: bool


@app.post("/api/jobs/pause")
def pause_jobs(data: PauseIn) -> dict:
    """Pausar la cola: el trabajo en marcha termina y no empieza el siguiente hasta reanudar."""
    jobqueue.set_paused(data.paused)
    return {"paused": jobqueue.is_paused()}


# El dashboard compilado se sirve desde la raíz (después de las rutas /api). Las rutas del SPA usan "#".
@app.middleware("http")
async def fresh_index(request, call_next):
    """index.html siempre se revalida: si el navegador lo guarda, sigue cargando el JS de la versión anterior.
    El resto de /assets lleva hash en el nombre y se puede guardar."""
    response = await call_next(request)
    if request.url.path in ("/", "/index.html"):
        response.headers["Cache-Control"] = "no-cache"
    return response


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
