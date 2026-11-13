"""Reencuadre horizontal → vertical 9:16 siguiendo la cara principal.

El encuadre no persigue la cara fotograma a fotograma (eso marea): se queda fijo y solo salta
cuando la cara se desplaza de forma sostenida, como haría un editor humano.
"""
from __future__ import annotations

from pathlib import Path

import logging

import cv2
import httpx
import numpy as np

from ..config import MODELS_DIR

log = logging.getLogger("clipping.reframe")
YUNET_MODEL = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
# Detector de caras YuNet (MIT, OpenCV Zoo). Se descarga solo la primera vez (~230 KB).
YUNET_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/"
             "face_detection_yunet_2023mar.onnx")


def ensure_yunet() -> bool:
    if YUNET_MODEL.exists():
        return True
    try:
        YUNET_MODEL.parent.mkdir(parents=True, exist_ok=True)
        log.info("Descargando el detector de caras YuNet…")
        r = httpx.get(YUNET_URL, follow_redirects=True, timeout=60)
        r.raise_for_status()
        tmp = YUNET_MODEL.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(YUNET_MODEL)
        return True
    except Exception:  # noqa: BLE001 — sin red se usa el detector de respaldo de OpenCV
        log.warning("No se pudo descargar YuNet; se usa el detector de respaldo", exc_info=True)
        return False
SAMPLE_FPS = 3
MIN_FACE_RATIO = 0.4  # por debajo de esto se usa el modo "fit" (vídeo completo sobre fondo desenfocado)


class FaceDetector:
    def __init__(self) -> None:
        self.yunet = None
        self.haar = None
        if hasattr(cv2, "FaceDetectorYN") and ensure_yunet():
            self.yunet = cv2.FaceDetectorYN.create(str(YUNET_MODEL), "", (320, 320), 0.7, 0.3, 5000)
        elif hasattr(cv2, "CascadeClassifier"):  # OpenCV 5 ya no lo trae: sin modelo, no se detectan caras
            self.haar = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    def detect(self, frame: np.ndarray) -> list[tuple]:
        """Devuelve caras (x, y, w, h, yaw) en coordenadas del fotograma original.

        yaw: hacia dónde mira la cara, a partir de ojos y nariz (YuNet). > 0 = mira hacia la derecha de la imagen,
        < 0 = hacia la izquierda, ~0 = de frente. None si el detector no da puntos de la cara (Haar).
        """
        h, w = frame.shape[:2]
        scale = 640 / w if w > 640 else 1.0
        small = cv2.resize(frame, (round(w * scale), round(h * scale))) if scale != 1.0 else frame
        out: list[tuple] = []
        if self.yunet is not None:
            self.yunet.setInputSize((small.shape[1], small.shape[0]))
            _, faces = self.yunet.detect(small)
            for f in faces if faces is not None else []:
                x_re, x_le, x_nose = float(f[4]), float(f[6]), float(f[8])
                eye_dist = abs(x_le - x_re)
                yaw = (x_nose - (x_re + x_le) / 2) / eye_dist if eye_dist > 1 else 0.0
                out.append((f[0] / scale, f[1] / scale, f[2] / scale, f[3] / scale, round(yaw, 3)))
        elif self.haar is not None:
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            for x, y, bw, bh in self.haar.detectMultiScale(gray, 1.1, 5, minSize=(30, 30)):
                out.append((x / scale, y / scale, bw / scale, bh / scale, None))
        return out


def _even(v: float) -> int:
    return int(v) // 2 * 2


def sample_faces(video: Path, start: float, end: float) -> tuple[list[float], list[list[tuple[float, float, float, float]]]]:
    """Muestrea el tramo y devuelve (tiempos relativos, cajas de todas las caras por muestra en píxeles)."""
    detector = FaceDetector()
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"OpenCV no puede abrir {video}")
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    times: list[float] = []
    faces: list[list[tuple[float, float, float, float]]] = []
    next_t = start
    try:
        while True:
            if not cap.grab():
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
            if t > end:
                break
            if t + 1e-3 < next_t:
                continue
            ok, frame = cap.retrieve()
            if not ok:
                break
            times.append(t - start)
            faces.append(detector.detect(frame))
            next_t += 1 / SAMPLE_FPS
    finally:
        cap.release()
    return times, faces


