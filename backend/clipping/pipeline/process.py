"""Orquestación: procesar una fuente, construir y renderizar composiciones de clips, y exportar."""
from __future__ import annotations

import csv
import json
import logging
import re
import shutil
import zipfile
from datetime import datetime
from pathlib import Path

from sqlmodel import Session, select

from .. import clip_types, fxauto, jobctl, punctuation, quality
from ..config import CLIPS_DIR, DATA_DIR, EXPORT_PRESETS, SOURCES_DIR, ExportOptions, load_settings
from ..db import CaptionTemplate, Clip, Export, Source, engine, touch
from ..llm import get_provider
from . import camera, compose, download, editcopy, heatmap, moments, reframe, remotion, render, signals, transcribe
from .media import probe

log = logging.getLogger("clipping.process")
EXPORTS_DIR = DATA_DIR / "exports"


def _update(model, obj_id: int, **fields) -> None:
    with Session(engine) as s:
        obj = s.get(model, obj_id)
        if not obj:
            return
        for k, v in fields.items():
            setattr(obj, k, v)
        if hasattr(obj, "updated_at"):
            touch(obj)
        s.add(obj)
        s.commit()


def _update_source(source_id: int, **fields) -> None:
    _update(Source, source_id, **fields)


def _progress_cb(model, obj_id: int, base: float, span: float, **extra):
    """Callback que mapea el progreso de una etapa (0-1) al progreso global, sin escribir en la BD a cada décima."""
    last = [-1.0]

    def cb(p: float) -> None:
        jobctl.check()  # «Parar» en la cola de trabajos
        value = round(base + span * p, 3)
        if value - last[0] >= 0.01:
            last[0] = value
            _update(model, obj_id, progress=value, **extra)
    return cb


def _stage(source_id: int, status: str, detail: str, base: float, span: float):
    _update_source(source_id, status=status, stage_detail=detail, progress=round(base, 3))
    return _progress_cb(Source, source_id, base, span)


# ---------- Idea general del vídeo ----------

BRIEF_FILE = "brief.json"


def load_brief(source_id: int) -> dict | None:
    """La idea general guardada de una fuente (None si aún no hay)."""
    path = SOURCES_DIR / str(source_id) / BRIEF_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    brief = {k: str(data.get("brief", {}).get(k, "")).strip() for k in moments.BRIEF_FIELDS}
    return brief if any(brief.values()) else None


def brief_info(source_id: int) -> dict:
    path = SOURCES_DIR / str(source_id) / BRIEF_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return {"brief": load_brief(source_id), "edited": bool(data.get("edited")), "at": data.get("at", "")}


def save_brief(source_id: int, brief: dict, edited: bool) -> None:
    path = SOURCES_DIR / str(source_id) / BRIEF_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    clean = {k: str(brief.get(k, "")).strip()[:1200] for k in moments.BRIEF_FIELDS}
    path.write_text(json.dumps({"brief": clean, "edited": edited, "at": datetime.now().isoformat(timespec="seconds")},
                               ensure_ascii=False, indent=1), encoding="utf-8")


def master_options() -> ExportOptions:
    preset = EXPORT_PRESETS.get(load_settings().master_export) or EXPORT_PRESETS["youtube_shorts"]
    # La versión de revisión mantiene el formato de la composición.
    return preset["options"].model_copy(update={"aspect": ""})


def selection_guidance(src: Source) -> str:
    """Todo lo que el LLM debe saber al elegir momentos: tu contexto general (Ajustes), las reglas del tipo de clip y
    las instrucciones de este vídeo."""
    return "\n".join(x for x in (load_settings().guidance, clip_types.rules_text(src.typology), src.instructions)
                     if x and x.strip())


