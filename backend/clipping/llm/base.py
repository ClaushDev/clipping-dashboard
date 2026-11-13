from __future__ import annotations

import json
from abc import ABC, abstractmethod


class LLMProvider(ABC):
    name: str
    # Segundos de transcripción por llamada: los modelos locales tienen menos contexto útil.
    chunk_seconds: float

    @abstractmethod
    def complete_json(self, prompt: str, schema: dict | None = None, images: list[str] | None = None) -> dict:
        """Envía el prompt y devuelve la respuesta ya parseada como JSON.

        `images`: rutas de imágenes (fotogramas, hojas de contacto). El prompt las nombra por su nombre de archivo.
        Los proveedores sin visión las ignoran."""


def extract_json(text: str) -> dict:
    """Parsea el primer objeto JSON de una respuesta, tolerando texto o bloques ``` alrededor y saltos de línea
    sueltos dentro de los textos (strict=False), que los modelos meten a veces."""
    text = text.strip()
    try:
        return json.loads(text, strict=False)
    except json.JSONDecodeError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError(f"La respuesta del LLM no contiene JSON: {text[:300]}")
    return json.loads(text[start:end + 1], strict=False)
