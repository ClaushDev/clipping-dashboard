"""Utilidades compartidas por los scripts del entorno ML.

Cada script recibe la ruta de un JSON de trabajo, escribe sus resultados en disco y emite por stdout una línea
JSON por evento: {"progress": 0.4} · {"item": {...}} · {"done": true} · {"error": "..."}.
"""
from __future__ import annotations

import json
import sys
import traceback
from typing import Callable


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(run: Callable[[dict], None]) -> None:
    try:
        job = json.loads(open(sys.argv[1], encoding="utf-8").read())
        run(job)
        emit({"done": True})
    except Exception as exc:  # el backend muestra este mensaje al usuario
        emit({"error": f"{exc.__class__.__name__}: {exc}", "trace": traceback.format_exc()[-3000:]})
        sys.exit(1)