def process_source(source_id: int) -> None:
    settings = load_settings()
    with Session(engine) as s:
        src = s.get(Source, source_id)
        url, requested, max_height = src.url, src.requested_clips, src.max_height
        provider_name = src.llm_provider or settings.llm_provider
        guidance = selection_guidance(src)
        min_d = src.min_duration or settings.min_duration
        max_d = src.max_duration or settings.max_duration
        template_id = template_for(src)
        manual = src.selection == "manual"
        language = settings.language  # vacío = Whisper lo detecta

    src_dir = SOURCES_DIR / str(source_id)
    src_dir.mkdir(parents=True, exist_ok=True)

    # 1. Descarga
    with Session(engine) as s:
        existing = s.get(Source, source_id).video_path
    if existing and Path(existing).exists():
        video = Path(existing)
    else:
        cb = _stage(source_id, "downloading", "Descargando vídeo", 0.0, 0.12)
        video, title = download.fetch(url, src_dir, cb, edit_copy=False, max_height=max_height)
        info = probe(video)
        _update_source(source_id, video_path=str(video), title=title, duration=info["duration"],
                       width=info["width"], height=info["height"])
    # Vídeos AV1/VP9/HEVC (el 4K de YouTube): copia H.264 hecha con la gráfica, o el render va ~10 veces más lento
    if editcopy.needs_copy(video):
        cb = _stage(source_id, "downloading", "Preparando el vídeo para editar (gráfica)", 0.12, 0.03)
        video = editcopy.ensure(video, src_dir, replace=not download.is_local(url), on_progress=cb)
        _update_source(source_id, video_path=str(video))

    # 2. Transcripción
    transcript_path = src_dir / "transcript.json"
    if not transcript_path.exists():
        cb = _stage(source_id, "transcribing", "Transcribiendo con Whisper", 0.15, 0.40)
        data = transcribe.transcribe_isolated(video, settings.model_copy(update={"language": language}), cb)
        if not data["words"]:
            raise RuntimeError("La transcripción salió vacía: ¿el vídeo tiene voz?")
        if punctuation.missing_runs(data["words"]):  # tramos largos sin signos → los pone un modelo barato
            _stage(source_id, "transcribing", "Restaurando puntuación", 0.55, 0.0)
            data["words"], _ = punctuation.restore(data["words"], get_provider(provider_name, settings, task="punctuation"),
                                                   data.get("language", ""))
        transcript_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        _update_source(source_id, transcript_path=str(transcript_path))
    transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    _update_source(source_id, language=transcript.get("language", ""))
    if manual:
        _update_source(source_id, status="done", stage_detail="Transcrito: marca tú los clips", progress=1.0, error="")
        return

    # 3. Señales: picos de volumen y cambios de plano, como pistas para la IA
    _stage(source_id, "selecting", "Buscando picos de volumen y cambios de plano", 0.5, 0.05)
    sig = dict(signals.analyze(video, src_dir / "signals.json"))
    sig["heatmap"] = heatmap.ensure(src_dir / heatmap.FILE, url)  # «Más reproducido» de YouTube, si lo hay

    # 4. Idea general del vídeo: se escribe una vez y se guarda; si la corriges en el dashboard, se usa la tuya
    provider = get_provider(provider_name, settings, task="moments")
    brief = load_brief(source_id)
    if not brief:
        _stage(source_id, "selecting", "Entendiendo de qué va el vídeo", 0.55, 0.0)
        try:
            brief = moments.video_brief(transcript, provider, guidance=guidance)
            save_brief(source_id, brief, edited=False)
        except Exception:  # noqa: BLE001 — sin idea general se buscan igual, como antes
            log.exception("Fuente %s: no se pudo escribir la idea general del vídeo", source_id)
            brief = None
    from .. import moment_eval  # importa este módulo: aquí, no arriba

    examples = moment_eval.examples_text()
    discarded: list[moments.Moment] = []

    # 5. Selección de momentos
    cb = _stage(source_id, "selecting", f"Buscando momentos con {provider_name}", 0.56, 0.14)
    found = moments.find_moments(transcript, provider, count=requested, min_d=min_d, max_d=max_d,
                                 guidance=guidance, signals=sig, brief=brief, examples=examples,
                                 discarded=discarded, on_progress=cb)
    save_candidates(source_id, discarded)
    if not found:
        raise RuntimeError("La IA no encontró momentos lo bastante buenos en este vídeo.")

    with Session(engine) as s:
        src = s.get(Source, source_id)
        # Al regenerar se sustituyen las propuestas de la IA que no has tocado. Se conservan los clips marcados a mano y
        # los que ya decidiste (aprobados o rechazados): son tu criterio y miden el acierto
        #. Las propuestas nuevas que caen encima de uno de ellos no se repiten.
        kept: list[tuple[float, float]] = []
        for old in s.exec(select(Clip).where(Clip.source_id == source_id)).all():
            decided = old.status in ("approved", "rejected")
            if old.origin != "ai" or decided:
                kept.append((old.start, old.end))
                continue
            s.delete(old)
            shutil.rmtree(CLIPS_DIR / str(old.id), ignore_errors=True)
        found = [m for m in found if all(_overlap(m.start, m.end, a, b) < 0.5 for a, b in kept)]
        clip_ids = []
        for m in found:
            clip = Clip(source_id=source_id, start=m.start, end=m.end,
                        hook_start=m.hook_start, hook_end=m.hook_end,
                        title=m.title, hook=m.hook, reason=m.reason, score=m.score,
                        breakdown=json.dumps(m.breakdown(), ensure_ascii=False),
                        tags=json.dumps(m.tags), template_id=template_id, status="queued")
            s.add(clip)
            s.flush()
            clip_ids.append(clip.id)
        s.commit()

    # 4. Render de cada clip: un trabajo por clip en la cola, para poder pararlos o cambiarles el orden uno a uno
    _enqueue_renders(clip_ids)
    _update_source(source_id, status="done", stage_detail=f"{len(clip_ids)} clips en la cola de render",
                   progress=1.0, error="")


