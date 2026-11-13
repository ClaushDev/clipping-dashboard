"""Modelo por tarea, caché de respuestas y contador de llamadas.

Cada llamada al LLM declara su tarea (`complete_json(..., task="moments")`). Con Claude como proveedor, la tarea decide
el modelo (ID exacto) y el esfuerzo: las baratas van a Ollama (gratis, no gasta el límite de
Claude) y, si Ollama no está o falla, a Claude Haiku con aviso; el resto, a su recomendación o a lo que marques en
Ajustes. Con Ollama como proveedor se ignora la tabla.
"""
from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from ..config import DATA_DIR, Settings
from .base import LLMProvider
from .claude_code import ClaudeCodeProvider
from .ollama import OllamaProvider, sees_images

log = logging.getLogger(__name__)

# id → (nombre en el panel, nivel). Nivel «cheap»: lo puede hacer un modelo local o Haiku; «mid»: Sonnet.
TASKS: dict[str, tuple[str, str]] = {
    "punctuation": ("Restaurar puntuación de transcripciones", "cheap"),
    "score": ("Puntuar clips marcados", "cheap"),
    "moments": ("Buscar momentos en un vídeo largo", "mid"),
    "editor": ("Chat del editor", "mid"),
    "general": ("Otras", "mid"),
}

# modelos de Claude con su ID exacto (solo los actuales: Opus, Sonnet y Haiku 5.5). $ por millón de tokens
# (entrada, salida) en la API: con la suscripción se gasta cuota, no dinero, pero sirve para comparar.
# effort = admite --effort.
MODELS: dict[str, dict] = {
    "claude-opus-5-5": {"label": "Opus 5.5", "price": (4.0, 20.0), "effort": True,
                        "why": "El más capaz. Para vídeos largos y difíciles, si Sonnet se queda corto."},
    "claude-sonnet-5-5": {"label": "Sonnet 5.5", "price": (2.0, 10.0), "effort": True,
                          "why": "Buscar momentos y chat del editor. Casi nivel Opus a la mitad de precio."},
    "claude-haiku-5-5": {"label": "Haiku 5.5", "price": (0.10, 0.50), "effort": True,
                         "why": "Puntuación de transcripciones y puntuar clips cuando Ollama no está. Muy barato "
                                "y rápido."},
}
# Alias de familia (o un ID de una versión anterior) → ID actual de esa familia
FAMILY = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5",
          "haiku": "claude-haiku-5-5"}
FALLBACK = "claude-haiku-5-5"  # si Ollama no está o falla en una tarea barata
ROUTES = ("auto", "ollama", *MODELS, "default")

# Esfuerzo (--effort): cuánto piensa el modelo. tokens = gasto relativo frente a «high» para el consumo estimado.
EFFORTS: dict[str, dict] = {
    "low": {"label": "Bajo", "tokens": 0.6, "why": "Responde casi sin pensar. Puntuación y puntuar clips."},
    "medium": {"label": "Medio", "tokens": 0.8, "why": "Piensa un poco. Buscar momentos y chat del editor."},
    "high": {"label": "Alto", "tokens": 1.0, "why": "Piensa con calma. Vídeos largos o difíciles."},
    "xhigh": {"label": "Extra", "tokens": 1.35, "why": "Piensa mucho. Más lento y caro."},
    "max": {"label": "Máx", "tokens": 1.7, "why": "Sin límite. Lento y caro."},
}
# Recomendación por tarea: (modelo si va a Claude, esfuerzo, por qué). Lo barato va antes a Ollama (gratis).
RECOMMEND: dict[str, tuple[str, str, str]] = {
    "punctuation": ("claude-haiku-5-5", "low", "Poner comas y puntos a un texto: Ollama gratis; si no está, Haiku."),
    "score": ("claude-haiku-5-5", "low", "Puntuar es comparar: basta un modelo local."),
    "moments": ("claude-sonnet-5-5", "medium", "Leer transcripciones largas: Sonnet rinde y es barato."),
    "editor": ("claude-sonnet-5-5", "medium", "Chat rápido: Sonnet medio para no esperar."),
    "general": ("claude-sonnet-5-5", "medium", "Lo demás: Sonnet medio."),
}
# Lo creativo que pides a mano quieres que salga distinto si lo vuelves a pedir: no se lee de la caché en una
# petición del panel (sí en los trabajos de la cola, donde un reintento no debe volver a gastar).
CREATIVE = {"editor"}

CACHE_DIR = DATA_DIR / "llm_cache"
USAGE_FILE = DATA_DIR / "llm_usage.jsonl"
_lock = threading.Lock()