def biggest_centers(faces: list[list[tuple[float, float, float, float]]]) -> list[float | None]:
    """Centro x de la cara más grande de cada muestra (se toma como la de quien habla)."""
    out: list[float | None] = []
    for boxes in faces:
        b = max(boxes, key=lambda b: b[2] * b[3]) if boxes else None
        out.append(b[0] + b[2] / 2 if b else None)
    return out


def sample_face_centers(video: Path, start: float, end: float) -> tuple[list[float], list[float | None]]:
    times, faces = sample_faces(video, start, end)
    return times, biggest_centers(faces)


# ---------- Pantalla dividida ----------

def _panel_window(src_w: int, src_h: int, out_w: float, out_h: float) -> tuple[float, float]:
    """Tamaño (normalizado 0-1) del mayor recorte del original con el formato de un panel (zoom 1)."""
    aspect = out_w / out_h
    if src_w / src_h > aspect:
        return src_h * aspect / src_w, 1.0
    return 1.0, src_w / aspect / src_h


def _key(x: float, y: float, zoom: float) -> dict:
    return {"t": 0.0, "x": round(min(max(x, 0.0), 1.0), 4), "y": round(min(max(y, 0.0), 1.0), 4),
            "zoom": round(min(max(zoom, 1.0), 6.0), 3), "ease": "hold"}


def _norm(boxes: list[tuple], src_w: int, src_h: int) -> list[tuple]:
    """Caras normalizadas (0-1): (x, y, w, h, yaw)."""
    return [(b[0] / src_w, b[1] / src_h, b[2] / src_w, b[3] / src_h, b[4] if len(b) > 4 else None) for b in boxes]


# --- Gameplay + cámara ---

def find_webcam(faces: list[list[tuple]], src_w: int, src_h: int) -> dict | None:
    """Webcam superpuesta = una cara pequeña, fija y lejos del centro en al menos la mitad del clip."""
    n = len(faces)
    cams = []
    for boxes in faces:
        small = [b for b in _norm(boxes, src_w, src_h) if b[2] < 0.18]
        off_center = [b for b in small if abs(b[0] + b[2] / 2 - 0.5) > 0.17 or abs(b[1] + b[3] / 2 - 0.5) > 0.2]
        if off_center:
            cams.append(max(off_center, key=lambda b: b[2] * b[3])[:4])
    if not n or len(cams) < 0.5 * n:
        return None
    arr = np.array(cams)
    if float(np.std(arr[:, 0] + arr[:, 2] / 2)) > 0.05:  # se mueve por la pantalla: no es una webcam fija
        return None
    return {"cx": float(np.median(arr[:, 0] + arr[:, 2] / 2)), "cy": float(np.median(arr[:, 1] + arr[:, 3] / 2)),
            "fw": float(np.median(arr[:, 2])), "fh": float(np.median(arr[:, 3])), "ratio": len(cams) / n}


