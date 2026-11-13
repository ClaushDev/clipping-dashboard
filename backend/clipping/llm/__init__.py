"""Proveedores de LLM intercambiables: Claude Code (headless) y Ollama (local)."""
from __future__ import annotations

from ..config import Settings
from .base import LLMProvider
from .claude_code import ClaudeCodeProvider
from .ollama import OllamaProvider
from .router import RoutedProvider


def get_provider(name: str, settings: Settings, task: str = "") -> LLMProvider:
    """Proveedor elegido (el del vídeo o el de Ajustes). Con Claude, cada llamada usa el modelo de su tarea (llm/router.py)."""
    name = name or settings.llm_provider
    if name not in ("ollama", "claude"):
        raise ValueError(f"Proveedor de LLM desconocido: {name}")
    return RoutedProvider(name, settings, task)