# Petición del dashboard en curso (la pone el middleware de api.py): {"fresh": bool, "cached": bool, "notes": []}
REQUEST: contextvars.ContextVar[dict | None] = contextvars.ContextVar("llm_request", default=None)


def recommended(task: str) -> str:
    tier = TASKS.get(task, TASKS["general"])[1]
    return "ollama" if tier == "cheap" else RECOMMEND.get(task, RECOMMEND["general"])[0]


def recommended_effort(task: str) -> str:
    return RECOMMEND.get(task, RECOMMEND["general"])[1]


def migrate_route(route: str) -> str:
    """Alias (`haiku`, `sonnet`, `opus`) o IDs de versiones anteriores → ID exacto de los modelos actuales."""
    if not route or route in MODELS or route in ("auto", "ollama", "default"):
        return route
    return next((m for fam, m in FAMILY.items() if fam in route.lower()), route)


def effort_for(task: str, model: str, settings: Settings) -> str:
    """Valor de --effort para esta tarea con este modelo de Claude ("" = no se pasa)."""
    if model in MODELS and not MODELS[model]["effort"]:
        return ""
    effort = (settings.llm_task_effort or {}).get(task) or recommended_effort(task)
    return effort if effort in EFFORTS else recommended_effort(task)


def effort_tokens(effort: str) -> float:
    """Gasto relativo frente a «high» («» = el esfuerzo por defecto del modelo, que se cuenta como alto)."""
    return EFFORTS.get(effort, EFFORTS["high"])["tokens"]


def price(model: str) -> tuple[float, float]:
    """$ por millón de tokens (entrada, salida) del modelo; acepta alias («opus») y el vacío (por defecto = Opus)."""
    model = migrate_route(model or "opus")
    if model in MODELS:
        return MODELS[model]["price"]
    return MODELS["claude-sonnet-5-5"]["price"]


# ---------- Ollama disponible ----------

_ollama_seen: dict[str, tuple[float, bool]] = {}


def ollama_available(settings: Settings) -> bool:
    """¿Responde Ollama y tiene el modelo? Se comprueba como mucho una vez por minuto."""
    key = f"{settings.ollama_url}|{settings.ollama_model}"
    hit = _ollama_seen.get(key)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    ok = False
    try:
        resp = httpx.get(f"{settings.ollama_url.rstrip('/')}/api/tags", timeout=1.5)
        names = {m.get("name", "") for m in resp.json().get("models", [])}
        want = settings.ollama_model
        ok = want in names or f"{want}:latest" in names or any(n.split(":")[0] == want for n in names)
    except Exception:  # noqa: BLE001 — no está abierto o no responde
        ok = False
    _ollama_seen[key] = (time.time(), ok)
    return ok


def resolve(task: str, base: str, settings: Settings, images: list[str] | None = None) -> tuple[str, str, str]:
    """(proveedor, modelo, aviso) para una tarea. proveedor = "ollama" | "claude"; modelo "" = el de por defecto."""
    if base == "ollama":
        return "ollama", settings.ollama_model, ""
    route = migrate_route((settings.llm_task_models or {}).get(task) or "auto")
    if route not in ROUTES:
        route = "auto"
    if route == "auto":
        route = recommended(task)
    if route == "ollama":
        if images and not sees_images(settings.ollama_url, settings.ollama_model):
            return "claude", FALLBACK, "El modelo de Ollama no ve imágenes: se usó Claude Haiku."
        if not ollama_available(settings):
            return "claude", FALLBACK, "Ollama no está abierto o no tiene el modelo: se usó Claude Haiku."
        return "ollama", settings.ollama_model, ""
    if route == "default":
        return "claude", migrate_route(settings.claude_model), ""
    return "claude", route, ""


def _make(kind: str, model: str, settings: Settings, effort: str = "") -> LLMProvider:
    if kind == "ollama":
        return OllamaProvider(settings.ollama_url, model or settings.ollama_model)
    return ClaudeCodeProvider(model, effort)


def probe(model: str) -> dict:
    """«Probar»: llamada mínima para saber si el modelo está disponible con tu cuenta."""
    t0 = time.time()
    effort = "low" if MODELS.get(model, {}).get("effort", True) else ""
    try:
        out = ClaudeCodeProvider(model, effort).complete_json('Reply only with this JSON: {"ok": true}')
    except Exception as exc:  # noqa: BLE001 — se enseña el motivo en el dashboard
        detail = str(exc)[:400]
        if "usage credits" in detail.lower():  # modelo que tu suscripción no incluye sin créditos extra
            detail = "Tu plan no lo incluye: pide créditos de uso extra (claude.ai/settings/usage). " + detail
        return {"model": model, "ok": False, "detail": detail, "secs": round(time.time() - t0, 1)}
    ok = isinstance(out, dict) and bool(out.get("ok"))
    return {"model": model, "ok": ok, "secs": round(time.time() - t0, 1),
            "detail": "Disponible con tu cuenta." if ok else f"Respuesta inesperada: {str(out)[:200]}"}


