"""Librería de efectos de sonido (capa de enganche).

Cuatro orígenes, cada sonido con su licencia guardada en data/sfx/catalog.json:
- **Tu galería** (la carpeta de Ajustes › Sonidos): se importa a data/sfx/pack respetando las carpetas como categorías
  (las carpetas con número delante, p. ej. `00_Most_Used`, van primero). Cuando existe, es lo único que usan la IA
  del editor y los efectos automáticos.
- **Sintetizados aquí** (whoosh, pop, ding, boom…): generados con numpy la primera vez, 100 % propios.
- **Paquetes importados** (.zip o carpeta, p. ej. los CC0 de Kenney): se descargan a mano y se importan aquí.
- **Tuyos**: subidos desde el panel, con la licencia que indiques.

Cada sonido está en una carpeta (su categoría) y tiene intenciones (para qué sirve: transición, revelación,
impacto…); nombre, carpeta e intenciones se editan y se guardan aparte (data/sfx/edits.json), así reimportar la galería
no pierde los cambios. Cada carpeta puede tener sus intenciones por defecto y decidir si la IA la usa.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import threading
import unicodedata
import wave
import zipfile
from pathlib import Path

import numpy as np

from .config import DATA_DIR

log = logging.getLogger("clipping.sfx")
SFX_DIR = DATA_DIR / "sfx"
CATALOG = SFX_DIR / "catalog.json"
EDITS = SFX_DIR / "edits.json"
SR = 44100
AUDIO_EXT = (".wav", ".ogg", ".mp3", ".m4a")
_lock = threading.Lock()

# Intenciones: para qué sirve un sonido. La etiqueta sale en el panel y el uso (en inglés) lo lee la IA.
INTENTS: dict[str, tuple[str, str]] = {
    "transicion": ("Transición", "cuts, transitions, fast camera moves, things sliding in"),
    "aparicion": ("Aparición", "text, stickers, numbers or items appearing on screen"),
    "tension": ("Tensión antes de revelar", "build-up BEFORE a reveal or punchline"),
    "revelacion": ("Revelación / golpe final", "the reveal or punch moment, a twist"),
    "impacto": ("Impacto", "hard hit on a key word, number or shocking fact"),
    "humor": ("Humor", "funny, silly or awkward moments"),
    "acierto": ("Acierto / logro", "success, right answer, money, achievement"),
    "error": ("Error / fallo", "mistakes, wrong answers, fails"),
    "alarma": ("Alarma / urgencia", "warnings, countdowns, time pressure"),
    "reaccion": ("Reacción del público", "audience reactions: aww, applause, laughter, cheering"),
    "terror": ("Miedo / drama", "creepy, horror or dramatic moments"),
    "ambiente": ("Ambiente / objeto", "background or object sounds that match what is shown"),
    "meme": ("Meme", "popular meme/viral sounds: only when the moment matches the meme"),
}
# Intenciones por defecto según la categoría (palabras de su nombre)
CATEGORY_INTENTS = [
    (("más usados", "mas usados"), ["meme"]), (("whoosh", "transici", "swish"), ["transicion"]),
    (("riser", "tensión", "tension"), ["tension"]), (("drop", "giro"), ["revelacion"]),
    (("impact", "golpe", "boom"), ["impacto"]), (("pop", "aparici", "interfaz", "interface"), ["aparicion"]),
    (("alarm",), ["alarma"]), (("expresion", "reacci"), ["reaccion"]), (("papel", "objeto"), ["ambiente"]),
    (("terror", "drama"), ["terror"]), (("glitch", "digital", "sci-fi"), ["transicion"]), (("humor",), ["humor"]),
    (("acierto",), ["acierto"]), (("error",), ["error"]),
]


# ---------- Síntesis ----------

def _t(seconds: float) -> np.ndarray:
    return np.arange(int(SR * seconds)) / SR


def _noise(seconds: float, seed: int = 0) -> np.ndarray:
    return np.random.default_rng(seed).uniform(-1, 1, int(SR * seconds))


def _env(n: int, attack: float, release: float) -> np.ndarray:
    """Envolvente ataque/caída exponencial (en segundos)."""
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-np.maximum(t - attack, 0) / max(release, 1e-4))


def _bandpass(x: np.ndarray, freq: np.ndarray | float, q: float = 2.0) -> np.ndarray:
    """Biquad paso banda con frecuencia variable en el tiempo (bucle simple; solo se ejecuta una vez)."""
    freq = np.broadcast_to(np.asarray(freq, dtype=float), x.shape)
    out = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(len(x)):
        w0 = 2 * np.pi * min(freq[i], SR * 0.45) / SR
        alpha = np.sin(w0) / (2 * q)
        b0, a0, a1, a2 = alpha, 1 + alpha, -2 * np.cos(w0), 1 - alpha
        y = (b0 * x[i] - b0 * x2 - a1 * y1 - a2 * y2) / a0
        x2, x1, y2, y1 = x1, x[i], y1, y
        out[i] = y
    return out


def _lowpass(x: np.ndarray, cutoff: float) -> np.ndarray:
    k = 1 - np.exp(-2 * np.pi * cutoff / SR)
    out = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc += k * (v - acc)
        out[i] = acc
    return out


def _sweep(f0: float, f1: float, seconds: float, curve: float = 1.0) -> np.ndarray:
    """Seno con la frecuencia yendo de f0 a f1 (curve > 1: el cambio se concentra al final)."""
    t = _t(seconds)
    f = f0 + (f1 - f0) * (t / seconds) ** curve
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def _cat(*parts: np.ndarray, gap: float = 0.0) -> np.ndarray:
    silence = np.zeros(int(SR * gap))
    out: list[np.ndarray] = []
    for p in parts:
        out += [p, silence]
    return np.concatenate(out[:-1] if gap else out)


def _whoosh(rising: bool = True, seconds: float = 0.7, seed: int = 1) -> np.ndarray:
    n = int(SR * seconds)
    t = np.arange(n) / n
    f = 300 + 2600 * (t if rising else 1 - t) ** 1.5
    env = np.sin(np.pi * t) ** 2
    return _bandpass(_noise(seconds, seed), f, 1.4) * env * 3


def _pop() -> np.ndarray:
    s = _sweep(900, 180, 0.09, 0.5) * _env(int(SR * 0.09), 0.002, 0.03)
    return s + _noise(0.09, 3) * _env(int(SR * 0.09), 0.0005, 0.004) * 0.3


def _bell(freq: float, seconds: float = 1.4) -> np.ndarray:
    t = _t(seconds)
    tone = sum(a * np.sin(2 * np.pi * freq * r * t) for r, a in ((1, 1), (2.76, 0.45), (5.4, 0.25), (8.93, 0.1)))
    return tone * _env(len(t), 0.003, seconds / 4)


def _boom(seconds: float = 1.6) -> np.ndarray:
    n = int(SR * seconds)
    body = _sweep(85, 32, seconds, 0.4) * _env(n, 0.004, seconds / 3.5)
    hit = _lowpass(_noise(seconds, 5), 900) * _env(n, 0.001, 0.08) * 2.5
    return np.tanh((body + hit) * 1.8)


def _riser(seconds: float = 2.2) -> np.ndarray:
    n = int(SR * seconds)
    t = np.arange(n) / n
    tone = _sweep(180, 1800, seconds, 2.2) * 0.5
    air = _bandpass(_noise(seconds, 7), 400 + 5000 * t ** 2, 1.2) * 2
    return (tone + air) * t ** 2


def _scratch() -> np.ndarray:
    seconds = 0.55
    n = int(SR * seconds)
    t = np.arange(n) / SR
    f = 700 + 600 * np.sin(2 * np.pi * 7 * t) + 500 * (t / seconds)
    return _bandpass(_noise(seconds, 9), f, 3) * _env(n, 0.01, 0.25) * 5


def _glitch() -> np.ndarray:
    rng = np.random.default_rng(11)
    parts = []
    for _ in range(9):
        d = rng.uniform(0.02, 0.06)
        t = _t(d)
        kind = rng.integers(3)
        if kind == 0:
            p = np.sign(np.sin(2 * np.pi * rng.uniform(80, 900) * t))
        elif kind == 1:
            p = np.round(_noise(d, int(rng.integers(1000))) * 3) / 3
        else:
            p = np.zeros(len(t))
        parts.append(p * 0.6)
    return np.concatenate(parts)


def _click(freq: float = 3000, seconds: float = 0.03) -> np.ndarray:
    return _bandpass(_noise(seconds, 13), freq, 2) * _env(int(SR * seconds), 0.0005, 0.006) * 6


def _thump(freq: float = 55) -> np.ndarray:
    return _sweep(freq * 1.6, freq, 0.18, 0.5) * _env(int(SR * 0.18), 0.003, 0.05)


def _saw_chord(freqs: list[float], seconds: float) -> np.ndarray:
    t = _t(seconds)
    saw = sum(2 * ((f * t) % 1) - 1 for f in freqs) / len(freqs)
    return _lowpass(saw, 700) * _env(len(t), 0.02, seconds / 2.5) * 2.5


def _boing() -> np.ndarray:
    seconds = 0.7
    t = _t(seconds)
    f = 220 + 160 * np.exp(-t * 4) * np.sin(2 * np.pi * 9 * t)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * _env(len(t), 0.005, 0.25)


def _sparkle() -> np.ndarray:
    rng = np.random.default_rng(17)
    out = np.zeros(int(SR * 1.0))
    for i in range(12):
        f = rng.uniform(2500, 6000)
        b = _bell(f, 0.35) * 0.25
        start = int(SR * i * 0.06)
        out[start:start + len(b)] += b[: len(out) - start]
    return out


def _tones(freqs: list[float], step: float = 0.13) -> np.ndarray:
    return _cat(*[np.sin(2 * np.pi * f * _t(step)) * _env(int(SR * step), 0.005, step / 2) for f in freqs])


def _typing() -> np.ndarray:
    rng = np.random.default_rng(23)
    out = np.zeros(int(SR * 1.2))
    t = 0.0
    while t < 1.1:
        c = _click(rng.uniform(1800, 4200), 0.025) * rng.uniform(0.4, 0.8)
        i = int(t * SR)
        out[i:i + len(c)] += c[: len(out) - i]
        t += rng.uniform(0.06, 0.16)
    return out


def _cash() -> np.ndarray:
    ring = _bell(2093, 0.6) * 0.6
    second = _bell(2637, 0.5) * 0.5
    ring[int(SR * 0.1):int(SR * 0.1) + len(second)] += second[: len(ring) - int(SR * 0.1)]
    return _cat(_click(2500, 0.04), ring, gap=0.05)


def _drumroll() -> np.ndarray:
    rng = np.random.default_rng(29)
    out = np.zeros(int(SR * 1.6))
    for i in range(48):
        h = _lowpass(_noise(0.05, int(rng.integers(999))), 2500) * _env(int(SR * 0.05), 0.001, 0.015) * (0.4 + i / 70)
        s = int(SR * i * 0.031)
        out[s:s + len(h)] += h[: len(out) - s]
    return np.concatenate([out, _boom(0.8) * 0.8])


SYNTH: dict[str, tuple[str, str, callable]] = {
    # id: (nombre, categoría, generador)
    "whoosh": ("Whoosh", "Transición", lambda: _whoosh(True)),
    "whoosh_down": ("Whoosh hacia abajo", "Transición", lambda: _whoosh(False, 0.6, 2)),
    "swish_fast": ("Swish rápido", "Transición", lambda: _whoosh(True, 0.3, 4)),
    "pop": ("Pop", "Aparición", _pop),
    "bubble": ("Burbuja", "Aparición", lambda: _sweep(300, 1200, 0.12, 2) * _env(int(SR * 0.12), 0.005, 0.04)),
    "click": ("Clic", "Aparición", _click),
    "ding": ("Ding", "Acierto", lambda: _bell(1318)),
    "correct": ("Correcto", "Acierto", lambda: _tones([660, 990])),
    "wrong": ("Incorrecto", "Error", lambda: _tones([392, 262], 0.22)),
    "buzzer": ("Zumbador de error", "Error", lambda: np.sign(np.sin(2 * np.pi * 110 * _t(0.45))) * _env(int(SR * 0.45), 0.01, 0.3) * 0.5),
    "boom": ("Boom", "Impacto", _boom),
    "hit": ("Golpe seco", "Impacto", lambda: _boom(0.6)),
    "braam": ("Braam de tensión", "Tensión", lambda: _saw_chord([55, 82.4, 110], 2.6)),
    "dun_dun": ("Dun dun duuun", "Tensión", lambda: _cat(_saw_chord([98, 147], 0.35), _saw_chord([92.5, 139], 0.35), _saw_chord([87.3, 131], 1.6), gap=0.05)),
    "riser": ("Subida de tensión", "Tensión", _riser),
    "heartbeat": ("Latido", "Tensión", lambda: _cat(_thump(), _thump(48), np.zeros(int(SR * 0.45)), _thump(), _thump(48), gap=0.12)),
    "tick_tock": ("Tic tac", "Tensión", lambda: _cat(*[_click(f, 0.03) for f in (3500, 2500, 3500, 2500)], gap=0.47)),
    "drumroll": ("Redoble", "Tensión", _drumroll),
    "record_scratch": ("Rayado de disco", "Giro", _scratch),
    "glitch": ("Glitch", "Giro", _glitch),
    "boing": ("Boing", "Humor", _boing),
    "sparkle": ("Brillo mágico", "Humor", _sparkle),
    "camera": ("Cámara de fotos", "Objeto", lambda: _cat(_click(2000, 0.04), _click(1200, 0.06), gap=0.06)),
    "typing": ("Teclado", "Objeto", _typing),
    "cash": ("Caja registradora", "Objeto", _cash),
}


def _write_wav(path: Path, x: np.ndarray) -> float:
    x = np.asarray(x, dtype=float)
    peak = float(np.max(np.abs(x))) or 1.0
    x = x / peak * 0.89  # -1 dBFS
    fade = min(len(x), int(SR * 0.005))
    if fade:
        x[-fade:] *= np.linspace(1, 0, fade)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype(np.int16).tobytes())
    return round(len(x) / SR, 2)


# ---------- Catálogo ----------

def _load() -> list[dict]:
    if CATALOG.exists():
        try:
            return json.loads(CATALOG.read_text(encoding="utf-8"))
        except Exception:
            log.exception("catalog.json de sonidos no válido; se regenera")
    return []


def _save(items: list[dict]) -> None:
    SFX_DIR.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")


def _url(path: Path) -> str:
    return "/media/sfx/" + path.relative_to(SFX_DIR).as_posix()


def ensure_library() -> list[dict]:
    """Genera los sonidos sintetizados que falten y quita del catálogo los archivos borrados a mano."""
    with _lock:
        items = [i for i in _load() if (SFX_DIR / i["file"]).exists()]
        have = {i["id"] for i in items}
        changed = len(items) != len(_load())
        for sid, (name, category, gen) in SYNTH.items():
            if sid in have:
                continue
            path = SFX_DIR / "synth" / f"{sid}.wav"
            duration = _write_wav(path, gen())
            items.append({"id": sid, "name": name, "category": category, "file": path.relative_to(SFX_DIR).as_posix(),
                          "duration": duration, "license": "Propio (sintetizado localmente)", "source": "synth"})
            changed = True
        if changed:
            _save(items)
        return items


def _order(i: dict) -> tuple:
    """Tu galería primero (por el número de su carpeta: 00_Most_Used arriba), luego el resto."""
    return (i.get("source") != "pack", i.get("category_order", 999), i.get("category", ""), i.get("name", "").lower())


def catalog() -> list[dict]:
    """Todos los sonidos con tus cambios de nombre, carpeta e intenciones aplicados."""
    edits = _edits()
    base = ensure_library()
    orders = {i["category"]: i.get("category_order", 999) for i in base if i.get("category_order") is not None}
    out = []
    for i in base:
        ov = edits["sounds"].get(i["id"], {})
        item = {**i, **{k: v for k, v in ov.items() if k in ("name", "category")}, "url": _url(SFX_DIR / i["file"])}
        if ov.get("category") and ov["category"] != i["category"]:
            item["category_order"] = orders.get(ov["category"], i.get("category_order", 999))
        folder = edits["folders"].get(item["category"], {})
        item["intents"] = ov.get("intents") or i.get("intents") or (
            folder["intents"] if "intents" in folder else default_intents(item["category"]))
        item["edited"] = bool(ov)
        out.append(item)
    return sorted(out, key=_order)


def get(sid: str) -> dict | None:
    return next((i for i in catalog() if i["id"] == sid), None)


def _duration(path: Path) -> float:
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / w.getframerate(), 2)
    try:
        from .pipeline.media import probe_audio_duration
        return probe_audio_duration(path)
    except Exception:
        return 0.0


def _slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()  # «Más» → «mas»
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:50] or "sonido"


def add_file(src: Path, name: str, category: str, license_note: str, source: str = "own", extra: dict | None = None) -> dict:
    """Sonido propio subido desde el panel (o traído de una web con su enlace, source «web:…»)."""
    with _lock:
        items = _load()
        base = _slug(name)
        sid, n = f"own_{base}", 1
        while any(i["id"] == sid for i in items):
            n += 1
            sid = f"own_{base}_{n}"
        dest = SFX_DIR / "own" / f"{sid}{src.suffix.lower()}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        item = {"id": sid, "name": name.strip()[:60] or sid, "category": category.strip()[:30] or "Propios",
                "file": dest.relative_to(SFX_DIR).as_posix(), "duration": _duration(dest),
                "license": license_note.strip()[:200], "source": source, **(extra or {})}
        items.append(item)
        _save(items)
        return {**item, "url": _url(dest)}


def delete(sid: str) -> None:
    with _lock:
        items = _load()
        item = next((i for i in items if i["id"] == sid), None)
        if not item:
            raise KeyError(sid)
        if item["source"] == "synth":
            raise ValueError("Los sonidos sintetizados se regeneran solos; no se pueden borrar.")
        (SFX_DIR / item["file"]).unlink(missing_ok=True)
        _save([i for i in items if i["id"] != sid])
        data = _edits()
        if data["sounds"].pop(sid, None) is not None:
            _save_edits(data)


def _pretty(stem: str) -> str:
    """impactMetal_heavy_002 → Impact metal heavy 2"""
    words = re.sub(r"([a-z])([A-Z])", r"\1 \2", stem).replace("_", " ").split()
    words = [w.lstrip("0") or "0" if w.isdigit() else w.lower() for w in words]
    return " ".join(words).capitalize()


KENNEY_LICENSE = "CC0 (Kenney.nl): uso libre, también comercial"


def _bundle_files(src: Path) -> tuple[str, list[tuple[str, bytes | Path]], str]:
    """(nombre del paquete, [(ruta relativa, contenido o archivo)], texto de la licencia si trae una)."""
    files: list[tuple[str, bytes | Path]] = []
    lic = ""
    if src.is_file() and src.suffix.lower() == ".zip":
        with zipfile.ZipFile(src) as z:
            for info in z.infolist():
                name = info.filename.replace("\\", "/")
                if info.is_dir() or any(p.startswith((".", "__MACOSX")) for p in name.split("/")):
                    continue
                if Path(name).suffix.lower() in AUDIO_EXT:
                    files.append((name, z.read(info)))
                elif Path(name).name.lower().startswith("license") and not lic:
                    lic = z.read(info).decode("utf-8", "replace")[:2000]
    elif src.is_dir():
        for path in sorted(src.rglob("*")):
            rel = path.relative_to(src).as_posix()
            if not path.is_file() or any(p.startswith(".") for p in rel.split("/")):
                continue
            if path.suffix.lower() in AUDIO_EXT:
                files.append((rel, path))
            elif path.name.lower().startswith("license") and not lic:
                lic = path.read_text(encoding="utf-8", errors="replace")[:2000]
    else:
        raise FileNotFoundError(f"No existe «{src}» o no es un .zip ni una carpeta.")
    return src.stem if src.is_file() else src.name, files, lic


def import_bundle(src: Path | str, category: str = "", license_note: str = "", label: str = "") -> dict:
    """Importa un paquete de sonidos (.zip o carpeta), p. ej. los CC0 de Kenney descargados a mano.

    Las subcarpetas del paquete (sin contar «Audio») se vuelven carpetas aquí; si no hay, todo va a «category». Los
    paquetes de Kenney se reconocen por su License.txt y llevan su licencia CC0; en el resto la licencia es obligatoria.
    """
    src = Path(str(src).strip().strip('"'))
    pack_name, files, lic_text = _bundle_files(src)
    if not files:
        raise RuntimeError("No hay sonidos (.wav, .ogg, .mp3 o .m4a) en el paquete.")
    name = label or pack_name
    kenney = "kenney" in lic_text.lower() or "kenney" in name.lower()
    license_note = license_note.strip() or (KENNEY_LICENSE if kenney else "")
    if not license_note:
        raise ValueError("Indica la licencia del paquete (por ejemplo «CC0, freesound.org/…»).")
    base_cat = category.strip()[:40] or (_pretty(re.sub(r"^kenney[_\- ]*", "", name, flags=re.I).replace("-", " ")) + (" (Kenney)" if kenney else ""))
    slug = _slug(name)
    source = f"kenney:{slug}" if kenney else f"import:{slug}"
    dest_dir = SFX_DIR / ("kenney" if kenney else "import") / slug
    added = skipped = 0
    with _lock:
        items = _load()
        have = {i["id"] for i in items}
        files_in = {i["file"] for i in items}
        for rel, data in files:
            parts = [p for p in rel.split("/")[:-1] if p.lower() not in ("audio", "sounds", "sfx", "ogg", "wav", "mp3", pack_name.lower())]
            cat = base_cat if not parts else f"{base_cat} · {_pretty(parts[-1])}"
            stem = Path(rel).stem
            dest = dest_dir / "/".join(_slug(p) for p in parts) / Path(rel).name if parts else dest_dir / Path(rel).name
            sid = f"{'kenney' if kenney else 'imp'}_{_slug(stem)}"
            if sid in have:
                sid = f"{sid}_{_slug(parts[-1]) if parts else slug}"
            if sid in have or dest.relative_to(SFX_DIR).as_posix() in files_in:
                skipped += 1  # ya importado (reimportar el mismo paquete no duplica)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(data, Path):
                shutil.copyfile(data, dest)
            else:
                dest.write_bytes(data)
            items.append({"id": sid, "name": _pretty(stem), "category": cat, "file": dest.relative_to(SFX_DIR).as_posix(),
                          "duration": _duration(dest), "license": license_note[:200], "source": source})
            have.add(sid)
            added += 1
        _save(items)
    return {"added": added, "skipped": skipped, "category": base_cat, "license": license_note[:200]}


# ---------- Carpetas, intenciones y nombres ----------

def _edits() -> dict:
    if EDITS.exists():
        try:
            data = json.loads(EDITS.read_text(encoding="utf-8"))
            return {"sounds": data.get("sounds") or {}, "folders": data.get("folders") or {}}
        except ValueError:
            log.exception("edits.json de sonidos no válido")
    return {"sounds": {}, "folders": {}}


def _save_edits(data: dict) -> None:
    SFX_DIR.mkdir(parents=True, exist_ok=True)
    EDITS.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def default_intents(category: str) -> list[str]:
    low = category.lower()
    for keys, intents in CATEGORY_INTENTS:
        if any(k in low for k in keys):
            return list(intents)
    return []


def _clean_intents(values) -> list[str]:
    return [v for v in dict.fromkeys(values or []) if v in INTENTS]


def edit_sound(sid: str, name: str | None = None, category: str | None = None, intents: list[str] | None = None) -> dict:
    """Cambia nombre, carpeta o intenciones de un sonido. Quitar las intenciones vuelve a las de su carpeta."""
    if not any(i["id"] == sid for i in _load()):
        raise KeyError(sid)
    with _lock:
        data = _edits()
        ov = data["sounds"].setdefault(sid, {})
        if name is not None:
            if not name.strip():
                raise ValueError("El nombre no puede quedar vacío")
            ov["name"] = name.strip()[:60]
        if category is not None:
            if not category.strip():
                raise ValueError("Indica la carpeta")
            ov["category"] = category.strip()[:40]
        if intents is not None:
            ov["intents"] = _clean_intents(intents)
            if not ov["intents"]:
                ov.pop("intents")
        _save_edits(data)
    return get(sid)


def edit_folder(category: str, rename: str | None = None, intents: list[str] | None = None,
                ai: bool | None = None) -> dict:
    """Renombra una carpeta (mueve sus sonidos), le pone intenciones por defecto o decide si la usa la IA."""
    members = [i for i in catalog() if i["category"] == category]
    if not members:
        raise KeyError(category)
    with _lock:
        data = _edits()
        folder = dict(data["folders"].pop(category, {}))
        target = category
        if rename is not None and rename.strip() and rename.strip() != category:
            target = rename.strip()[:40]
            for i in members:
                data["sounds"].setdefault(i["id"], {})["category"] = target
            folder = {**data["folders"].pop(target, {}), **folder}
        if intents is not None:
            folder["intents"] = _clean_intents(intents)
        if ai is not None:
            folder["ai"] = bool(ai)
        if folder:
            data["folders"][target] = folder
        _save_edits(data)
    return next(f for f in folders() if f["category"] == target)


def reset_sound(sid: str) -> dict:
    with _lock:
        data = _edits()
        data["sounds"].pop(sid, None)
        _save_edits(data)
    return get(sid)


def _ai_default(category_items: list[dict], has_pack: bool) -> bool:
    """Sin cambiar nada: con tu galería importada la IA solo usa la galería; sin ella, lo
    propio, lo sintetizado y lo generado."""
    src = category_items[0].get("source", "")
    if src == "gen" or src.startswith("web:"):  # lo hecho a medida y lo traído de Myinstants, siempre
        return True
    return src == "pack" if has_pack else src in ("synth", "own")


def folders() -> list[dict]:
    """Carpetas en el orden del catálogo, con su número de sonidos, intenciones y si las usa la IA."""
    items = catalog()
    has_pack = any(i.get("source") == "pack" for i in items)
    data = _edits()["folders"]
    groups: dict[str, list[dict]] = {}
    for i in items:
        groups.setdefault(i["category"], []).append(i)
    out = []
    for cat, members in groups.items():
        f = data.get(cat, {})
        intents = f.get("intents") if "intents" in f else default_intents(cat)
        out.append({"category": cat, "count": len(members), "intents": intents,
                    "ai": f["ai"] if "ai" in f else _ai_default(members, has_pack),
                    "use": members[0].get("use", ""), "sources": sorted({m["source"] for m in members})})
    return out


# ---------- Tu galería de sonidos ----------

# Etiqueta y uso de cada categoría según palabras de su carpeta. El uso (en inglés) lo lee la IA.
PACK_CATEGORIES = [
    (("most_used", "most used", "mas usados", "más usados"), "Más usados",
     "popular meme/viral sounds: pick by name, only when the moment matches the meme"),
    (("whoosh", "swoosh", "swish"), "Whoosh", "transitions, cuts, fast camera moves, text or images sliding in"),
    (("riser",), "Risers", "build-up BEFORE a reveal or punchline; it is placed so that it ENDS on the given moment"),
    (("drop",), "Drops", "the reveal/punch moment right after a build-up, a heavy beat drop or slow-motion moment"),
    (("impact", "hit", "boom"), "Impactos", "hard hit on a key word, number, punchline or shocking fact"),
    (("pop",), "Pops", "text, stickers, numbers or items appearing on screen"),
    (("alarm", "sirena", "siren"), "Alarmas", "warnings, countdowns, time pressure, something going wrong"),
    (("expresion", "reaction"), "Expresiones", "audience reactions: aww, applause, cheering, heavenly choir"),
    (("papel", "paper"), "Papel", "paper, notes, lists, documents, pages turning"),
    (("terror", "drama", "horror"), "Terror y drama", "creepy, dramatic, horror or shocking-twist moments"),
    (("glitch", "data", "electric"), "Glitch y electricidad", "tech, data, hacking, screens, glitch transitions"),
]
PACK_LICENSE = "Tu galería de sonidos. Revisa los derechos: algunos sonidos vienen de juegos, series o memes."
VIDEO_EXT = (".mp4", ".mov", ".webm")
PACK_EXT = AUDIO_EXT + VIDEO_EXT + (".aac", ".flac")
_CLEAN_NAME = re.compile(r"\s*\((?:MP3|M4A)_\d+K\)|\s*\(\s*By [^)]*\)|\s*-?\s*Sound Effect.*$", re.I)


def pack_category(folder: str) -> tuple[str, str, int]:
    """«00_Most_Used» → («Más usados», uso para la IA, 0). Sin número delante, va al final."""
    m = re.match(r"^\s*(\d+)[\s_\-.]*(.*)$", folder)
    order, rest = (int(m.group(1)), m.group(2)) if m else (999, folder)
    low = folder.lower().replace("-", "_")
    for keys, label, use in PACK_CATEGORIES:
        if any(k in low or k in low.replace("_", " ") for k in keys):
            return label, use, order
    label = re.sub(r"[_\-]+", " ", rest).strip().capitalize() or folder
    return label, "general sound effects of this kind", order


GENERIC_DIRS = {"audio", "sounds", "sonidos", "sfx", "ogg", "wav", "mp3", "m4a"}


def _pack_files(root: Path) -> list[tuple[str, Path]]:
    """Cada sonido con su carpeta original: la más cercana que no sea genérica («audio», «mp3»…). Así da igual si eliges
    la carpeta del pack o la de encima: no se aplanan sus carpetas. Nunca entra nada de la propia herramienta (data/)."""
    data = DATA_DIR.resolve()
    out = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if not path.is_file() or path.suffix.lower() not in PACK_EXT:
            continue
        if any(part.startswith(".") for part in rel.parts):
            continue  # .trashed-…, ocultos
        if path.resolve().is_relative_to(data):
            continue  # voces, vídeos y sonidos ya importados de la propia herramienta
        dirs = [d for d in rel.parts[:-1] if d.lower() not in GENERIC_DIRS]
        out.append((dirs[-1] if dirs else "Sueltos", path))
    return out


def _extract_audio(src: Path, dest: Path) -> None:
    """Los .mp4 del pack se guardan solo con su audio (.m4a)."""
    from .config import require_exe
    from .pipeline.media import NO_WINDOW
    proc = subprocess.run([require_exe("ffmpeg"), "-hide_banner", "-v", "error", "-y", "-i", str(src), "-vn",
                           "-c:a", "aac", "-b:a", "192k", str(dest)], capture_output=True, timeout=120,
                          creationflags=NO_WINDOW)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[-300:])


def import_pack(root: Path | str, keep_removed_files: bool = False) -> dict:
    """Copia (o actualiza) tu galería en data/sfx/pack. Los sonidos que ya no están en la carpeta se quitan.

    El id sale de la carpeta y el nombre del archivo: los vídeos ya montados siguen encontrando su sonido.
    """
    root = Path(root)
    if not root.is_dir():
        raise FileNotFoundError(f"No existe la carpeta «{root}».")
    files = _pack_files(root)
    if not files:
        raise RuntimeError("La carpeta no tiene sonidos (.mp3, .wav, .m4a, .ogg o .mp4).")
    added = updated = 0
    errors: list[str] = []
    with _lock:
        items = _load()
        old_pack = {i["id"]: i for i in items if i.get("source") == "pack"}
        others = [i for i in items if i.get("source") != "pack"]
        new_pack: list[dict] = []
        seen: set[str] = set()
        for folder, path in files:
            label, use, order = pack_category(folder)
            name = _CLEAN_NAME.sub("", path.stem).strip(" _-") or path.stem
            sid = base = f"pack_{_slug(label)}_{_slug(name)[:40]}"
            n = 1
            while sid in seen:
                n += 1
                sid = f"{base}_{n}"
            seen.add(sid)
            video = path.suffix.lower() in VIDEO_EXT
            dest = SFX_DIR / "pack" / _slug(folder) / f"{sid[5:]}{'.m4a' if video else path.suffix.lower()}"
            prev = old_pack.get(sid)
            stamp = f"{path.stat().st_size}:{int(path.stat().st_mtime)}"
            same = bool(prev and prev.get("stamp") == stamp and dest.exists())
            try:
                if not same:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    if video:
                        _extract_audio(path, dest)
                    else:
                        shutil.copyfile(path, dest)
                    added += prev is None
                    updated += prev is not None
            except Exception as exc:  # noqa: BLE001 - un archivo roto no para la importación
                errors.append(f"{folder}/{path.name}: {str(exc)[:120]}")
                seen.discard(sid)
                continue
            new_pack.append({"id": sid, "name": name[:60], "category": label, "category_key": folder,
                             "category_order": order, "use": use, "file": dest.relative_to(SFX_DIR).as_posix(),
                             "duration": prev["duration"] if same else _duration(dest),
                             "license": PACK_LICENSE, "source": "pack", "origin": str(path), "stamp": stamp})
        removed = [i for sid, i in old_pack.items() if sid not in seen]
        for i in removed if not keep_removed_files else []:
            (SFX_DIR / i["file"]).unlink(missing_ok=True)
        _save(others + new_pack)
    return {"added": added, "updated": updated, "removed": len(removed), "total": len(new_pack), "errors": errors[:20]}


def pack_summary() -> dict:
    items = sorted((i for i in _load() if i.get("source") == "pack"), key=_order)
    cats: dict[str, dict] = {}
    for i in items:
        c = cats.setdefault(i["category"], {"category": i["category"], "count": 0, "use": i.get("use", "")})
        c["count"] += 1
    return {"count": len(items), "categories": list(cats.values())}


def ai_sounds() -> list[dict]:
    """Sonidos que puede elegir la IA: los de las carpetas que la tienen activada (por defecto, solo tu galería si
    está importada; si no, los propios y sintetizados)."""
    allowed = {f["category"] for f in folders() if f["ai"]}
    return [i for i in catalog() if i["category"] in allowed]


def _intent_use(intents: list[str]) -> str:
    return "; ".join(INTENTS[k][1] for k in intents if k in INTENTS)


def ai_sound_list(per_category: int = 10, most_used: int = 60) -> str:
    """Lista para los prompts, agrupada por carpeta con su uso. «Más usados» entra casi entera. Los sonidos con
    intenciones distintas a las de su carpeta las llevan al lado."""
    groups: dict[str, list[dict]] = {}
    for i in ai_sounds():
        groups.setdefault(i["category"], []).append(i)
    folder_of = {f["category"]: f for f in folders()}
    edited = _edits()["folders"]
    lines = []
    for cat, items in groups.items():
        f = folder_of.get(cat, {})
        # Tus intenciones de carpeta mandan; si no, el uso de la galería y, si no, las intenciones por defecto
        use = (_intent_use(f.get("intents", [])) if "intents" in edited.get(cat, {}) else "") \
            or items[0].get("use", "") or _intent_use(f.get("intents", []))
        limit = most_used if cat == "Más usados" else per_category
        if len(items) > limit:
            # repartidos, no solo los primeros (p. ej. 81 glitches parecidos); los que tienen intención propia, siempre
            own = [i for i in items if i["intents"] != f.get("intents")]
            rest = [i for i in items if i not in own]
            step = len(rest) / max(limit - len(own), 1)
            items = own[:limit] + [rest[int(k * step)] for k in range(max(limit - len(own), 0)) if int(k * step) < len(rest)]
        lines.append(f"  [{cat}]" + (f" - use for: {use}" if use else ""))
        lines += [f"    {i['id']}: {i['name']} ({i['duration']:.1f}s)"
                  + (f" - for: {_intent_use(i['intents'])}" if i["intents"] != f.get("intents") and i["intents"] else "")
                  for i in items]
    return "\n".join(lines)


def start_at(snd: dict, at: float) -> float:
    """Cuándo empieza a sonar: un riser termina en «at» (la revelación); el resto empieza un pelín antes."""
    if "riser" in (snd.get("category_key", "") + snd.get("category", "")).lower():
        return round(max(0.0, at - float(snd.get("duration") or 0) + 0.15), 2)
    return round(max(0.0, at - 0.05), 2)


# ---------- Sincronización automática de tu galería ----------
# Cada SYNC_EVERY segundos se mira la carpeta del pack (Ajustes › sfx_pack_dir): si hay sonidos nuevos, cambiados o
# quitados, se vuelve a importar sola. Los archivos de los que ya no están se conservan en data/sfx (algún vídeo montado
# puede seguir usándolos); solo salen del catálogo.
SYNC_EVERY = 20
_sync_sig: str | None = None


def _pack_signature(root: Path) -> str:
    return "|".join(f"{p.relative_to(root).as_posix()}:{p.stat().st_size}:{int(p.stat().st_mtime)}" for _, p in _pack_files(root))


def sync_pack(force: bool = False) -> dict | None:
    """Importa la galería si ha cambiado desde la última vez. None = no había nada que hacer."""
    global _sync_sig
    from .config import load_settings
    folder = (load_settings().sfx_pack_dir or "").strip().strip('"')
    root = Path(folder) if folder else None
    if not root or not root.is_dir():
        return None
    sig = _pack_signature(root)
    if not force and sig == _sync_sig:
        return None
    first = _sync_sig is None
    _sync_sig = sig
    if first and not force:
        # Al arrancar: si el catálogo ya tiene justo estos archivos del pack, no se reimporta nada
        have = {i.get("origin") for i in _load() if i.get("source") == "pack"}
        if have == {str(p) for _, p in _pack_files(root)}:
            return None
    if not sig:
        return None  # carpeta vacía (¿desconectada?): no se vacía el catálogo por eso
    result = import_pack(root, keep_removed_files=True)
    log.info("Galería de sonidos sincronizada: %s", {k: v for k, v in result.items() if k != "errors"})
    return result


def start_sync() -> None:
    def loop() -> None:
        import time
        while True:
            try:
                sync_pack()
            except Exception:  # noqa: BLE001 — se reintenta en la siguiente vuelta
                log.exception("No se pudo sincronizar la galería de sonidos")
            time.sleep(SYNC_EVERY)
    threading.Thread(target=loop, name="sfx-sync", daemon=True).start()


# ---------- Buscar en la biblioteca antes de generar ----------
# Flujo: se pide un sonido con palabras («cristal rompiéndose»). Se busca en la biblioteca (tu galería y los paquetes
# importados); si no hay un buen candidato y es algo simple (whoosh, pop, ding, riser…) se sintetiza aquí al momento con
# la duración pedida y queda en la carpeta «Generados», etiquetado para reutilizarlo. No se usa ningún modelo de IA:
# lo concreto sale de paquetes de sonidos libres que importas tú.

GEN_CATEGORY = "Generados"
_STOP = {"de", "del", "la", "el", "los", "las", "un", "una", "unos", "y", "con", "en", "que", "se", "al", "a", "of", "the",
         "an", "and", "with", "in", "on", "sound", "sonido", "sonidos", "efecto", "effect", "sfx", "fx", "ruido", "noise"}
# español → inglés (los sonidos y las etiquetas suelen ir en inglés); se buscan las dos palabras. Claves sin tildes.
_SYN = {
    "golpe": "hit", "golpes": "hit", "punetazo": "punch", "explosion": "explosion", "cristal": "glass", "vidrio": "glass",
    "romper": "break", "rompiendose": "shatter", "roto": "break", "puerta": "door", "lluvia": "rain", "viento": "wind",
    "trueno": "thunder", "tormenta": "storm", "risa": "laugh", "risas": "laugh", "aplausos": "applause",
    "aplauso": "applause", "campana": "bell", "campanita": "bell", "disparo": "gunshot", "pasos": "footsteps",
    "paso": "footstep", "agua": "water", "fuego": "fire", "coche": "car", "motor": "engine", "perro": "dog", "gato": "cat",
    "telefono": "phone", "notificacion": "notification", "dinero": "money", "moneda": "coin", "monedas": "coin",
    "magia": "magic", "brillo": "sparkle", "correcto": "correct", "teclado": "keyboard", "camara": "camera",
    "latido": "heartbeat", "reloj": "clock", "alarma": "alarm", "sirena": "siren", "grito": "scream",
    "susurro": "whisper", "beso": "kiss", "espada": "sword", "papel": "paper", "pajaros": "birds", "multitud": "crowd",
    "publico": "crowd", "olas": "waves", "mar": "ocean", "caida": "fall", "salto": "jump", "zumbido": "buzz",
    "pitido": "beep", "subida": "riser", "redoble": "drumroll", "terror": "horror", "miedo": "scary",
    "deslizar": "slide", "golpeando": "hit",
}
_MODS = {"largo", "larga", "corto", "corta", "rapido", "lento", "suave", "fuerte", "grave", "agudo", "long", "short",
         "fast", "quick", "slow", "soft", "loud", "deep", "low", "high", "big", "small", "pequeno", "grande"}


def _norm(text: str) -> str:
    return unicodedata.normalize("NFKD", text.lower()).encode("ascii", "ignore").decode()


def _groups(text: str) -> list[set[str]]:
    """Palabras útiles de la petición; cada una con su traducción al inglés si la tiene (cuentan como una)."""
    out: list[set[str]] = []
    for raw in re.findall(r"[^\W_]+", text.lower()):
        w = _norm(raw)
        if len(w) < 2 or w in _STOP:
            continue
        g = {w} | ({_SYN[w]} if w in _SYN else set())
        if g not in out:
            out.append(g)
    return out


def query_tokens(text: str) -> list[str]:
    return list(dict.fromkeys(w for g in _groups(text) for w in sorted(g)))


def _item_words(item: dict) -> set[str]:
    text = " ".join(str(item.get(k) or "") for k in ("name", "category", "id", "tags"))
    return {w for w in re.findall(r"[a-z0-9]+", _norm(text).replace("_", " ")) if len(w) > 1}


def search(text: str, intent: str = "", duration: float = 0, limit: int = 5, items: list[dict] | None = None) -> list[dict]:
    """Candidatos de la biblioteca para una petición en palabras, con su nota (0-1). Las palabras de tamaño o fuerza
    («largo», «suave»…) no cuentan para buscar."""
    groups = [g for g in _groups(text) if not g & _MODS]
    if not groups:
        return []
    out = []
    for item in items if items is not None else catalog():
        have = _item_words(item)
        hit = 0.0
        for g in groups:
            if g & have:
                hit += 1
            elif any(len(w) >= 4 and any(len(h) >= 4 and (h.startswith(w) or w.startswith(h)) for h in have) for w in g):
                hit += 0.6
        score = hit / len(groups)
        if intent and intent in (item.get("intents") or []):
            score += 0.15
        d = float(item.get("duration") or 0)
        if duration >= 1.5 and d and not (0.5 * duration <= d <= 2.5 * duration):
            score -= 0.3  # se pidió un largo concreto y este no se parece: mejor hacerlo a medida
        if score > 0.2:
            out.append({**item, "score": round(min(score, 1.0), 2)})
    out.sort(key=lambda i: (-i["score"], i.get("source") != "pack"))
    return out[:limit]


GOOD_MATCH = 0.75  # desde aquí, se usa el de la biblioteca sin generar nada


def _pitch(x: np.ndarray, factor: float) -> np.ndarray:
    if abs(factor - 1) < 0.01:
        return x
    n = max(2, int(len(x) / factor))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)


def _repeat(unit: np.ndarray, seconds: float, every: float) -> np.ndarray:
    total = int(SR * seconds)
    out = np.zeros(total + len(unit))
    for s in range(0, total, int(SR * every)):
        out[s:s + len(unit)] += unit
    return out[:total]


def _beep(d: float) -> np.ndarray:
    d = d or 0.25
    return np.sin(2 * np.pi * 1000 * _t(d)) * _env(int(SR * d), 0.005, 0.02)


# tipo: (palabras que lo piden, generador con la duración pedida (0 = la suya) y una semilla, nombre, intención)
SYNTH_KINDS: dict[str, tuple] = {
    "whoosh": (("whoosh", "swoosh", "swish", "woosh", "zas"), lambda d, seed: _whoosh(True, d or 0.7, seed), "Whoosh", "transicion"),
    "riser": (("riser", "subida", "rise", "buildup"), lambda d, seed: _riser(d or 2.2), "Subida de tensión", "tension"),
    "boom": (("boom", "thud"), lambda d, seed: _boom(d or 1.6), "Boom", "impacto"),
    "pop": (("pop", "plop"), lambda d, seed: _pop(), "Pop", "aparicion"),
    "ding": (("ding", "bell", "campana", "campanita", "chime"), lambda d, seed: _bell(1318, d or 1.4), "Ding", "acierto"),
    "click": (("click", "clic", "tap"), lambda d, seed: _click(), "Clic", "aparicion"),
    "beep": (("beep", "pitido", "bip"), lambda d, seed: _beep(d), "Pitido", "alarma"),
    "heartbeat": (("heartbeat", "latido", "latidos"), lambda d, seed: _repeat(_cat(_thump(), _thump(48), gap=0.12), d or 2.0, 0.9),
                  "Latido", "tension"),
    "tick": (("tick", "tictac", "tic", "tac", "clock", "reloj", "ticking"), lambda d, seed: _repeat(_click(3000, 0.03), d or 2.0, 0.5),
             "Tic tac", "alarma"),
    "drumroll": (("drumroll", "redoble"), lambda d, seed: _drumroll(), "Redoble", "tension"),
    "glitch": (("glitch",), lambda d, seed: _glitch(), "Glitch", "transicion"),
    "typing": (("typing", "teclado", "tecleo", "keyboard", "tecleando"), lambda d, seed: _typing(), "Teclado", "ambiente"),
    "boing": (("boing",), lambda d, seed: _boing(), "Boing", "humor"),
    "sparkle": (("sparkle", "brillo", "destello", "twinkle"), lambda d, seed: _sparkle(), "Brillo mágico", "humor"),
    "braam": (("braam", "bwaaam"), lambda d, seed: _saw_chord([55, 82.4, 110], d or 2.6), "Braam", "tension"),
}


def synth_kind(text: str) -> str:
    """El tipo sintetizable si la petición es solo eso (con palabras de tamaño o fuerza); si pide algo más concreto
    («whoosh de una espada»), nada: eso lo hace mejor el modelo."""
    groups = [g for g in _groups(text) if not g & _MODS]
    if not groups:
        return ""
    for kind, (keys, *_rest) in SYNTH_KINDS.items():
        if all(g & set(keys) for g in groups):
            return kind
    return ""


def synthesize(text: str, duration: float = 0, name: str = "", intents: list[str] | None = None) -> dict | None:
    """Sonido simple hecho aquí al momento (numpy), con la duración y el tono que se piden. Va a «Generados»."""
    kind = synth_kind(text)
    if not kind:
        return None
    _keys, gen, label, intent = SYNTH_KINDS[kind]
    words = set(query_tokens(text))
    duration = max(0.0, min(30.0, float(duration or 0)))
    seed = sum(map(ord, text)) % 997 + int(duration * 10)
    x = gen(duration, seed)
    if words & {"grave", "deep", "low", "big", "grande"}:
        x = _pitch(x, 0.75)
    elif words & {"agudo", "high", "small", "pequeno"}:
        x = _pitch(x, 1.3)
    if words & {"suave", "soft"}:
        x = _lowpass(x, 3500)
    wav = SFX_DIR / "_tmp" / f"synth_{seed}.wav"
    _write_wav(wav, x)
    try:
        return add_generated(wav, name or label + (f" {duration:.1f} s" if duration else ""), intents or [intent],
                             "Propio (sintetizado localmente)", tags=text, extra={"engine": "synth", "prompt": text})
    finally:
        wav.unlink(missing_ok=True)


def add_generated(src: Path, name: str, intents: list[str], license_note: str, tags: str = "", extra: dict | None = None) -> dict:
    """Guarda un sonido sintetizado a medida en la carpeta «Generados», con sus intenciones y
    etiquetas para que la búsqueda y la IA lo encuentren la próxima vez."""
    with _lock:
        items = _load()
        base = _slug(name)
        sid, n = f"gen_{base}", 1
        while any(i["id"] == sid for i in items):
            n += 1
            sid = f"gen_{base}_{n}"
        dest = SFX_DIR / "gen" / f"{sid}{src.suffix.lower()}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        item = {"id": sid, "name": name.strip()[:60] or sid, "category": GEN_CATEGORY,
                "file": dest.relative_to(SFX_DIR).as_posix(), "duration": _duration(dest),
                "license": license_note[:200], "source": "gen", "intents": _clean_intents(intents),
                "tags": " ".join(query_tokens(tags))[:300], **(extra or {})}
        items.append(item)
        _save(items)
    return get(sid) or {**item, "url": _url(dest)}


def find_or_make(request: str, intent: str = "", duration: float = 0, name: str = "") -> dict:
    """Busca en la biblioteca y, si no hay uno bueno y es simple, lo sintetiza.
    Devuelve {"how": "library" | "synth" | "none", "sound": …, "candidates": [...]}."""
    found = search(request, intent, duration, limit=6)
    if found and found[0]["score"] >= GOOD_MATCH:
        return {"how": "library", "sound": found[0], "candidates": found}
    made = synthesize(request, duration, name, [intent] if intent else None)
    if made:
        return {"how": "synth", "sound": made, "candidates": found}
    return {"how": "none", "sound": None, "candidates": found}
