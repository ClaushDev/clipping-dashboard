"""Ollama local con salida estructurada (JSON schema)."""
from __future__ import annotations

import base64
from pathlib import Path

import httpx

from .base import LLMProvider, extract_json

VISION_HINTS = ("vl", "vision", "llava", "gemma3", "minicpm")
_sees: dict[str, bool] = {}


def sees_images(url: str, model: str) -> bool:
    """¿El modelo de Ollama ve imágenes? Por el nombre o, si no lo dice, por sus capacidades (`/api/show`): Qwen3.5
    ve imágenes sin llevar «vl» en el nombre. Se pregunta una vez por modelo."""
    if any(h in model.lower() for h in VISION_HINTS):
        return True
    key = f"{url}|{model}"
    if key not in _sees:
        try:
            resp = httpx.post(f"{url.rstrip('/')}/api/show", json={"model": model}, timeout=3)
            _sees[key] = "vision" in (resp.json().get("capabilities") or [])
        except Exception:  # noqa: BLE001 — Ollama cerrado: no se guarda, se vuelve a preguntar
            return False
    return _sees[key]


class OllamaProvider(LLMProvider):
    name = "ollama"
    chunk_seconds = 420

    def __init__(self, url: str, model: str):
        self.url = url.rstrip("/")
        self.model = model

    def complete_json(self, prompt: str, schema: dict | None = None, images: list[str] | None = None) -> dict:
        if "qwen3" in self.model.lower():
            prompt += "\n/no_think"  # Qwen3: desactiva el razonamiento largo, no hace falta para extraer JSON
        message = {"role": "user", "content": prompt}
        if images and sees_images(self.url, self.model):
            message["images"] = [base64.b64encode(Path(i).read_bytes()).decode() for i in images]
        body = {
            "model": self.model,
            "messages": [message],
            "stream": False,
            "format": schema or "json",
            "think": False,
            # Libera la VRAM enseguida: la GPU se comparte con Whisper.
            "keep_alive": "30s",
            "options": {"num_ctx": 16384, "temperature": 0.4},
        }
        try:
            resp = httpx.post(f"{self.url}/api/chat", json=body, timeout=900)
            if resp.status_code == 400 and "think" in resp.text:
                body.pop("think")
                resp = httpx.post(f"{self.url}/api/chat", json=body, timeout=900)
        except httpx.ConnectError:
            raise RuntimeError(f"Ollama no responde en {self.url}. ¿Está abierto?")
        if resp.status_code == 404:
            raise RuntimeError(f"Ollama no tiene el modelo '{self.model}'. Ejecuta: ollama pull {self.model}")
        resp.raise_for_status()
        data = resp.json()
        self.usage = {"in": int(data.get("prompt_eval_count") or 0), "out": int(data.get("eval_count") or 0), "usd": 0.0}
        return extract_json(data["message"]["content"])