# ---------- Caché ----------

def _key(kind: str, model: str, prompt: str, schema: dict | None, images: list[str] | None) -> str:
    h = hashlib.sha256(json.dumps([kind, model, prompt, schema], sort_keys=True, ensure_ascii=False).encode())
    for img in images or []:
        try:
            h.update(hashlib.sha256(Path(img).read_bytes()).digest())
        except OSError:
            h.update(img.encode())
    return h.hexdigest()


def cache_get(key: str, days: int) -> dict | None:
    path = CACHE_DIR / f"{key[:2]}" / f"{key}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if time.time() - data.get("ts", 0) > days * 86400:
        return None
    return data.get("result")


def cache_put(key: str, result: dict) -> None:
    path = CACHE_DIR / f"{key[:2]}" / f"{key}.json"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"ts": time.time(), "result": result}, ensure_ascii=False), encoding="utf-8")
    except OSError:
        log.warning("No se pudo guardar la respuesta en la caché", exc_info=True)


def cache_clear() -> int:
    n = 0
    for f in CACHE_DIR.glob("*/*.json"):
        try:
            f.unlink()
            n += 1
        except OSError:
            pass
    return n


def cache_size() -> int:
    return sum(1 for _ in CACHE_DIR.glob("*/*.json")) if CACHE_DIR.exists() else 0


# ---------- Contador ----------