def find_overlay_rect(video: Path, start: float, end: float, cam: dict, src_w: int, src_h: int) -> tuple | None:
    """Busca los bordes del recuadro de la webcam alrededor de la cara (normalizado x0, y0, x1, y1).

    El borde del recuadro es una línea recta que aparece en todos los fotogramas, mientras que el juego cambia:
    se promedian los bordes de varios fotogramas y se buscan columnas y filas casi siempre presentes.
    """
    cap = cv2.VideoCapture(str(video))
    acc, count = None, 0
    try:
        for t in np.linspace(start, end, 12):
            cap.set(cv2.CAP_PROP_POS_MSEC, float(t) * 1000)
            ok, frame = cap.read()
            if not ok:
                continue
            edges = cv2.Canny(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), 60, 160).astype(np.float32) / 255
            edges = cv2.dilate(edges, np.ones((3, 3), np.uint8))  # tolera 1 px de vibración
            acc = edges if acc is None else acc + edges
            count += 1
    finally:
        cap.release()
    if acc is None or count < 4:
        return None
    persistent = (acc / count) > 0.85
    fx0, fx1 = int((cam["cx"] - cam["fw"] / 2) * src_w), int((cam["cx"] + cam["fw"] / 2) * src_w)
    fy0, fy1 = int((cam["cy"] - cam["fh"] / 2) * src_h), int((cam["cy"] + cam["fh"] / 2) * src_h)
    fw, fh = fx1 - fx0, fy1 - fy0

    def scan(positions, line) -> int | None:
        for pos in positions:
            if line(pos) > 0.8:
                return pos
        return None

    # Se mira solo la franja de la propia cara: el borde del recuadro la cruza entera, el contorno de la persona no
    # es una recta, y una franja más larga podría salirse del recuadro.
    rows = slice(max(0, fy0), min(src_h, fy1))
    cols = slice(max(0, fx0), min(src_w, fx1))
    left = scan(range(fx0 - 3, max(-1, fx0 - 4 * fw), -1), lambda c: persistent[rows, c].mean())
    right = scan(range(fx1 + 3, min(src_w, fx1 + 4 * fw)), lambda c: persistent[rows, c].mean())
    top = scan(range(fy0 - 3, max(-1, fy0 - 3 * fh), -1), lambda r: persistent[r, cols].mean())
    bottom = scan(range(fy1 + 3, min(src_h, fy1 + 4 * fh)), lambda r: persistent[r, cols].mean())
    # Un borde que no aparece suele ser el del propio vídeo (webcam pegada a la esquina).
    x0 = left if left is not None else (0 if cam["cx"] < 0.5 else None)
    x1 = right if right is not None else (src_w if cam["cx"] > 0.5 else None)
    y0 = top if top is not None else (0 if cam["cy"] < 0.5 else None)
    y1 = bottom if bottom is not None else (src_h if cam["cy"] > 0.5 else None)
    missing = [v is None for v in (x0, x1, y0, y1)]
    if sum(missing) == 1:
        # Un solo borde poco visible (p. ej. con poco contraste con el juego): se deduce con la proporción típica
        # de una webcam (16:9, 4:3 o cuadrada), la más ajustada que siga conteniendo la cara.
        for aspect in (16 / 9, 4 / 3, 1.0):
            if missing[3] and x0 is not None and x1 is not None and y0 is not None:
                cand = y0 + (x1 - x0) / aspect
                if fy1 <= cand <= src_h:
                    y1 = round(cand)
                    break
            elif missing[2] and x0 is not None and x1 is not None and y1 is not None:
                cand = y1 - (x1 - x0) / aspect
                if 0 <= cand <= fy0:
                    y0 = round(cand)
                    break
            elif missing[0] and x1 is not None and y0 is not None and y1 is not None:
                cand = x1 - (y1 - y0) * aspect
                if 0 <= cand <= fx0:
                    x0 = round(cand)
                    break
            elif missing[1] and x0 is not None and y0 is not None and y1 is not None:
                cand = x0 + (y1 - y0) * aspect
                if fx1 <= cand <= src_w:
                    x1 = round(cand)
                    break
    if None in (x0, x1, y0, y1):
        return None
    w, h = x1 - x0, y1 - y0
    if not (1.5 * fw <= w <= 8 * fw and 1.3 * fh <= h <= 8 * fh and 0.7 <= w / h <= 2.6):
        return None
    return x0 / src_w, y0 / src_h, x1 / src_w, y1 / src_h


