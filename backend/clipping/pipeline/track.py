"""seguimiento de un punto. SAM 2.1 (ml/track.py) sigue lo que marcas con un clic; aquí su recorrido se convierte
en puntos clave de encuadre: con margen (el objeto no se acerca al borde), suavizado y sin saltos raros."""
from __future__ import annotations

import math
from pathlib import Path


def crop_size(src_w: int, src_h: int, out_w: int, out_h: int, zoom: float) -> tuple[float, float]:
    """Ancho y alto del recorte en fracción del original (igual que cropRect / crop_rect)."""
    aspect = out_w / out_h
    if src_w / src_h > aspect:
        cw, ch = src_h * aspect, src_h
    else:
        cw, ch = src_w, src_w / aspect
    z = max(1.0, zoom)
    return cw / z / src_w, ch / z / src_h


def clean_path(path: list[list]) -> list[tuple[float, float, float] | None]:
    """[t, x, y, w, h] o [t, None] → (t, x, y) o None. Quita los saltos: SAM a veces se va a otro objeto en un corte
    del original (otro tamaño y otro sitio de golpe); eso cuenta como perdido hasta que vuelve cerca de donde estaba."""
    out: list[tuple[float, float, float] | None] = []
    last = None  # (x, y, área) del último punto bueno
    ref = 0.0  # área de los primeros fotogramas: el objeto puede acercarse o alejarse, pero no multiplicarse por 6
    firsts: list[float] = []
    for p in path:
        if len(p) < 5 or p[1] is None:
            out.append(None)
            continue
        t, x, y, w, h = p[:5]
        area = max(w * h, 1e-6)
        if last is not None:
            jump = math.hypot(x - last[0], y - last[1])
            ratio = area / last[2]
            drift = area / ref if ref else 1.0
            # Un objeto real no triplica su tamaño ni cruza media pantalla entre dos muestras seguidas
            if ratio > 3 or ratio < 1 / 3 or jump > max(0.15, 2 * math.sqrt(last[2])) or drift > 6 or drift < 1 / 6:
                out.append(None)
                continue
        last = (x, y, area)
        if len(firsts) < 5:
            firsts.append(area)
            ref = sorted(firsts)[len(firsts) // 2]
        out.append((t, x, y))
    return out


def _simplify(pts: list[tuple[float, float, float]], tol: float) -> list[tuple[float, float, float]]:
    """Ramer-Douglas-Peucker sobre (x, y) en función de t: los puntos clave justos para que la cámara no se desvíe
    más de `tol` del recorrido suavizado."""
    if len(pts) < 3:
        return pts
    t0, x0, y0 = pts[0]
    t1, x1, y1 = pts[-1]
    worst, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        t, x, y = pts[i]
        f = (t - t0) / max(t1 - t0, 1e-9)
        d = math.hypot(x - (x0 + (x1 - x0) * f), y - (y0 + (y1 - y0) * f))
        if d > worst:
            worst, idx = d, i
    if worst <= tol:
        return [pts[0], pts[-1]]
    return _simplify(pts[: idx + 1], tol)[:-1] + _simplify(pts[idx:], tol)


def follow_keys(path: list[list], t0: float, src_w: int, src_h: int, out_w: int, out_h: int, zoom: float = 1.0,
                margin: float = 0.25, smooth: float = 0.5, tol: float = 0.004) -> dict:
    """Puntos clave que mantienen el objeto en el encuadre a partir de `t0` (segundos del tramo).

    margin (0-0.45): parte del recorte, por cada lado, en la que el objeto no debe entrar; 0 = la cámara solo se mueve
    cuando el objeto llega al borde, 0.45 = lo lleva casi siempre centrado.
    smooth (0-1): inercia de la cámara; 0 = va pegada, 1 = muy lenta."""
    pts = clean_path(path)
    good = [p for p in pts if p is not None]
    if not good:
        return {"keys": [], "lost": 1.0, "until": t0}
    cw, ch = crop_size(src_w, src_h, out_w, out_h, zoom)
    m = min(max(margin, 0.0), 0.45)
    hx, hy = cw * (0.5 - m), ch * (0.5 - m)  # mitad de la zona en la que el objeto puede moverse sin mover la cámara

    def clampc(v: float, half: float) -> float:
        return min(max(v, half), 1 - half) if half < 0.5 else 0.5

    cx, cy = clampc(good[0][1], cw / 2), clampc(good[0][2], ch / 2)
    tx, ty = cx, cy
    s = min(max(smooth, 0.0), 1.0) * 0.95
    prev_t = good[0][0]
    cam: list[tuple[float, float, float]] = []
    for p in pts:
        if p is not None:
            t, px, py = p
            # La cámara (su objetivo) se mueve lo justo para que el objeto vuelva a la zona central
            if px > tx + hx:
                tx = px - hx
            elif px < tx - hx:
                tx = px + hx
            if py > ty + hy:
                ty = py - hy
            elif py < ty - hy:
                ty = py + hy
            tx, ty = clampc(tx, cw / 2), clampc(ty, ch / 2)
        else:
            t = prev_t + (path[1][0] - path[0][0] if len(path) > 1 else 0.1)
        a = 1 - s ** (max(t - prev_t, 1e-3) / 0.1) if s > 0 else 1.0
        cx += (tx - cx) * a
        cy += (ty - cy) * a
        prev_t = t
        cam.append((t, cx, cy))

    # Hasta el último fotograma en el que se vio el objeto: después, los planos que ya había se quedan como estaban
    last_seen = max(i for i, p in enumerate(pts) if p is not None)
    cam = cam[: last_seen + 1]
    keys = []
    for i, (t, x, y) in enumerate(_simplify(cam, tol)):
        keys.append({"t": round(t0 + t, 3), "x": round(x, 4), "y": round(y, 4), "zoom": round(zoom, 3),
                     "ease": "hold" if i == 0 else "linear"})
    lost = 1 - len(good) / len(pts)
    return {"keys": keys, "lost": round(lost, 3), "until": round(t0 + cam[-1][0], 3)}


def track_point(video: Path, start: float, end: float, point: tuple[float, float], fps: float = 10,
                on_progress=None) -> list[list]:
    """Recorrido del objeto que hay en `point` (0-1) en el segundo `start` del archivo, hasta `end`."""
    from .. import mlrun as ml

    result: dict = {}
    ml.run("track.py", {"items": [{"id": "p", "video": str(video), "start": start, "end": end,
                                   "point": [point[0], point[1]], "fps": fps}]},
           on_progress=on_progress, on_item=lambda it: result.update(it), timeout=900)
    return result.get("path") or []