def record(**row) -> None:
    row["ts"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _lock:
        try:
            USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
            with USAGE_FILE.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            log.warning("No se pudo apuntar la llamada al LLM", exc_info=True)


def usage_rows(task: str, days: int = 90) -> list[dict]:
    """Llamadas de una tarea con sus tokens reales (las que salieron de la caché no cuentan)."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    out = []
    try:
        lines = USAGE_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            r = json.loads(line)
            if r.get("task") == task and r.get("tokens_in") is not None and datetime.fromisoformat(r["ts"]) >= since:
                out.append(r)
        except (ValueError, KeyError):
            continue
    return out


def usage(days: int = 7) -> dict:
    """Llamadas de los últimos `days` días por proveedor y tarea, y los últimos avisos."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows: dict[tuple[str, str], dict] = {}
    notes: list[dict] = []
    try:
        lines = USAGE_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            r = json.loads(line)
            ts = datetime.fromisoformat(r["ts"])
        except (ValueError, KeyError):
            continue
        if ts < since:
            continue
        who = "Caché" if r.get("cached") else ("Ollama" if r.get("provider") == "ollama"
                                               else f"Claude · {r.get('model') or 'por defecto'}")
        agg = rows.setdefault((who, r.get("task", "general")), {"provider": who, "task": r.get("task", "general"),
                                                               "calls": 0, "errors": 0, "seconds": 0.0, "tokens": 0})
        agg["calls"] += 1
        agg["errors"] += 0 if r.get("ok", True) else 1
        agg["seconds"] += float(r.get("secs") or 0)
        agg["tokens"] += int(r.get("tokens_in") or 0) + int(r.get("tokens_out") or 0)
        if r.get("note"):
            notes.append({"ts": r["ts"], "task": r.get("task"), "note": r["note"]})
    out = sorted(rows.values(), key=lambda a: (-a["calls"], a["provider"]))
    for a in out:
        a["label"] = TASKS.get(a["task"], TASKS["general"])[0]
        a["seconds"] = round(a["seconds"])
    return {"days": days, "rows": out, "total": sum(a["calls"] for a in out),
            "cached": sum(a["calls"] for a in out if a["provider"] == "Caché"), "notes": notes[-8:][::-1]}


# ---------- Actividad en vivo ----------

def model_label(kind: str, model: str, effort: str = "") -> str:
    """«Claude Opus 5.5 · esfuerzo Máx» u «Ollama · qwen2.5»: lo que enseña el panel Actividad."""
    if kind == "ollama":
        return f"Ollama · {model}"
    name = f"Claude {MODELS[model]['label']}" if model in MODELS else f"Claude · {model or 'por defecto'}"
    return f"{name} · esfuerzo {EFFORTS[effort]['label']}" if effort in EFFORTS else name


def _limit(kind: str, task: str, timeout: float | None = None) -> float:
    if timeout:
        return float(timeout)
    if kind == "ollama":
        return 900.0
    return 900.0


def _step(kind: str, model: str, effort: str, task: str, agent: bool = False, timeout: float | None = None):
    from .. import activity

    label = TASKS.get(task, TASKS["general"])[0]
    return activity.step("agent" if agent else "llm", label, model_label(kind, model, effort), task=task,
                         detail="con herramientas" if agent else "", limit=_limit(kind, task, timeout))


# ---------- El proveedor que usan las herramientas ----------

def _tokens(st, prov) -> None:
    u = getattr(prov, "usage", {}) or {}
    st.tokens_in, st.tokens_out = int(u.get("in") or 0), int(u.get("out") or 0)


class RoutedProvider(LLMProvider):
    """Proveedor «lógico»: decide modelo, caché y respaldo en cada llamada según la tarea."""

    def __init__(self, base: str, settings: Settings, task: str = ""):
        self.base = base
        self.settings = settings
        self.task = task or "general"
        self.name = base
        self.last_usage: dict = {}  # tokens de la última llamada ({} si salió de la caché)
        self.extra: dict = {}  # campos que se apuntan con cada llamada (p. ej. el nivel de complejidad)

    @property
    def chunk_seconds(self) -> float:  # el troceo de transcripciones depende del modelo que hará la tarea
        kind, _, _ = resolve(self.task, self.base, self.settings)
        return OllamaProvider.chunk_seconds if kind == "ollama" else ClaudeCodeProvider.chunk_seconds

    def complete_json(self, prompt: str, schema: dict | None = None, images: list[str] | None = None,
                      task: str = "") -> dict:
        task = task if task in TASKS else self.task
        kind, model, note = resolve(task, self.base, self.settings, images)
        effort = effort_for(task, model, self.settings) if kind == "claude" else ""
        req = REQUEST.get()
        use_cache = self.settings.llm_cache and task != "editor"
        read_cache = use_cache and not (req and (req.get("fresh") or task in CREATIVE))
        key = _key(kind, f"{model}@{effort}" if effort else model, prompt, schema, images) if use_cache else ""
        if read_cache:
            hit = cache_get(key, self.settings.llm_cache_days)
            if hit is not None:
                self.last_usage = {}
                record(provider=kind, model=model, task=task, cached=True, secs=0, effort=effort)
                from .. import activity
                activity.instant("llm", TASKS.get(task, TASKS["general"])[0], "Respuesta guardada (caché)", task=task)
                if req is not None:
                    req["cached"] = True
                return hit
        t0 = time.time()
        self.last_usage = {}
        try:
            prov = _make(kind, model, self.settings, effort)
            with _step(kind, model, effort, task) as st:
                out = prov.complete_json(prompt, schema, images)
                _tokens(st, prov)
        except Exception as exc:
            if kind != "ollama" or self.base == "ollama":
                record(provider=kind, model=model, task=task, secs=round(time.time() - t0, 1), ok=False, effort=effort)
                raise
            # Ollama falló en una tarea barata: se repite con Claude Haiku y se avisa
            log.warning("Ollama falló en la tarea %s (%s); se usa Claude Haiku", task, exc)
            note = f"Ollama falló ({str(exc)[:120]}): se usó Claude Haiku."
            kind, model = "claude", FALLBACK
            effort = effort_for(task, model, self.settings)
            key = _key(kind, f"{model}@{effort}" if effort else model, prompt, schema, images) if use_cache else ""
            t0 = time.time()
            try:
                prov = _make(kind, model, self.settings, effort)
                with _step(kind, model, effort, task) as st:
                    out = prov.complete_json(prompt, schema, images)
                    _tokens(st, prov)
            except Exception:
                record(provider=kind, model=model, task=task, secs=round(time.time() - t0, 1), ok=False, note=note)
                raise
        self.last_usage = {**getattr(prov, "usage", {}), "model": model, "kind": kind, "effort": effort}
        tokens = {"tokens_in": self.last_usage["in"], "tokens_out": self.last_usage["out"]} if "in" in self.last_usage else {}
        record(provider=kind, model=model, task=task, secs=round(time.time() - t0, 1), ok=True, effort=effort,
               **tokens, **({"note": note} if note else {}), **(self.extra or {}))
        if note and req is not None:
            req.setdefault("notes", []).append(note)
        if use_cache:
            cache_put(key, out)
        return out
