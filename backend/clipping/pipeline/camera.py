"""la pista de cámara entiende el vídeo original.

1. `source_cuts`: cortes, transiciones (fundidos) y zooms que ya trae el vídeo original. Cada uno pasa a ser un corte
   de la pista «Cámara» (un plano nuevo que se puede reencuadrar por separado), marcado distinto de los que añade la
   herramienta.
2. `follow_speaker`: la cámara sigue a quien habla. La diarización local (diarize.py) dice quién habla cuándo y el
   movimiento de la boca de cada cara (YuNet) dice qué cara es; si no hay diarización, solo la boca.
"""
from __future__ import annotations

import logging
import math
from pathlib import Path

import cv2
import numpy as np

from . import diarize, reframe

log = logging.getLogger(__name__)

SCAN_FPS = 10
KINDS = ("cut", "transition", "zoom")  # de más a menos fuerte: si caen juntos se queda el primero
MERGE = 0.4  # s: eventos más juntos se cuentan como uno
ZOOM_JUMP = math.log(1.06)  # zoom de golpe (punch-in del editor original)
ZOOM_STEP = 0.012  # zoom rápido: escala por paso (a 10 fps) mínima…
ZOOM_TOTAL = math.log(1.10)  # …y escala total del movimiento


def _frames(video: Path, start: float, end: float, fps: float, width: int):
    """(segundo relativo, fotograma reducido a `width` px de ancho) a `fps` por segundo."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"OpenCV no puede abrir {video}")
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    next_t = start
    try:
        while cap.grab():
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
            if t > end:
                break
            if t + 1e-3 < next_t:
                continue
            ok, frame = cap.retrieve()
            if not ok:
                break
            h, w = frame.shape[:2]
            if w > width:
                frame = cv2.resize(frame, (width, round(h * width / w)), interpolation=cv2.INTER_AREA)
            yield t - start, frame
            next_t += 1 / fps
    finally:
        cap.release()


class _Frame:
    __slots__ = ("t", "hist", "luma", "kp", "desc")

    def __init__(self, t: float, small: np.ndarray, gray: np.ndarray, orb, mask_small, mask) -> None:
        self.t = t
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        self.hist = cv2.calcHist([hsv], [0, 1], mask_small, [16, 8], [0, 180, 0, 256])
        cv2.normalize(self.hist, self.hist)
        self.luma = float(gray.mean())
        self.kp, self.desc = orb.detectAndCompute(gray, mask)


def _relation(a: _Frame, b: _Frame, matcher) -> tuple[float, float, float, int]:
    """(diferencia de color 0-1, parte de los puntos que encajan 0-1, log de la escala de a → b, puntos)."""
    dist = float(cv2.compareHist(a.hist, b.hist, cv2.HISTCMP_BHATTACHARYYA))
    n = min(len(a.kp), len(b.kp))
    if a.desc is None or b.desc is None or n < 8:
        return dist, 0.0, 0.0, n
    matches = matcher.match(a.desc, b.desc)
    if len(matches) < 8:
        return dist, 0.0, 0.0, n
    src = np.float32([a.kp[m.queryIdx].pt for m in matches])
    dst = np.float32([b.kp[m.trainIdx].pt for m in matches])
    m, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if m is None or inl is None:
        return dist, 0.0, 0.0, n
    scale = math.hypot(float(m[0, 0]), float(m[1, 0]))
    return dist, float(inl.sum()) / n, math.log(max(scale, 1e-3)), n


SAME = 0.25  # parte de los puntos que encajan: por encima, es la misma imagen (quizá movida o escalada)
OTHER = 0.12  # por debajo, otra imagen
MIN_KP = 30  # con menos puntos (imagen oscura o lisa) solo se mira el color


def _local(values: list[float], i: int, r: int = 10) -> float:
    near = values[max(0, i - r):i] + values[i + 1:i + 1 + r]
    return float(np.median(near)) if near else 0.0


def classify(steps: list[dict], duration: float) -> list[dict]:
    """Eventos a partir de las medidas entre fotogramas seguidos. Cada paso: {"t" (segundo del segundo fotograma),
    "dist" (color), "ratio" (puntos que encajan), "scale" (log), "kp", "luma"}. Separada de la lectura del vídeo para
    poder probarla. Un corte es un pico: cambia mucho más que lo que pasa alrededor (así el movimiento rápido o el
    vídeo oscuro y ruidoso no cuentan)."""
    dists = [st["dist"] for st in steps]
    scales = [abs(st["scale"]) for st in steps]
    n = len(steps)

    def calm(j: int) -> bool:
        """El paso j no cambia de imagen (fuera del tramo cuenta como tranquilo)."""
        return not 0 <= j < n or steps[j]["ratio"] >= SAME or steps[j]["dist"] < 0.12

    def near(values: list[float], i: int) -> float:
        return max([values[j] for j in (i - 1, i + 1) if 0 <= j < n] or [0.0])

    events: list[dict] = []
    for i, st in enumerate(steps):
        textured = st["kp"] >= MIN_KP
        # Un corte es un salto suelto: al menos uno de los vecinos es tranquilo y ninguno cambia tanto.
        # (En vídeo de acción en primera persona todo cambia a cada paso y eso no son cortes.)
        alone = (calm(i - 1) or calm(i + 1)) and st["dist"] > 1.5 * near(dists, i)
        if textured and st["ratio"] < OTHER and st["dist"] > 0.08 and alone:
            events.append({"t": st["t"], "kind": "cut", "i": i})
        elif not textured and st["dist"] > 0.35 and alone and st["dist"] > 2 * _local(dists, i):
            events.append({"t": st["t"], "kind": "cut", "i": i})
        elif (textured and st["ratio"] >= SAME and abs(st["scale"]) > ZOOM_JUMP and abs(st["scale"]) > 3 * near(scales, i)
              and abs(st["scale"]) > 3 * _local(scales, i)):
            events.append({"t": st["t"], "kind": "zoom", "i": i})

    # Zoom rápido: varios pasos seguidos escalando hacia el mismo lado con la misma imagen (no una cámara que anda).
    run: list[dict] = []

    def close_run() -> None:
        if len(run) >= 3 and abs(sum(s["scale"] for s in run)) > ZOOM_TOTAL:
            events.append({"t": run[0]["t"], "kind": "zoom"})

    for st in steps:
        moving = st["kp"] >= MIN_KP and st["ratio"] >= SAME * 0.8 and abs(st["scale"]) > ZOOM_STEP
        if moving and run and (st["scale"] > 0) == (run[-1]["scale"] > 0):
            run.append(st)
        else:
            close_run()
            run = [st] if moving else []
    close_run()

    # Transición (fundido encadenado): de 2 a 8 pasos seguidos sin encajar, con imagen estable antes y después.
    run_i: list[int] = []
    for k in range(n + 1):
        st = steps[k] if k < n else None
        mixing = st is not None and st["kp"] >= MIN_KP and st["ratio"] < OTHER and st["dist"] > 0.08
        if mixing:
            run_i.append(k)
            continue
        if 2 <= len(run_i) <= 8 and run_i[0] > 0 and k < n and calm(run_i[0] - 1) and calm(k):
            events[:] = [e for e in events if e.get("i") not in run_i]
            events.append({"t": steps[run_i[len(run_i) // 2]]["t"], "kind": "transition"})
        run_i = []

    # Fundido a negro: la luz cae casi a cero y vuelve.
    dark = [st for st in steps if st["luma"] < 12]
    if dark and any(st["luma"] > 40 for st in steps):
        groups: list[list[dict]] = [[dark[0]]]
        for st in dark[1:]:
            if st["t"] - groups[-1][-1]["t"] <= 0.25:
                groups[-1].append(st)
            else:
                groups.append([st])
        for g in groups:
            events.append({"t": g[len(g) // 2]["t"], "kind": "transition"})

    events = [e for e in events if 0.15 < e["t"] < duration - 0.15]
    events.sort(key=lambda e: e["t"])
    out: list[dict] = []
    for e in events:
        if out and e["t"] - out[-1]["t"] < MERGE:
            if KINDS.index(e["kind"]) < KINDS.index(out[-1]["kind"]):
                out[-1] = e
            continue
        out.append(e)
    return [{"t": round(e["t"], 3), "kind": e["kind"]} for e in out]


def _static_mask(grays: list[np.ndarray]) -> np.ndarray | None:
    """Zona que no cambia en todo el tramo (cabecera, marca de agua, bandas): fuera de la comparación. None si no hay
    o si casi todo está quieto (un plano fijo sin cortes)."""
    if len(grays) < 10:
        return None
    h, w = grays[0].shape
    small = np.stack([cv2.resize(g, (80, max(1, round(h * 80 / w)))) for g in grays]).astype(np.float32)
    static = small.std(axis=0) < 6
    frac = float(static.mean())
    if frac < 0.03 or frac > 0.85:
        return None
    return np.where(static, 0, 255).astype(np.uint8)


_cache: dict[tuple, list[dict]] = {}


def source_cuts(video: Path, start: float, end: float) -> list[dict]:
    """Cortes, transiciones y zooms del vídeo original en [start, end): [{"t" (segundos desde start), "kind"}].
    Se recuerdan por vídeo y tramo (marcar cortes y luego seguir a quien habla no vuelve a leer el vídeo)."""
    try:
        key = (str(video), round(start, 2), round(end, 2), video.stat().st_mtime)
    except OSError:
        key = None
    if key in _cache:
        return list(_cache[key])
    out = _scan(video, start, end)
    if key:
        if len(_cache) > 64:
            _cache.clear()
        _cache[key] = out
    return list(out)


def _scan(video: Path, start: float, end: float) -> list[dict]:
    frames = list(_frames(video, start, end, SCAN_FPS, 320))
    if len(frames) < 2:
        return []
    grays = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for _, f in frames]
    m80 = _static_mask(grays)
    h, w = grays[0].shape
    sh = max(1, round(h * 80 / w))
    mask = cv2.resize(m80, (w, h), interpolation=cv2.INTER_NEAREST) if m80 is not None else None
    orb = cv2.ORB_create(nfeatures=400)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    steps: list[dict] = []
    prev: _Frame | None = None
    for (t, f), g in zip(frames, grays):
        cur = _Frame(t, cv2.resize(f, (80, sh), interpolation=cv2.INTER_AREA), g, orb, m80, mask)
        if prev is not None:
            dist, ratio, scale, kp = _relation(prev, cur, matcher)
            steps.append({"t": t, "dist": dist, "ratio": ratio, "scale": scale, "kp": kp, "luma": cur.luma})
        prev = cur
    return classify(steps, end - start)


def absolute(cuts: list[dict], start: float) -> list[dict]:
    """Del segundo relativo al tramo al segundo del original (lo que guarda Segment.source_cuts)."""
    return [{"t": round(start + c["t"], 3), "kind": c["kind"]} for c in cuts]


def within(cuts: list[dict], src_in: float, src_out: float) -> list[dict]:
    """Los cortes del original (segundos del original) que caen dentro de un tramo."""
    return [c for c in cuts if src_in < c["t"] < src_out]


def safe_source_cuts(video: Path, start: float, end: float) -> list[dict]:
    """source_cuts sin romper nunca el proceso que lo llama (al crear un clip es un extra)."""
    try:
        return source_cuts(video, start, end)
    except Exception as exc:  # noqa: BLE001
        log.warning("No se pudieron leer los cortes del original de %s: %s", video, exc)
        return []


# ---------- Quién habla ----------

SPEAKER_FPS = 6
MIN_TURN = 1.0  # s: un turno más corto (un «sí», una risa) no mueve la cámara


def _mouth(frame: np.ndarray, f: np.ndarray, scale: float) -> np.ndarray | None:
    """Recorte gris normalizado de la boca a partir de las comisuras de YuNet (índices 10-13)."""
    rx, ry, lx, ly = (float(v) / scale for v in f[10:14])
    mw = max(abs(lx - rx), 4.0)
    cx, cy = (rx + lx) / 2, (ry + ly) / 2
    x0, x1 = int(cx - mw * 0.8), int(cx + mw * 0.8)
    y0, y1 = int(cy - mw * 0.45), int(cy + mw * 0.65)
    h, w = frame.shape[:2]
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    crop = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    crop = cv2.resize(crop, (32, 20), interpolation=cv2.INTER_AREA).astype(np.float32)
    return (crop - crop.mean()) / (crop.std() + 1e-3)


def _signature(frame: np.ndarray, box: tuple) -> np.ndarray | None:
    """Color de la cara y del torso (debajo de la cara): la misma persona se parece en planos distintos."""
    h, w = frame.shape[:2]
    x, y, bw, bh = box[0] * w, box[1] * h, box[2] * w, box[3] * h
    x0, x1 = int(max(0, x - 0.3 * bw)), int(min(w, x + 1.3 * bw))
    y0, y1 = int(max(0, y)), int(min(h, y + 3.0 * bh))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    hsv = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4], [0, 180, 0, 256, 0, 256])
    cv2.normalize(hist, hist)
    return hist


def sample_mouths(video: Path, start: float, end: float) -> tuple[list[float], list[list[dict]]]:
    """Caras de cada muestra con su boca: [{"box" (x, y, w, h normalizados), "mouth"}]."""
    det = reframe.FaceDetector()
    if det.yunet is None:
        raise RuntimeError(f"Falta el modelo de caras YuNet ({reframe.YUNET_MODEL.name} en {reframe.YUNET_MODEL.parent})")
    times: list[float] = []
    faces: list[list[dict]] = []
    for t, frame in _frames(video, start, end, SPEAKER_FPS, 10_000):
        h, w = frame.shape[:2]
        scale = 640 / w if w > 640 else 1.0
        small = cv2.resize(frame, (round(w * scale), round(h * scale))) if scale != 1.0 else frame
        det.yunet.setInputSize((small.shape[1], small.shape[0]))
        _, found = det.yunet.detect(small)
        row = []
        for f in found if found is not None else []:
            box = (float(f[0]) / scale / w, float(f[1]) / scale / h, float(f[2]) / scale / w, float(f[3]) / scale / h)
            row.append({"box": box, "mouth": _mouth(frame, f, scale), "sig": _signature(frame, box)})
        times.append(t)
        faces.append(row)
    return times, faces


def _tracks(times: list[float], faces: list[list[dict]], bounds: list[float]) -> list[dict]:
    """Agrupa las caras de cada plano del original por posición (en un plano la gente no se cambia de sitio).
    Devuelve pistas {"shot", "x", "box", "act": {i_muestra: movimiento de boca}}."""
    tracks: list[dict] = []
    last_mouth: dict[int, np.ndarray] = {}
    for i, (t, row) in enumerate(zip(times, faces)):
        shot = sum(1 for b in bounds if b <= t)
        for f in sorted(row, key=lambda f: -f["box"][2]):
            cx = f["box"][0] + f["box"][2] / 2
            near = [k for k, tr in enumerate(tracks) if tr["shot"] == shot and abs(tr["x"] - cx) < max(0.08, f["box"][2])]
            if near:
                k = min(near, key=lambda k: abs(tracks[k]["x"] - cx))
            else:
                tracks.append({"shot": shot, "x": cx, "boxes": [], "act": {}, "sigs": []})
                k = len(tracks) - 1
            tr = tracks[k]
            tr["boxes"].append(f["box"])
            if f.get("sig") is not None:
                tr["sigs"].append(f["sig"])
            tr["x"] = float(np.median([b[0] + b[2] / 2 for b in tr["boxes"]]))
            m = f["mouth"]
            if m is not None and k in last_mouth:
                tr["act"][i] = float(np.abs(m - last_mouth[k]).mean())
            if m is not None:
                last_mouth[k] = m
    for tr in tracks:
        tr["box"] = tuple(float(v) for v in np.median(np.array(tr["boxes"]), axis=0))
        tr["sig"] = np.mean(tr["sigs"], axis=0).astype(np.float32) if tr["sigs"] else None
        del tr["boxes"], tr["sigs"]
    # Caras sueltas (falsos positivos, alguien que cruza): fuera
    seen = {}
    for tr in tracks:
        seen[tr["shot"]] = max(seen.get(tr["shot"], 0), len(tr["act"]))
    return [tr for tr in tracks if len(tr["act"]) >= max(2, 0.25 * seen[tr["shot"]])]


SAME_PERSON = 0.35  # distancia de color (Bhattacharyya) por debajo de la cual dos pistas son la misma persona


def _people(tracks: list[dict]) -> list[int]:
    """Persona de cada pista: se juntan las que se parecen y no salen a la vez en el mismo plano."""
    person = [-1] * len(tracks)
    groups: list[list[int]] = []
    for k in sorted(range(len(tracks)), key=lambda k: -len(tracks[k]["act"])):
        sig = tracks[k]["sig"]
        best, dist = None, SAME_PERSON
        for g, members in enumerate(groups):
            if sig is None or any(tracks[m]["shot"] == tracks[k]["shot"] for m in members):
                continue
            d = min(float(cv2.compareHist(sig, tracks[m]["sig"], cv2.HISTCMP_BHATTACHARYYA))
                    for m in members if tracks[m]["sig"] is not None) if any(tracks[m]["sig"] is not None for m in members) else 1.0
            if d < dist:
                best, dist = g, d
        if best is None:
            groups.append([k])
            person[k] = len(groups) - 1
        else:
            groups[best].append(k)
            person[k] = best
    return person


def _turns_from_mouths(times: list[float], tracks: list[dict], duration: float) -> list[dict]:
    """Sin diarización: ventanas de 1 s, gana la cara que más mueve la boca. Cada pista es su propio «hablante»."""
    out: list[dict] = []
    t = 0.0
    while t < duration:
        idx = [i for i, x in enumerate(times) if t <= x < t + 1.0]
        best, score = None, 0.0
        for k, tr in enumerate(tracks):
            vals = [tr["act"][i] for i in idx if i in tr["act"]]
            if vals and float(np.mean(vals)) > score:
                best, score = k, float(np.mean(vals))
        if best is not None:
            if out and out[-1]["speaker"] == f"t{best}" and abs(out[-1]["end"] - t) < 1e-6:
                out[-1]["end"] = min(duration, t + 1.0)
            else:
                out.append({"start": t, "end": min(duration, t + 1.0), "speaker": f"t{best}"})
        t += 1.0
    return out


def plan_speakers(times: list[float], faces: list[list[dict]], turns: list[dict], cuts: list[float],
                  duration: float, src_w: int, src_h: int, out_w: int = 1080, out_h: int = 1920) -> dict | None:
    """Puntos de encuadre que siguen a quien habla. turns: [{"start", "end", "speaker"}] relativos al tramo; cuts:
    cortes del original (relativos). Devuelve {"keys", "speakers", "note"} o None si no hay caras."""
    bounds = sorted(c for c in cuts if 0 < c < duration)
    tracks = _tracks(times, faces, bounds)
    if not tracks:
        return None
    if not turns:
        turns = _turns_from_mouths(times, tracks, duration)
    names = {sp: f"Persona {n + 1}" for n, sp in enumerate(dict.fromkeys(t["speaker"] for t in sorted(turns, key=lambda t: t["start"])))}

    # Qué persona es cada hablante: la que más mueve la boca mientras habla él solo, comparada con lo que esa persona
    # la mueve siempre (una cara grande o que gesticula no gana siempre). Se suman las pruebas de todos los planos en
    # que sale esa persona (reconocida por su aspecto), así un plano dudoso no decide. Cada persona, un hablante.
    shots = [0.0, *bounds, duration]
    person = _people(tracks)
    single = [i for i, x in enumerate(times) if sum(1 for t in turns if t["start"] <= x < t["end"]) == 1]
    who = {i: next(t["speaker"] for t in turns if t["start"] <= times[i] < t["end"]) for i in single}
    evidence: dict[tuple[int, str], float] = {}
    for k, tr in enumerate(tracks):
        others = [j for j, o in enumerate(tracks) if o["shot"] == tr["shot"] and j != k]
        if not others:
            continue  # sola en el plano: no dice nada de quién habla
        act = tr["act"]
        base = float(np.mean(list(act.values()))) if act else 0.0
        if base <= 0:
            continue
        for sp in names:
            vals = [act[i] for i in act if who.get(i) == sp]
            if len(vals) >= 2:
                key = (person[k], sp)
                evidence[key] = evidence.get(key, 0.0) + (float(np.mean(vals)) / base - 1) * len(vals)
    speaker_person: dict[str, int] = {}
    used: set[int] = set()
    n_people = len(set(person))
    for score, (pp, sp) in sorted(((v, k) for k, v in evidence.items()), reverse=True):
        if sp in speaker_person or score <= 0 or (pp in used and len(used) < n_people):
            continue
        speaker_person[sp] = pp
        used.add(pp)
    face_of: dict[tuple[int, str], int] = {}
    for shot in range(len(shots) - 1):
        mine = [k for k, tr in enumerate(tracks) if tr["shot"] == shot]
        for sp in names:
            if len(mine) == 1:
                face_of[(shot, sp)] = mine[0]
            elif sp in speaker_person:
                hit = [k for k in mine if person[k] == speaker_person[sp]]
                if hit:
                    face_of[(shot, sp)] = hit[0]

    # Tramos: se parte en cada cambio de turno y en cada corte del original.
    marks = sorted({0.0, *bounds, *(x for t in turns for x in (t["start"], t["end"]) if 0 < x < duration)})
    pieces: list[dict] = []
    for a, b in zip(marks, [*marks[1:], duration]):
        if b - a < 1e-3:
            continue
        shot = sum(1 for x in bounds if x <= a)
        now = [t for t in turns if t["start"] <= a + 0.15 and a + 1e-3 < t["end"]]
        now.sort(key=lambda t: -t["start"])  # en un solape manda quien acaba de entrar (la interrupción)
        sp = now[0]["speaker"] if now else (pieces[-1]["speaker"] if pieces else None)
        k = face_of.get((shot, sp)) if sp else None
        if k is None and pieces and tracks[pieces[-1]["track"]]["shot"] == shot:
            k = pieces[-1]["track"]  # el que habla no sale o no se sabe: el encuadre sigue donde estaba
        if k is None:  # plano nuevo sin saber quién habla: la cara más grande
            mine = [k for k, tr in enumerate(tracks) if tr["shot"] == shot]
            if not mine:
                k = pieces[-1]["track"] if pieces else None
            else:
                k = max(mine, key=lambda k: tracks[k]["box"][2] * tracks[k]["box"][3])
        if k is None:
            continue
        pieces.append({"t0": a, "t1": b, "speaker": sp, "track": k, "forced": a in bounds})

    # Turnos cortos (un «sí», una risa) no mueven la cámara, salvo en un corte del original.
    merged: list[dict] = []
    for p in pieces:
        if merged and not p["forced"] and (p["t1"] - p["t0"] < MIN_TURN or p["track"] == merged[-1]["track"]):
            merged[-1]["t1"] = p["t1"]
            continue
        merged.append(dict(p))
    if not merged:
        return None

    win_w, _ = reframe._panel_window(src_w, src_h, out_w, out_h)
    keys = []
    for p in merged:
        x, y, w, h = tracks[p["track"]]["box"]
        cx = min(max(x + w / 2, win_w / 2), 1 - win_w / 2)
        key = {"t": round(p["t0"], 3), "x": round(cx, 4), "y": 0.5, "zoom": 1, "ease": "hold"}
        if p["speaker"] in names:
            key["label"] = names[p["speaker"]]
        keys.append(key)
    keys[0]["t"] = 0
    out = [keys[0]]
    for k in keys[1:]:  # mismo encuadre y misma persona: no es un corte
        if abs(k["x"] - out[-1]["x"]) < 0.01 and k.get("label") == out[-1].get("label") and k["t"] not in bounds:
            continue
        out.append(k)
    n = len(names)
    return {"keys": out, "speakers": n,
            "note": f"Sigue a quien habla ({n} {'persona' if n == 1 else 'personas'})" if n else "Sigue a quien habla"}


def follow_speaker(video: Path, start: float, end: float, src_w: int, src_h: int, cuts: list[float],
                   out_w: int = 1080, out_h: int = 1920) -> dict | None:
    """Diarización (si está instalada) + bocas → puntos de encuadre que siguen a quien habla."""
    turns: list[dict] = []
    how = "boca"
    if diarize.available():
        try:
            turns = diarize.turns(video, start, end)
            how = "voz y boca"
        except Exception as exc:  # noqa: BLE001
            log.warning("Diarización falló (%s): solo se mira la boca", exc)
    times, faces = sample_mouths(video, start, end)
    plan = plan_speakers(times, faces, turns, cuts, end - start, src_w, src_h, out_w, out_h)
    if plan:
        plan["how"] = how
    return plan
