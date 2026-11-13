"""Puntos calientes de YouTube («Más reproducido»): la curva que YouTube dibuja sobre la barra del vídeo con las partes
que más se vuelven a ver. yt-dlp la da en el campo `heatmap` (unos 100 tramos con un valor de 0 a 1, donde 1 es el tramo
más repetido). Solo existe en vídeos con bastantes visualizaciones: en Shorts y vídeos pequeños suele faltar.

Es una señal real del público, gratis y sin API. Se guarda una vez por vídeo (lista vacía = «mirado, no hay») y se usa
como pista al buscar momentos y en las líneas de tiempo donde se marca a mano."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from urllib.parse import urlparse

log = logging.getLogger("clipping.heatmap")

FILE = "heatmap.json"
HOT = 1.15  # un tramo es «caliente» si se repite un 15 % más que la mediana de su entorno
WIN = 8  # tramos a cada lado para la mediana del entorno (de ~100 que da YouTube)
SKIP = 3  # el arranque del vídeo siempre es el máximo (todos lo ven): no cuenta


def is_youtube(url: str) -> bool:
    host = (urlparse((url or "").strip()).hostname or "").lower()
    return host in ("youtu.be", "youtube.com") or host.endswith(".youtube.com")


def from_info(info: dict | None) -> list[dict]:
    """Normaliza el `heatmap` de yt-dlp a [{s, e, v}] ordenado por tiempo."""
    out = []
    for h in (info or {}).get("heatmap") or []:
        try:
            s, e, v = float(h["start_time"]), float(h["end_time"]), float(h["value"])
        except (KeyError, TypeError, ValueError):
            continue
        if e > s:
            out.append({"s": round(s, 2), "e": round(e, 2), "v": round(max(0.0, min(1.0, v)), 3)})
    return sorted(out, key=lambda p: p["s"])


def save(path: Path, points: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"points": points}), encoding="utf-8")


def load(path: Path) -> list[dict] | None:
    """None si nunca se ha mirado; lista (quizá vacía) si sí."""
    try:
        return list(json.loads(path.read_text(encoding="utf-8")).get("points") or [])
    except (OSError, ValueError, AttributeError):
        return None


def fetch(url: str) -> list[dict]:
    """Pide solo los datos del vídeo (sin descargarlo). Para fuentes bajadas antes de existir esta función."""
    try:
        import yt_dlp

        from .download import js_options

        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True,
                               **js_options()}) as ydl:
            return from_info(ydl.extract_info(url, download=False))
    except Exception:  # noqa: BLE001 — sin conexión o vídeo retirado: simplemente no hay puntos calientes
        log.warning("No se pudo leer el «Más reproducido» de %s", url)
        return []


def ensure(path: Path, url: str = "") -> list[dict]:
    """Lo guardado; si no se ha mirado nunca y es de YouTube, se pide una vez y se guarda (aunque salga vacío)."""
    got = load(path)
    if got is not None:
        return got
    if not is_youtube(url):
        return []
    points = fetch(url)
    save(path, points)
    return points


def lifts(points: list[dict] | None) -> list[dict]:
    """Cuánto destaca cada tramo sobre lo que lo rodea: [{s, e, v, lift}], con lift = valor / mediana de ±WIN tramos.

    La curva real cae a lo largo del vídeo (la gente se va) y el principio casi siempre es el máximo (todos lo ven), así
    que el valor absoluto no sirve: un «punto caliente» es un bulto sobre la tendencia local. Medido en un vídeo real
    (dQw4w9WgXcQ): inicio 1,0 y luego de 0,42 a 0,1, con el estribillo como bulto de ~1,3× sobre su entorno."""
    pts = list(points or [])
    if len(pts) < 8:
        return []
    vs = [p["v"] for p in pts]
    out = []
    for i, p in enumerate(pts):
        if i < SKIP:
            continue
        win = sorted(vs[max(SKIP, i - WIN):i + WIN + 1])
        base = win[len(win) // 2]
        if base > 0.01:
            # Cima local: en una bajada continua (el final del arranque) ningún tramo supera a su vecino anterior.
            peak = vs[i] >= vs[i - 1] and (i + 1 >= len(vs) or vs[i] >= vs[i + 1])
            out.append({**p, "lift": round(p["v"] / base, 3), "peak": peak})
    return out


def hot_spots(points: list[dict] | None, limit: int = 8) -> list[dict]:
    """Bultos unidos: [{t, d, lift}] del que más destaca al que menos (sin contar el arranque del vídeo)."""
    spots: list[dict] = []
    for p in lifts(points):
        if p["lift"] < HOT:
            continue
        if spots and p["s"] - (spots[-1]["t"] + spots[-1]["d"]) <= 0.5:
            last = spots[-1]
            last["d"] = round(p["e"] - last["t"], 2)
            last["lift"] = max(last["lift"], p["lift"])
            last["peak"] = last["peak"] or p["peak"]
        else:
            spots.append({"t": p["s"], "d": round(p["e"] - p["s"], 2), "lift": p["lift"], "peak": p["peak"]})
    spots = [{k: v for k, v in x.items() if k != "peak"} for x in spots if x["peak"]]  # solo bultos con cima
    return sorted(spots, key=lambda x: -x["lift"])[:limit]


def heat_of(points: list[dict] | None, start: float, end: float) -> float:
    """Cuánto destaca el tramo más caliente que toca [start, end] (0 si ninguno)."""
    return max((x["lift"] for x in hot_spots(points, limit=1000) if x["t"] < end and x["t"] + x["d"] > start),
               default=0.0)


def prompt_block(points: list[dict] | None, start: float, end: float) -> str:
    """Líneas para el prompt de momentos: los tramos calientes de este bloque de la transcripción."""
    spots = sorted((x for x in hot_spots(points, limit=40) if start <= x["t"] < end), key=lambda x: x["t"])[:12]
    if not spots:
        return ""
    return ("YOUTUBE MOST-REPLAYED (real viewer data: stretches people rewound and rewatched more than the parts around "
            "them; +N% = how much more). This is the strongest evidence that a moment works — prefer moments that contain "
            "or end on these, but still cut on complete sentences:\n"
            + "\n".join(f"[{x['t']:.1f}-{x['t'] + x['d']:.1f}] +{round((x['lift'] - 1) * 100)}%" for x in spots))


def note(points: list[dict] | None, start: float, end: float) -> str:
    """Frase en español para el motivo del clip si coincide con un punto caliente."""
    lift = heat_of(points, start, end)
    if lift < HOT:
        return ""
    return f"🔥 Coincide con un punto caliente de YouTube (+{round((lift - 1) * 100)} % de repeticiones sobre su entorno)."
