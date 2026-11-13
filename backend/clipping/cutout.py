"""Segmentación del editor: recortar el sujeto de un plano (SAM 2 en el entorno ml/) y seguir una cara o un
punto para pegarle una capa (YuNet + flujo óptico de OpenCV, en el propio backend)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

from . import editor_agent
from .config import CLIPS_DIR
from .pipeline import compose
from .pipeline.reframe import FaceDetector
from . import mlrun as ml

MAX_MATTE = 30.0  # segundos máximos de un recorte (SAM 2 guarda todo el tramo en memoria)
TRACK_FPS = 10  # muestras por segundo del recorrido
CANVAS = {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "16:9": (1920, 1080)}


def shot_at(comp: dict, t: float) -> tuple[str, dict] | None:
    """Plano visible en el instante t de la timeline: ("segment", tramo) o ("scene", escena). Las escenas van encima."""
    for sc in comp.get("scenes", []):
        if sc["start"] <= t < sc["start"] + sc["duration"] and sc.get("kind") != "graphic" and sc.get("src"):
            return "scene", sc
    hit = editor_agent.segment_at(comp, t)
    return ("segment", hit[0]) if hit else None


def make_matte(clip_id: int, comp: dict, at: float, query: str, on_progress=None) -> dict:
    """Recorta el sujeto del plano que se ve en `at`. Devuelve {target, id, matte} para guardarlo en ese plano."""
    shot = shot_at(comp, at)
    if not shot:
        raise ValueError("En ese momento no hay ningún plano con imagen que recortar")
    kind, item = shot
    path = editor_agent._media_path(item["src"])
    if not path or not path.exists():
        raise ValueError("No encuentro el archivo de ese plano")
    query = (query or "person").strip()[:80]
    if kind == "segment":
        start, end = float(item["src_in"]), float(item["src_out"])
        is_video = True
    else:
        start = 0.0
        end = float(item.get("video_duration") or item["duration"])
        is_video = item.get("kind") == "video"
    end = min(end, start + MAX_MATTE)
    key = hashlib.sha1(json.dumps([str(path), start, end, query]).encode()).hexdigest()[:10]
    out_dir = CLIPS_DIR / str(clip_id) / "mattes"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{item['id']}_{key}.{'webm' if is_video else 'png'}"
    if not out.exists():
        # Se escribe con otro nombre y se renombra al acabar: un recorte a medias nunca se reutiliza.
        part = out.with_name(f"part_{out.name}")
        job = {"id": item["id"], "out": str(part), "query": query}
        job.update({"video": str(path), "start": start, "end": end} if is_video else {"image": str(path)})
        try:
            ml.run("segment.py", {"items": [job]}, on_progress=on_progress, timeout=1800)
            part.replace(out)
        finally:
            part.unlink(missing_ok=True)
    return {"target": kind, "id": item["id"], "query": query, "partial": kind == "segment" and float(item["src_out"]) > end,
            "matte": {"src": f"/media/clips/{clip_id}/mattes/{out.name}", "src_in": round(start, 3)}}


# ---------- Seguimiento ----------

def _crop_at(keys: list[dict], t: float) -> dict:
    """Como cropAt de schema.ts."""
    return compose.crop_at(keys, t)


def _place(sw: float, sh: float, bw: float, bh: float, k: dict, cover: bool) -> tuple[float, float, float]:
    """(left, top, escala) del original dentro de una caja: recorte (cropRect) o encaje (containPlacement)."""
    z = max(1.0, float(k["zoom"]))
    if cover:
        if sw / sh > bw / bh:
            ch, cw = sh, sh * bw / bh
        else:
            cw, ch = sw, sw * bh / bw
        cw, ch = cw / z, ch / z
        left = min(max(k["x"] * sw - cw / 2, 0), sw - cw)
        top = min(max(k["y"] * sh - ch / 2, 0), sh - ch)
        s = bw / cw
        return -left * s, -top * s, s
    s = min(bw / sw, bh / sh) * z
    w, h = sw * s, sh * s
    place = lambda box, size, c: (box - size) / 2 if size <= box else min(0, max(box - size, box / 2 - c * size))
    return place(bw, w, k["x"]), place(bh, h, k["y"]), s


def to_canvas(seg: dict, src_t: float, px: float, py: float, out_w: int, out_h: int,
              panel: dict | None = None) -> tuple[float, float]:
    """Punto del original (píxeles) → lienzo (0-1) con el encuadre del tramo (o de su panel) en ese segundo."""
    local = src_t - seg["src_in"]
    if panel is not None:  # pantalla dividida: cada panel tiene su encuadre
        box_y, bh = panel["y"] * out_h, panel["h"] * out_h
        left, top, s = _place(seg["src_w"], seg["src_h"], out_w, bh, _crop_at(panel.get("keys") or [], local),
                              panel.get("fit") != "contain")
    else:
        box_y, bh = 0.0, out_h
        layout = seg.get("layout")
        left, top, s = _place(seg["src_w"], seg["src_h"], out_w, out_h,
                              _crop_at(seg.get("keys") or [], local) if layout == "crop" else {"x": 0.5, "y": 0.5, "zoom": 1},
                              layout == "crop")
    return (left + px * s) / out_w, (box_y + top + py * s) / out_h


def to_source(seg: dict, src_t: float, cx: float, cy: float, out_w: int, out_h: int,
              panel: dict | None = None) -> tuple[float, float]:
    """Inversa de to_canvas (es afín en cada instante)."""
    x0, y0 = to_canvas(seg, src_t, 0, 0, out_w, out_h, panel)
    x1, y1 = to_canvas(seg, src_t, 1000, 1000, out_w, out_h, panel)
    return (cx - x0) / ((x1 - x0) / 1000), (cy - y0) / ((y1 - y0) / 1000)


def track(comp: dict, start: float, end: float, mode: str, x: float, y: float) -> list[dict]:
    """Recorrido en el lienzo (t relativo a `start`) de la cara más cercana a (x, y) o del punto (x, y)."""
    hit = editor_agent.segment_at(comp, start)
    if not hit:
        raise ValueError("Seguir una cara o un punto solo funciona sobre vídeo")
    seg, src_t0 = hit
    path = editor_agent._media_path(seg["src"])
    if not path or not path.exists():
        raise ValueError("No encuentro el vídeo de ese tramo")
    out_w, out_h = CANVAS.get(comp.get("aspect", "9:16"), CANVAS["9:16"])
    rate = compose.avg_rate(seg)
    # Solo dentro del tramo: al cortar a otro plano, la capa se queda donde estaba.
    src_end = min(seg["src_out"], src_t0 + (end - start) * rate)
    cap = cv2.VideoCapture(str(path))
    cap.set(cv2.CAP_PROP_POS_MSEC, src_t0 * 1000)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, round(fps / TRACK_FPS))
    panels = seg.get("panels") if seg.get("layout") == "split" else None
    panel = next((p for p in panels or [] if p["y"] <= y < p["y"] + p["h"]), (panels or [None])[0])
    sx, sy = to_source(seg, src_t0, x, y, out_w, out_h, panel)
    detector = FaceDetector() if mode == "face" else None
    prev_gray, pt, path_out, n = None, np.array([[sx, sy]], np.float32), [], 0
    found_face = False
    while True:
        ok, frame = cap.read()
        t_src = src_t0 + n / fps
        if not ok or t_src > src_end:
            break
        if n % step == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if detector is not None:
                # Solo las caras que se ven en el lienzo (o en el panel): el original puede tener más fuera del encuadre.
                y0, y1 = (panel["y"], panel["y"] + panel["h"]) if panel else (0.0, 1.0)
                faces = [f for f in detector.detect(frame)
                         if (lambda c: 0 <= c[0] <= 1 and y0 <= c[1] <= y1)(
                             to_canvas(seg, t_src, f[0] + f[2] / 2, f[1] + f[3] / 2, out_w, out_h, panel))]
                if faces:
                    # La cara más cercana a la anterior (o al punto elegido, la primera vez).
                    fx, fy, fw, fh, _ = min(faces, key=lambda f: (f[0] + f[2] / 2 - pt[0][0]) ** 2 + (f[1] + f[3] / 2 - pt[0][1]) ** 2)
                    center = np.array([[fx + fw / 2, fy + fh / 2]], np.float32)
                    found_face, pt = True, center
                elif prev_gray is not None:  # sin cara en esta muestra: sigue el movimiento de la imagen
                    pt = _flow(prev_gray, gray, pt)
            elif prev_gray is not None:
                pt = _flow(prev_gray, gray, pt)
            else:
                pt = _corner(gray, pt)
            prev_gray = gray
            cx, cy = to_canvas(seg, t_src, float(pt[0][0]), float(pt[0][1]), out_w, out_h, panel)
            path_out.append({"t": round((t_src - src_t0) / rate, 3), "x": round(cx, 4), "y": round(cy, 4)})
        n += 1
    cap.release()
    if mode == "face" and not found_face:
        raise ValueError("No he encontrado ninguna cara en ese tramo")
    return _smooth(path_out)


LK = {"winSize": (41, 41), "maxLevel": 4, "criteria": (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)}


def _corner(gray: np.ndarray, pt: np.ndarray, r: int = 40) -> np.ndarray:
    """El punto con más textura cerca del elegido: en una zona lisa el flujo óptico resbala."""
    x, y = int(pt[0][0]), int(pt[0][1])
    h, w = gray.shape
    x0, y0 = max(0, x - r), max(0, y - r)
    found = cv2.goodFeaturesToTrack(gray[y0:min(h, y + r), x0:min(w, x + r)], 1, 0.05, 5)
    return np.array([[found[0][0][0] + x0, found[0][0][1] + y0]], np.float32) if found is not None else pt


def _flow(prev: np.ndarray, gray: np.ndarray, pt: np.ndarray) -> np.ndarray:
    """Flujo óptico con comprobación de ida y vuelta: si al volver no cae en el mismo sitio, el punto no se mueve."""
    p0 = pt.reshape(-1, 1, 2)
    p1, st1, _ = cv2.calcOpticalFlowPyrLK(prev, gray, p0, None, **LK)
    if p1 is None or st1[0][0] != 1:
        return pt
    back, st2, _ = cv2.calcOpticalFlowPyrLK(gray, prev, p1, None, **LK)
    if back is None or st2[0][0] != 1 or float(np.linalg.norm(back - p0)) > 2.0:
        return pt
    return p1.reshape(-1, 2)


def _smooth(path: list[dict], k: int = 2) -> list[dict]:
    """Media móvil corta: quita el temblor del detector sin retrasar el movimiento."""
    out = []
    for i, p in enumerate(path):
        win = path[max(0, i - k): i + k + 1]
        out.append({"t": p["t"], "x": round(sum(q["x"] for q in win) / len(win), 4),
                    "y": round(sum(q["y"] for q in win) / len(win), 4)})
    return out