def plan_gaming(cam: dict, rect: tuple | None, src_w: int, src_h: int, out_w: int = 1080, out_h: int = 1920) -> dict:
    """Webcam arriba a todo el ancho (el panel toma la proporción del recuadro) y gameplay abajo ajustado para que
    se vea la mayor parte de la escena (sin la webcam)."""
    detected = rect is not None
    if rect is None:  # sin bordes claros: recuadro 4:3 estimado alrededor de la cara
        w = 3.0 * cam["fw"]
        h = w * src_w / src_h * 3 / 4
        rect = (cam["cx"] - w / 2, cam["cy"] - h * 0.42, cam["cx"] + w / 2, cam["cy"] + h * 0.58)
    x0, y0, x1, y1 = rect
    rw, rh = (x1 - x0) * src_w, (y1 - y0) * src_h
    top_h = min(max(out_w * rh / rw / out_h, 0.2), 0.5)
    win_w, _ = _panel_window(src_w, src_h, out_w, out_h * top_h)
    cam_panel = {"y": 0.0, "h": round(top_h, 4), "label": "Cámara",
                 "keys": [_key((x0 + x1) / 2, (y0 + y1) / 2, win_w / (x1 - x0))]}
    # Gameplay "ajustado": se ve casi toda la escena (zoom 1,35 sobre el ajuste completo) con fondo desenfocado.
    zoom = 1.35
    panel_w, panel_h = out_w, out_h * (1 - top_h)
    scale = min(panel_w / src_w, panel_h / src_h) * zoom
    vis_w = min(1.0, panel_w / (src_w * scale))
    gx = min(0.5, x0 - vis_w / 2) if (x0 + x1) / 2 > 0.5 else max(0.5, x1 + vis_w / 2)
    gx = min(max(gx, vis_w / 2), 1 - vis_w / 2)
    game_panel = {"y": round(top_h, 4), "h": round(1 - top_h, 4), "label": "Gameplay", "fit": "contain",
                  "keys": [_key(gx, 0.5, zoom)]}
    how = "bordes del recuadro detectados" if detected else "recuadro estimado"
    return {"panels": [cam_panel, game_panel], "note": f"Webcam en el {round(100 * cam['ratio'])} % del clip ({how})"}


# --- Podcast: doble vista solo cuando dos personas se hablan ---

def duo_pair(boxes: list[tuple], src_w: int, src_h: int, single_crop_w: float) -> tuple | None:
    """Exactamente dos caras relevantes, separadas (no caben en un recorte vertical) y mirándose entre sí."""
    sig = [b for b in _norm(boxes, src_w, src_h) if b[2] >= 0.04]
    if len(sig) != 2:
        return None
    left, right = sorted(sig, key=lambda b: b[0])
    if (right[0] + right[2] / 2) - (left[0] + left[2] / 2) < single_crop_w * 0.8:
        return None
    ly, ry = left[4], right[4]
    if ly is not None and ry is not None:
        # El de la izquierda mira a la derecha y el de la derecha a la izquierda (o al menos ninguno mira hacia fuera).
        if ly - ry < 0.12 or ly < -0.1 or ry > 0.1:
            return None
    return left, right


def duo_panels(pairs: list[tuple], src_w: int, src_h: int, out_w: int, out_h: int) -> list[dict]:
    win_w, _ = _panel_window(src_w, src_h, out_w, out_h * 0.5)
    panels = []
    for i in range(2):
        b = np.median(np.array([p[i][:4] for p in pairs]), axis=0)
        # Plano medio: la ventana mide ~4,6 caras de ancho y la cara queda en el tercio superior del panel.
        panels.append({"y": 0.5 * i, "h": 0.5, "label": f"Persona {i + 1}",
                       "keys": [_key(float(b[0] + b[2] / 2), float(b[1] + b[3] * 0.62), win_w / (4.6 * float(b[2])))]})
    return panels


MIN_PART = 2.0  # s: tramos más cortos se funden con el vecino para que no haya saltos constantes


