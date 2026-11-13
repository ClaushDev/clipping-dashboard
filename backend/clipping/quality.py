"""Filtros de calidad (idea de OpenMontage, reescrita desde cero). Antes de renderizar se revisa la composición:
riesgo de «pase de diapositivas», primer cambio visual, ritmo de la voz, silencios, subtítulos, gancho, el arranque en
tres capas (`opening.opening`) y archivos que faltan. Después se revisa el MP4 con FFmpeg: negros, imagen congelada, cortes reales, volumen, picos y silencios, más
una tira de fotogramas para verlo de un vistazo. No bloquean nada: dan una nota y avisos para la revisión humana."""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from .config import CLIPS_DIR, DATA_DIR, require_exe
from .pipeline.compose import audio_source_ranges, composition_duration, segment_length, segment_local_of
from .pipeline.media import run

log = logging.getLogger("clipping.quality")

MEDIA_DIRS = {"clips": CLIPS_DIR, "assets": DATA_DIR / "assets", "sfx": DATA_DIR / "sfx", "music": DATA_DIR / "music"}
PENALTY = {"error": 25, "warn": 10, "info": 3}
LUFS_TARGET = -14.0  # YouTube normaliza a unos -14 LUFS: más bajo suena flojo al lado de otros vídeos
DEAD_AIR = 1.5  # segundos sin voz que ya se notan como hueco
OPENING_LAYERS = {"spoken": "lo que se oye", "text": "lo que se lee", "visual": "lo que se ve"}


def _issue(level: str, code: str, text: str, fix: str = "", at: float | None = None) -> dict:
    return {"level": level, "code": code, "text": text, "fix": fix, "at": None if at is None else round(at, 2)}


