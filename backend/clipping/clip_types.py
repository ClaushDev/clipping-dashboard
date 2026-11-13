"""Tipos de clip y presets de encuadre que ofrece la pantalla «Nuevo vídeo».

Las reglas de cada tipo (en inglés, como los prompts) se añaden a las instrucciones de la IA al buscar momentos.
Para añadir un tipo nuevo basta con una entrada más en TYPES.
"""
from __future__ import annotations

TYPES: dict[str, dict] = {
    "clips": {
        "label": "Clips tal cual",
        "desc": "Los mejores momentos de un vídeo largo, con gancho y subtítulos. Solo con permiso del creador.",
        "presets": ["face", "auto", "duo", "gaming", "fit_blur", "fit_black"],
        "rules": "Pick self-contained moments with a strong first sentence; each clip must make sense without the rest "
                 "of the video.",
    },
    "podcast_topics": {
        "label": "Podcast por temas",
        "desc": "Busca dentro del episodio los momentos de cada tema y saca un clip por tema.",
        "presets": ["duo", "face", "fit_blur"],
        "rules": "Group the episode by topic and pick the single best moment for each topic: a complete answer, story "
                 "or opinion with a clear start and end. Avoid small talk, ads and intros.",
    },
}

PRESETS: dict[str, dict] = {
    "face": {"label": "Vertical siguiendo la cara", "desc": "9:16, el encuadre sigue a quien habla.",
             "layout": "face", "aspect": "9:16"},
    "auto": {"label": "Vertical automático", "desc": "9:16, la herramienta decide el encuadre por escena.",
             "layout": "auto", "aspect": "9:16"},
    "duo": {"label": "Dos personas (pantalla partida)", "desc": "9:16 con dos paneles, uno por persona. Ideal para podcasts.",
            "layout": "duo", "aspect": "9:16"},
    "gaming": {"label": "Gaming (cámara + juego)", "desc": "9:16 con la cámara del streamer arriba y el juego abajo.",
               "layout": "gaming", "aspect": "9:16"},
    "fit_blur": {"label": "Vídeo entero con fondo difuminado", "desc": "9:16 sin recortar nada; el vídeo cabe entero.",
                 "layout": "fit_blur", "aspect": "9:16"},
    "fit_black": {"label": "Vídeo entero con bandas negras", "desc": "9:16 sin recortar, subtítulos debajo del vídeo.",
                  "layout": "fit_black", "aspect": "9:16"},
}


def rules_text(type_id: str) -> str:
    t = TYPES.get(type_id or "")
    return f"Clip type ({type_id}): {t['rules']}" if t else ""


def public() -> dict:
    return {"types": [{"id": k, **{f: v[f] for f in ("label", "desc", "presets")}} for k, v in TYPES.items()],
            "presets": [{"id": k, **v} for k, v in PRESETS.items()]}