def plan_dynamic(times: list[float], faces: list[list[tuple]], src_w: int, src_h: int, duration: float,
                 out_w: int = 1080, out_h: int = 1920) -> list[dict] | None:
    """Trocea el clip en tramos de doble vista (dos personas hablándose) y de una sola vista (seguir cara).
    Devuelve None si en ningún momento compensa la doble vista."""
    single_w, _ = _panel_window(src_w, src_h, out_w, out_h)
    pairs = [duo_pair(b, src_w, src_h, single_w) for b in faces]
    raw = [p is not None for p in pairs]
    if not any(raw):
        return None
    # Mayoría en una ventana de ~1,7 s para que un fotograma suelto no cambie la vista.
    smooth = [sum(raw[max(0, i - 2):i + 3]) * 2 > len(raw[max(0, i - 2):i + 3]) for i in range(len(raw))]
    runs: list[list] = []  # [doble_vista, i0, i1]
    for i, state in enumerate(smooth):
        if runs and runs[-1][0] == state:
            runs[-1][2] = i
        else:
            runs.append([state, i, i])

    def bounds(r: list) -> tuple[float, float]:
        t0 = 0.0 if r[1] == 0 else (times[r[1] - 1] + times[r[1]]) / 2
        t1 = duration if r[2] == len(times) - 1 else (times[r[2]] + times[r[2] + 1]) / 2
        return t0, t1

    merged: list[list] = []
    for r in runs:
        t0, t1 = bounds(r)
        if merged and (t1 - t0 < MIN_PART or merged[-1][0] == r[0]):
            merged[-1][2] = r[2]
        else:
            merged.append(list(r))
    if len(merged) > 1:
        t0, t1 = bounds(merged[0])
        if t1 - t0 < MIN_PART:
            merged[1][1] = 0
            merged.pop(0)
    if not any(m[0] for m in merged):
        return None

    crop_w = _even(src_h * out_w / out_h)
    parts = []
    for state, i0, i1 in merged:
        t0, t1 = bounds([state, i0, i1])
        ok = [p for p in pairs[i0:i1 + 1] if p is not None]
        if state and ok:
            parts.append({"t0": round(t0, 3), "t1": round(t1, 3), "layout": "split", "keys": [],
                          "panels": duo_panels(ok, src_w, src_h, out_w, out_h),
                          "note": "Dos personas hablándose: doble vista"})
        else:
            sub_times = [t - t0 for t in times[i0:i1 + 1]]
            kf = plan_keyframes(sub_times, biggest_centers(faces[i0:i1 + 1]), crop_w, src_w)
            keys = [{"t": max(0.0, round(t, 3)), "x": round((x + crop_w / 2) / src_w, 4), "y": 0.5, "zoom": 1,
                     "ease": "hold"} for t, x in kf]
            parts.append({"t0": round(t0, 3), "t1": round(t1, 3), "layout": "crop", "keys": keys,
                          "note": "Una persona: seguir cara"})
    return parts


def plan_split(faces: list[list[tuple]], src_w: int, src_h: int, mode: str,
               out_w: int = 1080, out_h: int = 1920) -> dict | None:
    """Pantalla dividida para todo el clip sin leer el vídeo (gaming con recuadro estimado; dúo)."""
    if not faces or not src_w or not src_h:
        return None
    if mode == "gaming":
        cam = find_webcam(faces, src_w, src_h)
        return plan_gaming(cam, None, src_w, src_h, out_w, out_h) if cam else None
    if mode == "duo":
        single_w, _ = _panel_window(src_w, src_h, out_w, out_h)
        pairs = [p for p in (duo_pair(b, src_w, src_h, single_w) for b in faces) if p]
        ratio = len(pairs) / len(faces)
        if ratio < 0.6:
            return None
        return {"panels": duo_panels(pairs, src_w, src_h, out_w, out_h),
                "note": f"Dos personas hablándose en el {round(100 * ratio)} % del clip"}
    return None


def plan_keyframes(times: list[float], centers: list[float | None], crop_w: int, src_w: int) -> list[list[float]]:
    """Convierte centros de cara muestreados en pocos saltos de encuadre: [[t, x_izquierda], ...]."""
    filled = list(centers)
    last = None
    for i, c in enumerate(filled):  # rellena huecos hacia delante y luego hacia atrás
        if c is None:
            filled[i] = last
        else:
            last = c
    nxt = None
    for i in range(len(filled) - 1, -1, -1):
        if filled[i] is None:
            filled[i] = nxt
        else:
            nxt = filled[i]
    if not filled or filled[0] is None:
        return [[0.0, _even((src_w - crop_w) / 2)]]

    arr = np.array(filled, dtype=float)
    smooth = np.array([np.median(arr[max(0, i - 2):i + 3]) for i in range(len(arr))])

    def left(cx: float) -> int:
        return _even(min(max(cx - crop_w / 2, 0), src_w - crop_w))

    keyframes = [[0.0, left(smooth[0])]]
    current = smooth[0]
    pending = 0
    threshold = crop_w * 0.15
    for i in range(1, len(smooth)):
        if abs(smooth[i] - current) > threshold:
            pending += 1
            if pending >= 2:  # desplazamiento sostenido (~0,7 s)
                current = smooth[i]
                keyframes.append([round(times[i - 1], 3), left(current)])
                pending = 0
        else:
            pending = 0
    return keyframes