def _fmt(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


# ---------- Antes de renderizar: la composición ----------

def _segment_offsets(segments: list[dict]) -> list[float]:
    out, t = [], 0.0
    for s in segments:
        out.append(t)
        t += segment_length(s)
    return out


def timeline_words(comp: dict) -> list[dict]:
    """Palabras de subtítulo en tiempos de la timeline (como timelineWords en schema.ts)."""
    cap = comp.get("captions") or {}
    words = cap.get("words") or []
    if cap.get("time_base") != "source":
        return sorted(words, key=lambda w: w["s"])
    segs = comp.get("segments") or []
    offsets = _segment_offsets(segs)
    out = []
    for s, off, (a, b) in zip(segs, offsets, audio_source_ranges(segs)):  # un tramo duplicado repite sus palabras
        for w in words:
            if a <= w["s"] < b and w.get("src", s["src"]) == s["src"]:
                out.append({**w, "s": off + segment_local_of(s, w["s"] - s["src_in"]),
                            "e": off + segment_local_of(s, w["e"] - s["src_in"])})
    return sorted(out, key=lambda w: w["s"])


def shots(comp: dict) -> list[dict]:
    """Planos de la composición: tramos del vídeo original y escenas (imagen, vídeo, gráfico), en orden."""
    out = []
    for s, off in zip(comp.get("segments") or [], _segment_offsets(comp.get("segments") or [])):
        out.append({"start": off, "end": off + segment_length(s), "kind": "video", "src": s.get("src", "")})
    for sc in comp.get("scenes") or []:
        out.append({"start": sc["start"], "end": sc["start"] + sc["duration"], "kind": sc.get("kind", "image"),
                    "src": sc.get("src") or (sc.get("graphic") or {}).get("component", "")})
    return sorted(out, key=lambda x: x["start"])


def _media_path(url: str) -> Path | None:
    m = re.match(r"^/media/([^/]+)/([^?#]+)", url or "")
    if not m or m.group(1) not in MEDIA_DIRS:
        return None
    return MEDIA_DIRS[m.group(1)] / m.group(2)


def _media_urls(comp: dict) -> list[tuple[str, str]]:
    urls = [("escena", sc.get("src", "")) for sc in comp.get("scenes") or []]
    urls += [("escena", sc.get("poster", "")) for sc in comp.get("scenes") or []]
    urls += [("audio", a.get("src", "")) for a in comp.get("audio") or []]
    urls += [("capa", o.get("src", "")) for o in comp.get("overlays") or [] if o.get("kind") == "image"]
    for o in comp.get("overlays") or []:
        if o.get("kind") == "block":
            urls += [("bloque", u) for u in (o.get("images") or {}).values()]
    return [(k, u) for k, u in urls if u]


def plan_check(comp: dict) -> dict:
    """Revisión rápida de la composición, sin renderizar."""
    issues: list[dict] = []
    duration = composition_duration(comp)
    vertical = comp.get("aspect") == "9:16"
    shot_list = shots(comp)
    overlays = comp.get("overlays") or []
    fx = comp.get("fx") or []

    # Duración
    if vertical and duration > 180:
        issues.append(_issue("error", "too_long", f"Dura {duration:.0f} s: un Short puede durar como mucho 3 minutos.",
                             "Recórtalo o pásalo a 16:9 como vídeo largo."))
    elif vertical and duration > 75:
        issues.append(_issue("info", "long_short", f"Dura {duration:.0f} s. Los Shorts de 30-60 s suelen retener mejor.",
                             "Si no aguanta el ritmo, recorta lo que no avanza la historia."))

    # Imagen: planos, imágenes fijas y riesgo de «pase de diapositivas»
    still = sum(s["end"] - s["start"] for s in shot_list if s["kind"] == "image")
    still_share = still / duration if duration else 0
    sources = {s["src"] for s in shot_list if s["src"]}
    events = sorted({round(s["start"], 2) for s in shot_list}
                    | {round(o["start"], 2) for o in overlays if o.get("kind") != "progress"}
                    | {round(f["start"], 2) for f in fx})
    minutes = max(duration / 60, 1 / 60)
    cuts = max(0, len(shot_list) - 1)
    avg_shot = duration / max(1, len(shot_list))
    longest = max((s["end"] - s["start"] for s in shot_list), default=duration)
    distinct_per_min = len(sources) / minutes
    events_per_min = len(events) / minutes
    if shot_list and still_share >= 0.7 and (distinct_per_min < 6 or events_per_min < 12):
        issues.append(_issue(
            "warn", "slideshow",
            f"Riesgo de «pase de diapositivas»: el {still_share:.0%} son imágenes fijas, con {distinct_per_min:.1f} "
            f"imágenes distintas por minuto.",
            "Mete footage libre, gráficos animados o bloques en los planos más largos, o efectos de cámara."))
    elif shot_list and still_share >= 0.7:
        issues.append(_issue("info", "stills", f"El {still_share:.0%} del vídeo son imágenes fijas con movimiento de cámara.",
                             "Un clip de vídeo o un gráfico animado de vez en cuando rompe la monotonía."))
    long_stills = [s for s in shot_list if s["kind"] == "image" and s["end"] - s["start"] > 6]
    for s in long_stills[:3]:
        issues.append(_issue("warn", "long_still", f"Imagen fija de {s['end'] - s['start']:.1f} s sin corte en {_fmt(s['start'])}.",
                             "Pártela en dos planos o cámbiala por vídeo.", s["start"]))
    if len(long_stills) > 3:
        issues.append(_issue("warn", "long_still", f"Y {len(long_stills) - 3} imágenes fijas más de más de 6 s."))
    first_change = next((e for e in events if e > 0.05), None)
    if vertical and shot_list and shot_list[0]["kind"] == "image" and (first_change is None or first_change > 2.5):
        when = f"en {first_change:.1f} s" if first_change else "nunca"
        issues.append(_issue("warn", "slow_open", f"El primer cambio de imagen llega {when}: en Shorts conviene antes de 2 s.",
                             "Corta antes o añade un zoom o un texto en el primer segundo.", 0))

    # Voz, subtítulos y gancho
    audio = comp.get("audio") or []
    has_voice = any(a.get("kind") == "voice" for a in audio) or any((s.get("volume", 1) or 0) > 0 for s in comp.get("segments") or [])
    if not audio and not any((s.get("volume", 1) or 0) > 0 for s in comp.get("segments") or []):
        issues.append(_issue("error", "no_audio", "El vídeo no tiene sonido.", "Añade voz, el audio original o música."))
    music = [a for a in audio if a.get("kind") == "music"]
    if has_voice and any(a.get("volume", 0) > 0.35 and not a.get("duck") for a in music):
        issues.append(_issue("info", "music_loud", "La música va alta y sin bajar cuando habla la voz.",
                             "Bájala a 0,15-0,25 o activa que se aparte de la voz."))
    words = timeline_words(comp)
    cap = comp.get("captions") or {}
    if has_voice and (not cap.get("enabled") or not words):
        issues.append(_issue("warn", "no_captions", "No lleva subtítulos: muchos Shorts se ven sin sonido.",
                             "Activa los subtítulos en el editor."))
    wpm = 0.0
    # Voz en off sobre el audio original: los huecos entre frases son el original sonando, a propósito
    over_original = (bool(((comp.get("mix") or {}).get("duck") or {}).get("original"))
                     and any((s.get("volume", 1) or 0) > 0 for s in comp.get("segments") or []))
    if len(words) >= 8:
        spoken = words[-1]["e"] - words[0]["s"]
        wpm = len(words) / max(spoken / 60, 1 / 60)
        if over_original:
            pass  # el ritmo de la voz no se mide: entre frases habla el original
        elif wpm < 120:
            issues.append(_issue("info", "slow_voice", f"La voz va lenta ({wpm:.0f} palabras por minuto).",
                                 "Recorta las pausas largas o acelera un poco el tramo."))
        elif wpm > 210:
            issues.append(_issue("info", "fast_voice", f"La voz va muy rápida ({wpm:.0f} palabras por minuto).",
                                 "Deja respirar las frases importantes."))
        if words[0]["s"] > DEAD_AIR:
            issues.append(_issue("warn", "late_voice", f"La voz no empieza hasta el segundo {words[0]['s']:.1f}.",
                                 "Que lo primero que se oiga sea el gancho.", 0))
        gaps = [] if over_original else [(a["e"], b["s"] - a["e"]) for a, b in zip(words, words[1:])
                                         if b["s"] - a["e"] > DEAD_AIR]
        for t, gap in gaps[:5]:
            issues.append(_issue("warn", "dead_air", f"{gap:.1f} s sin voz en {_fmt(t)}.",
                                 "Si en ese hueco no pasa nada que enganche, recórtalo o tápalo con un efecto.", t))
        if len(gaps) > 5:
            issues.append(_issue("warn", "dead_air", f"Y {len(gaps) - 5} huecos más sin voz de {DEAD_AIR} s o más."))
    segs = comp.get("segments") or []
    if segs and segs[0].get("cold_open") and words:
        from .ytkit import score_hook

        cut = segment_length(segs[0])
        said = lambda a, b: " ".join(w["w"] for w in words if a <= w["s"] < b)  # noqa: E731
        cold, natural = said(0, cut), said(cut, cut + 3.5)
        if cold and natural:
            sc, sn = score_hook(cold)["verdict"], score_hook(natural)["verdict"]
            better = sc >= sn
            issues.append(_issue(
                "info" if better else "warn", "cold_open",
                f"Gancho adelantado: «{cold[:60]}» puntúa {sc} frente a {sn} del inicio natural «{natural[:60]}».",
                "Bien: el tramo de delante engancha más." if better else
                "El inicio natural engancha más: quita el gancho adelantado o elige otro tramo.", 0))
    style = cap.get("style") or {}
    first_text = any(o.get("kind") in ("text", "block") and o["start"] < 3 for o in overlays)
    if vertical and not (style.get("hook_enabled") and (comp.get("hook") or {}).get("text")) and not first_text:
        issues.append(_issue("info", "no_hook", "No hay texto de gancho en los 3 primeros segundos.",
                             "Un texto corto arriba ayuda a que no pasen de largo.", 0))

    # Archivos que faltan
    for kind, url in _media_urls(comp):
        path = _media_path(url)
        if path is not None and not path.exists():
            issues.append(_issue("error", "missing_file", f"Falta el archivo de {kind}: {url.split('/')[-1].split('?')[0]}.",
                                 "Vuelve a elegirlo en el editor."))

    # Arranque en tres capas (lo que se oye, se lee y se ve): un aviso si el conjunto es flojo; el detalle va aparte
    from .opening import opening
    op = opening(comp)
    if op["band"] == "weak":
        worst = min(op["layers"], key=lambda k: op["layers"][k]["score"])
        tip = next((i["fix"] for i in op["issues"] if i["layer"] == worst and i["fix"]), "")
        issues.append(_issue("warn", "weak_open", f"El arranque es flojo ({op['score']}/100): falla sobre todo "
                             f"{OPENING_LAYERS[worst]}.", tip, 0))

    metrics = {"duration": round(duration, 2), "shots": len(shot_list), "cuts": cuts, "avg_shot": round(avg_shot, 2),
               "longest_shot": round(longest, 2), "still_share": round(still_share, 3),
               "visuals_per_min": round(distinct_per_min, 1), "changes_per_min": round(events_per_min, 1),
               "wpm": round(wpm), "words": len(words), "opening": op["score"]}
    return {"issues": issues, "metrics": metrics, "opening": op}


# ---------- Después de renderizar: el MP4 ----------

NUM = r"(-?\d+(?:\.\d+)?)"


def parse_ffmpeg(log_text: str) -> dict:
    """Saca de la salida de FFmpeg los tramos negros, congelados, silencios, cortes y el volumen."""
    black = [(float(a), float(b)) for a, b in re.findall(rf"black_start:{NUM} black_end:{NUM}", log_text)]
    freeze_starts = [float(x) for x in re.findall(rf"freeze_start: {NUM}", log_text)]
    freeze_durs = [float(x) for x in re.findall(rf"freeze_duration: {NUM}", log_text)]
    silence_starts = [float(x) for x in re.findall(rf"silence_start: {NUM}", log_text)]
    silence_ends = [(float(a), float(b)) for a, b in re.findall(rf"silence_end: {NUM} \| silence_duration: {NUM}", log_text)]
    cuts = sorted({round(float(t), 2) for t in re.findall(rf"lavfi\.scd\.time: {NUM}", log_text)})
    summary = log_text.rsplit("Summary:", 1)[-1] if "Summary:" in log_text else ""
    lufs = re.search(rf"I:\s+{NUM} LUFS", summary)
    peak = re.search(rf"Peak:\s+{NUM} dBFS", summary)
    freezes = [(s, d) for s, d in zip(freeze_starts, freeze_durs)]
    if len(freeze_starts) > len(freeze_durs):  # congelado hasta el final: FFmpeg no da duración
        freezes.append((freeze_starts[-1], -1.0))
    silences = [(s, d) for s, (_, d) in zip(silence_starts, silence_ends)]
    if len(silence_starts) > len(silence_ends):
        silences.append((silence_starts[-1], -1.0))
    return {"black": black, "freezes": freezes, "silences": silences, "cuts": cuts,
            "lufs": float(lufs.group(1)) if lufs else None, "peak": float(peak.group(1)) if peak else None,
            "has_audio": "Stream #0:1" in log_text or "Audio:" in log_text}


def analyze_video(video: Path, *, scene_threshold: float = 10.0) -> dict:
    """Una pasada de FFmpeg con imagen reducida: negros, congelados, cortes (scdet), volumen EBU R128 y silencios."""
    cmd = [require_exe("ffmpeg"), "-hide_banner", "-nostats", "-i", str(video),
           "-vf", f"scale=320:-2,blackdetect=d=0.4:pix_th=0.10,freezedetect=n=0.003:d=2,scdet=threshold={scene_threshold}",
           "-af", "ebur128=peak=true:framelog=quiet,silencedetect=n=-45dB:d=1.2", "-f", "null", "-"]
    try:
        proc = run(cmd, timeout=1800)
    except RuntimeError:
        # Sin pista de audio los filtros de audio fallan: se repite solo con la imagen.
        proc = run(cmd[:cmd.index("-af")] + ["-an", "-f", "null", "-"], timeout=1800)
        out = parse_ffmpeg(proc.stderr)
        out["has_audio"] = False
        return out
    return parse_ffmpeg(proc.stderr)


def frame_sheet(video: Path, duration: float, out: Path, frames: int = 8) -> Path | None:
    """Tira de fotogramas repartidos por todo el vídeo, para revisarlo de un vistazo."""
    try:
        run([require_exe("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", "-i", str(video), "-vf",
             f"fps={frames / max(duration, 0.5):.5f},scale=-2:200,tile={frames}x1:padding=4:color=black",
             "-frames:v", "1", "-q:v", "4", str(out)], timeout=600)
        return out if out.exists() else None
    except RuntimeError as exc:
        log.warning("No se pudo crear la tira de fotogramas: %s", exc)
        return None


def render_issues(data: dict, duration: float, expected: float, scene_based: bool) -> tuple[list[dict], dict]:
    issues: list[dict] = []
    for a, b in data["black"]:
        if b - a >= 0.4 and not (a < 0.05 or b > duration - 0.1):
            issues.append(_issue("error" if b - a >= 1 else "warn", "black", f"Pantalla negra de {b - a:.1f} s en {_fmt(a)}.",
                                 "Mira esa parte en el editor: suele ser un plano o un archivo que no carga.", a))
        elif b - a >= 1:
            issues.append(_issue("warn", "black_edge", f"Pantalla negra de {b - a:.1f} s al {'principio' if a < 0.05 else 'final'}.",
                                 "Recorta el negro: los primeros fotogramas deciden si siguen viendo.", a))
    freezes = [(s, duration - s if d < 0 else d) for s, d in data["freezes"]]
    freezes = [(s, d) for s, d in freezes if d >= 3]
    for s, d in freezes[:4]:
        issues.append(_issue("warn", "freeze", f"Imagen congelada {d:.1f} s en {_fmt(s)}.",
                             "Si no es a propósito, falta movimiento o un vídeo se quedó parado.", s))
    if len(freezes) > 4:
        issues.append(_issue("warn", "freeze", f"Y {len(freezes) - 4} tramos congelados más."))
    if not data["has_audio"]:
        issues.append(_issue("error", "no_audio_track", "El MP4 no tiene pista de audio."))
    else:
        lufs, peak = data["lufs"], data["peak"]
        if lufs is not None and lufs < -20:
            issues.append(_issue("warn", "quiet", f"Suena bajo ({lufs:.1f} LUFS; YouTube iguala a unos {LUFS_TARGET:.0f}).",
                                 "Sube el volumen de la voz."))
        elif lufs is not None and lufs > -9:
            issues.append(_issue("warn", "loud", f"Suena muy fuerte ({lufs:.1f} LUFS); YouTube lo bajará y puede sonar aplastado.",
                                 "Baja la música o los efectos."))
        if peak is not None and peak > -1.0:
            issues.append(_issue("warn", "clipping", f"Picos de {peak:.1f} dBFS: puede saturar.",
                                 "Baja un poco los efectos de sonido o la música."))
        for s, d in data["silences"][:4]:
            d = duration - s if d < 0 else d
            if d >= DEAD_AIR and s < duration - 0.5:
                issues.append(_issue("warn", "silence", f"{d:.1f} s sin sonido en {_fmt(s)}.",
                                     "Recorta el hueco o mete música o un efecto.", s))
    if expected and abs(duration - expected) > 0.6:
        issues.append(_issue("warn", "duration", f"El MP4 dura {duration:.1f} s y la composición {expected:.1f} s.",
                             "Vuelve a renderizarlo."))
    cuts = data["cuts"]
    bounds = [0.0] + cuts + [duration]
    longest = max((b - a for a, b in zip(bounds, bounds[1:])), default=duration)
    if not scene_based and duration > 20 and longest > 12:
        issues.append(_issue("info", "long_take", f"Hay un plano de {longest:.0f} s sin cortes.",
                             "Un zoom o un corte a mitad mantiene la atención.",
                             next(a for a, b in zip(bounds, bounds[1:]) if b - a == longest)))
    metrics = {"lufs": data["lufs"], "peak": data["peak"], "real_cuts": len(cuts),
               "real_avg_shot": round(duration / (len(cuts) + 1), 2), "real_longest_shot": round(longest, 2)}
    return issues, metrics


def score(issues: list[dict]) -> tuple[int, str]:
    value = max(0, 100 - sum(PENALTY.get(i["level"], 0) for i in issues))
    if any(i["level"] == "error" for i in issues):
        return value, "problema"
    return value, "revisar" if value < 75 else "bien"


def summarize(issues: list[dict], metrics: dict, **extra) -> dict:
    value, verdict = score(issues)
    order = {"error": 0, "warn": 1, "info": 2}
    issues = sorted(issues, key=lambda i: (order.get(i["level"], 3), i["at"] if i["at"] is not None else 1e9))
    counts = {lvl: sum(1 for i in issues if i["level"] == lvl) for lvl in order}
    return {"score": value, "verdict": verdict, "counts": counts, "issues": issues, "metrics": metrics,
            "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **extra}


def check_clip(comp: dict, video: Path | None, *, version: int = 0) -> dict:
    """Informe completo: composición + MP4 (si existe). Guarda la tira de fotogramas junto al vídeo."""
    plan = plan_check(comp)
    issues, metrics = list(plan["issues"]), dict(plan["metrics"])
    sheet = ""
    if video and video.exists():
        from .pipeline.media import probe
        info = probe(video)
        scene_based = bool(comp.get("scenes"))
        extra_issues, extra = render_issues(analyze_video(video), info["duration"], metrics["duration"], scene_based)
        issues += extra_issues
        metrics.update(extra, width=info["width"], height=info["height"])
        out = frame_sheet(video, info["duration"], video.parent / "frames.jpg")
        if out is not None and out.is_relative_to(DATA_DIR):
            sheet = "/media/" + out.relative_to(DATA_DIR).as_posix() + f"?v={version}"
    return summarize(issues, metrics, rendered=bool(video and video.exists()), sheet=sheet, version=version,
                     opening=plan["opening"])


def report_json(comp: dict, video: Path | None, version: int) -> str:
    """Informe para guardar en Clip.quality. Nunca rompe un render: si algo falla, se queda vacío."""
    try:
        report = check_clip(comp, video, version=version)
        return json.dumps(report, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        log.exception("Los filtros de calidad fallaron")
        return ""
