"""Modelos de datos (SQLite vía SQLModel), migraciones ligeras y datos iniciales."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import inspect, text
from sqlmodel import Field, Session, SQLModel, create_engine, select

from .config import DB_PATH, ensure_dirs

log = logging.getLogger("clipping.db")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class CaptionTemplate(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str
    font: str = "Montserrat"
    font_size: int = 86
    font_weight: int = 900
    primary_color: str = "#FFFFFF"
    highlight_color: str = "#FFD400"
    highlight_mode: str = "color"  # color, box, underline
    box_color: str = "#7C3AED"
    outline_color: str = "#000000"
    outline_width: float = 6
    shadow: float = 3
    uppercase: bool = True
    words_per_chunk: int = 3
    margin_v: int = 560  # distancia desde el borde inferior en un lienzo de 1080x1920
    animation: str = "pop"  # ver ANIMATIONS en frontend/src/remotion/Captions.tsx
    chunk_bg_color: str = ""  # caja detrás del bloque ("" = sin caja)
    chunk_bg_opacity: float = 0.6
    pop: bool = True  # obsoleto (sustituido por animation); se mantiene porque la columna existe
    hook_enabled: bool = True
    hook_font_size: int = 64
    hook_text_color: str = "#000000"
    hook_bg_color: str = "#FFFFFF"
    hook_duration: float = 3.0


class Source(SQLModel, table=True):
    """Un vídeo largo del que salen clips (URL o archivo local)."""
    id: int | None = Field(default=None, primary_key=True)
    url: str  # URL o ruta local
    title: str = ""
    permission_note: str
    requested_clips: int = 5
    llm_provider: str = ""
    # Opciones de procesado (vacío/0 = lo de Ajustes)
    layout: str = "auto"  # auto, face, center, duo, gaming, fit_black, fit_blur, fit_color
    bg_color: str = "#111111"
    aspect: str = "9:16"
    template_id: int | None = None
    hook_enabled: bool = True
    min_duration: float = 0
    max_duration: float = 0
    instructions: str = ""
    caption_style: str = ""  # JSON con los cambios sobre la plantilla elegidos al procesar (altura, tamaño…)
    selection: str = "auto"  # auto = la IA elige los clips · manual = solo transcribe y los marcas tú
    typology: str = ""  # id de clip_types.py; sus reglas entran en la búsqueda de momentos
    max_height: int = 0  # calidad de descarga (download.resolve_height): 0 = automática, 1080, 1440 o 2160
    status: str = "queued"  # queued, downloading, transcribing, selecting, done, error
    progress: float = 0
    stage_detail: str = ""
    error: str = ""
    duration: float = 0
    width: int = 0
    height: int = 0
    video_path: str = ""
    transcript_path: str = ""
    language: str = ""  # idioma detectado por Whisper ("es", "en"…)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Clip(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    source_id: int = Field(index=True)
    start: float
    end: float
    hook_start: float = 0  # gancho adelantado: tramo del original que se ve primero; 0-0 = sin él
    hook_end: float = 0
    title: str = ""
    hook: str = ""
    reason: str = ""
    score: int = 0
    tags: str = "[]"  # lista JSON
    template_id: int | None = None
    resolved_mode: str = ""
    composition: str = ""  # JSON; ver frontend/src/remotion/schema.ts
    status: str = "queued"  # queued, scoring, rendering, review, approved, rejected, error
    origin: str = "ai"  # ai = propuesto por la IA · manual = marcado a mano · rescued = rescatado de los descartados
    breakdown: str = ""  # JSON con el desglose de la nota (IA, rúbrica de punch, señales, por dónde entró)
    progress: float = 0
    error: str = ""
    version: int = 0
    video_path: str = ""  # relativa a DATA_DIR
    thumb_path: str = ""
    quality: str = ""  # informe de los filtros de calidad (JSON, quality.py) del último render
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Export(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    clip_ids: str  # lista JSON
    options: str  # JSON de ExportOptions
    status: str = "queued"  # queued, running, done, error
    progress: float = 0
    detail: str = ""
    error: str = ""
    path: str = ""  # .zip relativo a DATA_DIR
    created_at: datetime = Field(default_factory=utcnow)


class Job(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    kind: str  # process_source, render_clip, export, manual_clips, moments_benchmark
    ref_id: int
    status: str = "queued"  # queued, running, done, error, cancelled
    error: str = ""
    # Orden en la cola (menor = antes). Al encolar vale su id; «subir», «bajar» y «el primero» lo cambian.
    rank: float = 0
    # Quién lo lanzó, para la caché de la IA: 0 = la propia producción, 1 = el dashboard, 2 = el dashboard con «Regenerar»
    llm: int = 0
    created_at: datetime = Field(default_factory=utcnow)
    started_at: datetime | None = None
    finished_at: datetime | None = None


class JobEvent(SQLModel, table=True):
    """Un paso de un trabajo ya terminado: qué proceso o modelo corrió, cuánto tardó y cuántos tokens gastó
    (activity.py). job_id 0 = una petición directa del dashboard, fuera de la cola."""
    id: int | None = Field(default=None, primary_key=True)
    job_id: int = Field(default=0, index=True)
    kind: str  # llm, agent, ml, whisper, render, ffmpeg, api
    label: str
    model: str = ""
    detail: str = ""
    task: str = ""
    ok: bool = True
    error: str = ""
    secs: float = 0
    tokens_in: int = 0
    tokens_out: int = 0
    started_at: datetime = Field(default_factory=utcnow)


ensure_dirs()
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


def _sql_default(value) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def migrate() -> None:
    """Añade a las tablas existentes las columnas nuevas de los modelos (SQLite no lo hace solo)."""
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            model = next(m for m in SQLModel.__subclasses__() if getattr(m, "__tablename__", None) == table.name)
            for col in table.columns:
                if col.name in existing:
                    continue
                field = model.model_fields.get(col.name)
                default = field.default if field is not None else None
                if callable(getattr(field, "default_factory", None)):
                    default = None
                coltype = col.type.compile(engine.dialect)
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {coltype} DEFAULT {_sql_default(default)}'))
                log.info("Migración: %s.%s añadida", table.name, col.name)


# Plantillas predefinidas. Se insertan las que falten por nombre, así aparecen también en bases ya creadas.
PRESETS: list[dict] = [
    dict(name="Hormozi (amarillo)", font="Montserrat", highlight_color="#FFD400"),
    dict(name="Hormozi caja morada", font="Montserrat", highlight_mode="box", box_color="#7C3AED",
         highlight_color="#FFFFFF", words_per_chunk=3),
    dict(name="MrBeast", font="Luckiest Guy", font_weight=400, font_size=92, highlight_color="#3BFF3B",
         outline_width=8, animation="bounce", words_per_chunk=2),
    dict(name="Impacto rojo", font="Anton", font_weight=400, font_size=104, highlight_color="#EF4444",
         words_per_chunk=2, animation="bounce"),
    dict(name="Podcast limpio", font="Inter", font_weight=800, font_size=72, uppercase=False,
         highlight_color="#FDE047", highlight_mode="underline", outline_width=3, shadow=2, words_per_chunk=4,
         animation="none"),
    dict(name="Neón cian", font="Outfit", font_weight=900, highlight_color="#22D3EE", outline_color="#0B1220",
         outline_width=5, shadow=5),
    dict(name="Minimal", font="Poppins", font_weight=700, font_size=66, uppercase=False, outline_width=0,
         shadow=4, highlight_color="#FFFFFF", primary_color="#D4D4D4", words_per_chunk=5, animation="none"),
    dict(name="Documental", font="Playfair Display", font_weight=700, font_size=64, uppercase=False,
         outline_width=0, shadow=4, highlight_color="#F5C518", words_per_chunk=6, animation="none", margin_v=260,
         hook_bg_color="#111111", hook_text_color="#F5F5F5"),
    dict(name="Karaoke", font="Rubik", font_weight=900, primary_color="#9CA3AF", highlight_color="#FFFFFF",
         words_per_chunk=4),
    dict(name="Story naranja", font="Lilita One", font_weight=400, font_size=90, highlight_color="#FB923C",
         animation="bounce"),
    dict(name="Gaming verde", font="Bebas Neue", font_weight=400, font_size=118, highlight_mode="box",
         box_color="#000000", highlight_color="#A3E635", words_per_chunk=2),
    dict(name="Marcador rosa", font="Permanent Marker", font_weight=400, font_size=84, uppercase=False,
         highlight_color="#F472B6", outline_width=5),
    dict(name="Titular condensado", font="Teko", font_weight=700, font_size=130, highlight_color="#FACC15",
         words_per_chunk=3),
    dict(name="Limpio (blanco)", font="Segoe UI Black", font_size=78, highlight_color="#4ADE80", uppercase=False,
         words_per_chunk=4, animation="none", outline_width=5, shadow=2),
    # Serias, profesionales y minimalistas
    dict(name="Corporativo con caja", font="Inter", font_weight=700, font_size=58, uppercase=False,
         highlight_color="#FFFFFF", outline_width=0, shadow=0, words_per_chunk=7, animation="chunk_fade",
         chunk_bg_color="#000000", chunk_bg_opacity=0.55, margin_v=220, hook_bg_color="#111111",
         hook_text_color="#FFFFFF"),
    dict(name="Subtítulo clásico", font="Inter", font_weight=700, font_size=54, uppercase=False,
         highlight_color="#FFFFFF", outline_width=2, shadow=2, words_per_chunk=8, animation="chunk_fade",
         margin_v=160),
    dict(name="Minimal aparición", font="Poppins", font_weight=700, font_size=64, uppercase=False,
         highlight_color="#FFFFFF", outline_width=0, shadow=3, words_per_chunk=4, animation="fade_in"),
    dict(name="Editorial serif", font="Playfair Display", font_weight=700, font_size=66, uppercase=False,
         highlight_color="#F5C518", outline_width=0, shadow=4, words_per_chunk=6, animation="dim",
         hook_bg_color="#111111", hook_text_color="#F5F5F5"),
    dict(name="Tech subrayado", font="Outfit", font_weight=700, font_size=70, uppercase=False,
         highlight_color="#38BDF8", outline_width=3, shadow=2, words_per_chunk=4, animation="sweep"),
    dict(name="Máquina de escribir", font="Inter", font_weight=700, font_size=68, uppercase=False,
         highlight_color="#FFFFFF", outline_width=4, shadow=2, words_per_chunk=5, animation="typewriter"),
    dict(name="Desenfoque elegante", font="Outfit", font_weight=700, font_size=72, uppercase=False,
         highlight_color="#FFFFFF", outline_width=0, shadow=4, words_per_chunk=4, animation="blur_in"),
    dict(name="Subida suave", font="Montserrat", font_weight=800, font_size=78, highlight_color="#FFD400",
         outline_width=5, words_per_chunk=3, animation="reveal_up"),
    dict(name="Brillo neón", font="Outfit", font_weight=900, font_size=84, highlight_color="#C4B5FD",
         outline_color="#1E1B4B", outline_width=4, shadow=0, words_per_chunk=3, animation="glow"),
]


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    migrate()
    with Session(engine) as s:
        names = {t.name for t in s.exec(select(CaptionTemplate)).all()}
        for preset in PRESETS:
            if preset["name"] not in names:
                s.add(CaptionTemplate(**preset, pop=preset.get("animation", "pop") != "none"))
        s.commit()


def touch(obj) -> None:
    obj.updated_at = utcnow()