CANDIDATES_FILE = "candidates.json"


def save_candidates(source_id: int, discarded: list) -> None:
    """la bolsa de descartados de la última búsqueda (todo lo que la IA o las señales vieron y se quedó fuera)."""
    from datetime import datetime

    items = [{"id": i + 1, "start": m.start, "end": m.end, "title": m.title, "hook": m.hook, "reason": m.reason,
              "score": m.score, "tags": m.tags, "hook_start": m.hook_start, "hook_end": m.hook_end,
              "discard": m.discard, "breakdown": m.breakdown()} for i, m in enumerate(discarded)]
    path = SOURCES_DIR / str(source_id) / CANDIDATES_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"at": datetime.now().isoformat(timespec="seconds"), "items": items},
                               ensure_ascii=False, indent=1), encoding="utf-8")


def load_candidates(source_id: int) -> dict:
    try:
        return json.loads((SOURCES_DIR / str(source_id) / CANDIDATES_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"at": None, "items": []}


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    inter = min(a1, b1) - max(a0, b0)
    return inter / max(0.01, min(a1 - a0, b1 - b0)) if inter > 0 else 0.0


def _enqueue_renders(clip_ids: list[int]) -> None:
    from ..worker import enqueue  # el worker importa este módulo

    for clip_id in clip_ids:
        enqueue("render_clip", clip_id)


def template_for(src: Source) -> int | None:
    """Plantilla de subtítulos: la elegida al procesar > la de Ajustes (None = la primera)."""
    return src.template_id or load_settings().default_template_id


def initial_composition(clip: Clip, src: Source, tpl: CaptionTemplate) -> dict:
    """Composición automática: un tramo con el encuadre elegido al procesar y los subtítulos del tramo."""
    transcript = json.loads(Path(src.transcript_path).read_text(encoding="utf-8"))
    layout_opt = src.layout or "auto"
    keys: list[dict] = []
    panels: list[dict] | None = None
    parts: list[dict] | None = None
    note = ""
    # cortes, transiciones y zooms del original → cortes de la pista «Cámara» (y seguir cara plano a plano)
    cuts = camera.safe_source_cuts(Path(src.video_path), clip.start, clip.end)
    if layout_opt in ("auto", "face", "duo", "gaming"):
        out_w, out_h = remotion.ASPECT_SIZE.get(src.aspect or "9:16", (1080, 1920))
        plan = reframe.analyze(Path(src.video_path), clip.start, clip.end, src.width, src.height, layout_opt,
                               out_w, out_h, cuts=[c["t"] for c in cuts])
        layout = {"face": "crop", "split": "split", "parts": "crop"}.get(plan["mode"], "fit_blur")
        keys, panels, note = plan["keys"], plan.get("panels"), plan.get("note", "")
        parts = plan.get("parts")
    elif layout_opt == "center":
        layout = "crop"
    else:
        layout = layout_opt  # fit_black, fit_blur, fit_color
    comp = compose.clip_composition(
        source=src, start=clip.start, end=clip.end, words=transcript["words"],
        style=compose.style_from_template(tpl, json.loads(src.caption_style or "{}")), hook=clip.hook,
        layout=layout, keys=keys, panels=panels, note=note, parts=parts,
        aspect=src.aspect or "9:16", hook_enabled=src.hook_enabled,
        source_cuts=camera.absolute(cuts, clip.start),
    )
    settings = load_settings()
    if clip.hook_end > clip.hook_start and settings.cold_open != "off":
        comp = compose.add_cold_open(comp, clip.hook_start, clip.hook_end, transition=settings.cold_open_transition,
                                     mode=settings.cold_open_mode, language=src.language)
    return fxauto.decorate(comp, fxauto.options(load_settings()), tool="clip")


def render_clip(clip_id: int) -> None:
    # expire_on_commit=False: los objetos se siguen leyendo después de cerrar la sesión.
    with Session(engine, expire_on_commit=False) as s:
        clip = s.get(Clip, clip_id)
        src = s.get(Source, clip.source_id)
        tpl = (s.get(CaptionTemplate, clip.template_id) if clip.template_id else None) \
            or s.exec(select(CaptionTemplate).order_by(CaptionTemplate.id)).first()
        clip.status, clip.error, clip.progress = "rendering", "", 0
        touch(clip)
        s.add(clip)
        s.commit()

    clip_dir = CLIPS_DIR / str(clip_id)
    try:
        comp = json.loads(clip.composition) if clip.composition else initial_composition(clip, src, tpl)
        version = clip.version + 1
        out_name = f"clip_v{version}.mp4"
        cb = _progress_cb(Clip, clip_id, 0.0, 1.0)
        opts = master_options()
        out = remotion.render_composition(comp, clip_dir / out_name, opts, cb)
        for old in clip_dir.glob("clip_v*.mp4"):
            if old.name != out_name:
                old.unlink(missing_ok=True)
        duration = compose.composition_duration(comp)
        thumb = render.thumbnail(out, clip_dir / "thumb.jpg", at=min(1.0, duration / 2))
        segs = comp.get("segments") or [{}]
        report = quality.report_json(comp, out, version)
        with Session(engine) as s:
            db_clip = s.get(Clip, clip_id)
            db_clip.composition = json.dumps(comp)
            db_clip.status, db_clip.progress, db_clip.version = "review", 1.0, version
            db_clip.resolved_mode = segs[0].get("layout", "")
            if segs and "src_in" in segs[0]:  # inicio y fin reales tras la edición
                db_clip.start = segs[0]["src_in"]
                db_clip.end = segs[-1]["src_out"]
            db_clip.video_path = out.relative_to(DATA_DIR).as_posix()
            db_clip.thumb_path = thumb.relative_to(DATA_DIR).as_posix()
            db_clip.quality = report
            touch(db_clip)
            s.add(db_clip)
            s.commit()
    except Exception as exc:
        _update(Clip, clip_id, status="error", error=str(exc)[-1500:])
        raise


def score_manual_clips(source_id: int) -> None:
    """Clips marcados a mano: la IA les pone título, gancho, motivo y puntuación, y después se renderizan."""
    settings = load_settings()
    with Session(engine, expire_on_commit=False) as s:
        src = s.get(Source, source_id)
        clips = s.exec(select(Clip).where(Clip.source_id == source_id, Clip.status == "scoring")
                       .order_by(Clip.start)).all()
    if not clips:
        return
    transcript = json.loads(Path(src.transcript_path).read_text(encoding="utf-8"))
    provider_name = src.llm_provider or settings.llm_provider
    guidance = selection_guidance(src)
    _update_source(source_id, status="selecting", stage_detail=f"Puntuando {len(clips)} clips marcados a mano",
                   progress=0.0)
    try:
        scored = moments.score_ranges(transcript, [(c.start, c.end) for c in clips],
                                      get_provider(provider_name, settings, task="score"), guidance=guidance)
    except Exception:  # sin IA los clips se renderizan igual, solo sin puntuación
        log.exception("No se pudieron puntuar los clips manuales de la fuente %s", source_id)
        scored = [None] * len(clips)
    with Session(engine) as s:
        for clip, m in zip(clips, scored):
            db_clip = s.get(Clip, clip.id)
            if m:
                db_clip.title = db_clip.title or m.title
                db_clip.hook, db_clip.reason, db_clip.score = m.hook, m.reason, m.score
                db_clip.tags = json.dumps(m.tags)
            db_clip.status = "queued"
            s.add(db_clip)
        s.commit()
    _enqueue_renders([c.id for c in clips])
    _update_source(source_id, status="done", stage_detail=f"{len(clips)} clips manuales en la cola de render",
                   progress=1.0, error="")


def _slug(text: str, limit: int = 60) -> str:
    return re.sub(r"[^\w\-]+", "_", text).strip("_")[:limit] or "clip"


def export_filename(pattern: str, clip: Clip) -> str:
    name = pattern.format(id=clip.id, title=_slug(clip.title or f"clip_{clip.id}"), score=clip.score,
                          date=datetime.now().strftime("%Y%m%d"))
    return _slug(name, 120) + ".mp4"


def run_export(export_id: int) -> None:
    """Renderiza los clips de una exportación con sus opciones, añade metadata.csv y lo empaqueta en un .zip."""
    with Session(engine) as s:
        exp = s.get(Export, export_id)
        clip_ids = json.loads(exp.clip_ids)
        opts = ExportOptions(**json.loads(exp.options))
    folder = EXPORTS_DIR / f"export_{export_id}_{datetime.now():%Y%m%d_%H%M}"
    folder.mkdir(parents=True, exist_ok=True)
    _update(Export, export_id, status="running", progress=0, detail="Preparando")
    rows = []
    for n, clip_id in enumerate(clip_ids):
        with Session(engine, expire_on_commit=False) as s:
            clip = s.get(Clip, clip_id)
        if not clip or not clip.composition:
            continue
        name = export_filename(opts.filename, clip)
        _update(Export, export_id, detail=f"Renderizando {n + 1}/{len(clip_ids)}: {name}")
        cb = _progress_cb(Export, export_id, n / len(clip_ids), 1 / len(clip_ids))
        remotion.render_composition(json.loads(clip.composition), folder / name, opts, cb)
        rows.append({"archivo": name, "titulo": clip.title, "gancho": clip.hook, "motivo": clip.reason,
                     "hashtags": " ".join("#" + re.sub(r"\W+", "", t) for t in json.loads(clip.tags or "[]")),
                     "puntuacion": clip.score, "inicio": round(clip.start, 2), "fin": round(clip.end, 2)})
    if not rows:
        raise RuntimeError("Ninguno de los clips tiene una composición renderizable.")
    with (folder / "metadata.csv").open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    zip_path = folder.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:  # el MP4 ya va comprimido
        for f in folder.iterdir():
            zf.write(f, f.name)
    _update(Export, export_id, status="done", progress=1.0, detail=f"{len(rows)} vídeos exportados",
            path=zip_path.relative_to(DATA_DIR).as_posix())