def keys_by_shot(times: list[float], centers: list[float | None], crop_w: int, src_w: int,
                 cuts: list[float] | None = None) -> list[list[float]]:
    """plan_keyframes plano a plano del original: en cada corte del original empieza un encuadre nuevo,
    calculado solo con lo que se ve después del corte."""
    bounds = [0.0, *sorted(c for c in (cuts or []) if c > 0)]
    out: list[list[float]] = []
    for n, a in enumerate(bounds):
        b = bounds[n + 1] if n + 1 < len(bounds) else float("inf")
        idx = [i for i, t in enumerate(times) if a <= t < b]
        if not idx:
            if out:
                out.append([round(a, 3), out[-1][1]])
            continue
        sub = plan_keyframes([times[i] - a for i in idx], [centers[i] for i in idx], crop_w, src_w)
        out += [[round(a + t, 3) if j else round(a, 3), x] for j, (t, x) in enumerate(sub)]
    return out or [[0.0, _even((src_w - crop_w) / 2)]]


def analyze(video: Path, start: float, end: float, src_w: int, src_h: int, mode: str = "auto",
            out_w: int = 1080, out_h: int = 1920, cuts: list[float] | None = None) -> dict:
    """Devuelve el encuadre normalizado (centro 0-1), válido para cualquier formato de salida (ver CropKey/Panel en
    frontend/src/remotion/schema.ts):
      {"mode": "face" | "fit", "keys"} · {"mode": "split", "panels", "note"} ·
      {"mode": "parts", "parts": [{"t0", "t1", "layout", "keys", "panels"?, "note"}]} (tramos que alternan vistas).

    cuts: cortes del original (segundos desde start): con «seguir cara» cada plano del original se encuadra aparte.
    mode: "auto"/"duo" (doble vista solo en los tramos con dos personas hablándose; el resto sigue la cara; si no hay
    caras, vídeo completo) · "face" · "gaming" (webcam arriba a todo el ancho, gameplay abajo).
    """
    crop_w = _even(src_h * 9 / 16)
    if crop_w >= src_w * 0.95:
        return {"mode": "fit", "keys": []}
    times, faces = sample_faces(video, start, end)
    if mode == "gaming":
        cam = find_webcam(faces, src_w, src_h)
        if not cam:
            return {"mode": "fit", "keys": [], "note": "No se detectó una webcam fija: se muestra el vídeo completo"}
        rect = find_overlay_rect(video, start, end, cam, src_w, src_h)
        return {"mode": "split", "keys": [], **plan_gaming(cam, rect, src_w, src_h, out_w, out_h)}
    if mode in ("duo", "auto"):
        parts = plan_dynamic(times, faces, src_w, src_h, end - start, out_w, out_h)
        if parts and len(parts) == 1:
            return {"mode": "split", "keys": [], "panels": parts[0]["panels"], "note": parts[0]["note"]}
        if parts:
            return {"mode": "parts", "keys": [], "parts": parts,
                    "note": f"{sum(p['layout'] == 'split' for p in parts)} tramos con doble vista"}
    centers = biggest_centers(faces)
    ratio = sum(c is not None for c in centers) / max(len(centers), 1)
    if mode in ("auto", "duo") and ratio < MIN_FACE_RATIO:
        return {"mode": "fit", "face_ratio": round(ratio, 2), "keys": []}
    keyframes = keys_by_shot(times, centers, crop_w, src_w, cuts)
    keys = [{"t": t, "x": round((x + crop_w / 2) / src_w, 4), "y": 0.5, "zoom": 1, "ease": "hold"} for t, x in keyframes]
    return {"mode": "face", "face_ratio": round(ratio, 2), "keys": keys}
