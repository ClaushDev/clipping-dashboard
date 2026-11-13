"""Claude Code en modo headless (`claude -p`), usando la suscripción del usuario."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from .. import jobctl
from ..config import find_exe
from ..pipeline.media import NO_WINDOW
from .base import LLMProvider, extract_json


def _run(cmd: list[str], prompt: str, cwd: str, timeout: int) -> subprocess.CompletedProcess:
    """subprocess.run con tiempo límite que cierra el árbol entero: en Windows `claude.CMD` lanza `claude.exe`, y matar
    solo el envoltorio deja al hijo con las tuberías abiertas (run se queda esperando a que acabe y luego lo descarta)."""
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace", cwd=cwd, creationflags=NO_WINDOW)
    jobctl.track(proc)  # «Parar» en la cola de trabajos
    try:
        out, err = proc.communicate(prompt, timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, creationflags=NO_WINDOW)
        proc.kill()
        proc.communicate()
        raise
    finally:
        jobctl.untrack(proc)
    jobctl.check()
    return subprocess.CompletedProcess(cmd, proc.returncode, out, err)


class ClaudeCodeProvider(LLMProvider):
    name = "claude"
    chunk_seconds = 1500

    def __init__(self, model: str = "", effort: str = ""):
        self.model = model
        self.effort = effort  # low | medium | high | xhigh | max; "" = el del modelo

    def complete_json(self, prompt: str, schema: dict | None = None, images: list[str] | None = None) -> dict:
        exe = find_exe("claude")
        if not exe:
            raise RuntimeError("No se encuentra Claude Code. Instálalo con: npm install -g @anthropic-ai/claude-code")
        # Con imágenes solo se permite leer archivos (las imágenes se copian a la carpeta de trabajo).
        allowed = ["Read"] if images else []
        tools = ["--tools", ",".join(allowed), "--allowedTools", *allowed] if allowed else ["--tools", ""]
        cmd = [exe, "-p", "--output-format", "json", *tools, "--no-session-persistence", "--strict-mcp-config"]
        if self.model:
            cmd += ["--model", self.model]
        if self.effort:
            cmd += ["--effort", self.effort]
        # Se ejecuta en una carpeta vacía para no cargar CLAUDE.md ni configuración de proyecto.
        with tempfile.TemporaryDirectory() as cwd:
            for img in images or []:
                shutil.copyfile(img, Path(cwd) / Path(img).name)
            if images:
                prompt += ("\n\nThe images mentioned above are files in the current directory: "
                           + ", ".join(Path(i).name for i in images) + ". Open each one with the Read tool before answering.")
            proc = _run(cmd, prompt, cwd, 900)
        if proc.returncode != 0 and not proc.stdout.strip():
            raise RuntimeError(f"Claude Code falló: {proc.stderr.strip()[-800:]}")
        try:
            envelope = json.loads(proc.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f"Salida inesperada de Claude Code: {proc.stdout[:500]}")
        if envelope.get("is_error"):
            result = str(envelope.get("result", ""))
            if "login" in result.lower() or "auth" in result.lower():
                raise RuntimeError("Claude Code no ha iniciado sesión. Abre una terminal, ejecuta `claude.cmd` e inicia sesión. "
                                   "Mientras tanto puedes usar Ollama.")
            raise RuntimeError(f"Claude Code devolvió un error: {result[:500]}")
        u = envelope.get("usage") or {}
        # Tokens reales de la llamada (para el contador de consumo)
        self.usage = {"in": int(u.get("input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0)
                      + int(u.get("cache_read_input_tokens") or 0), "out": int(u.get("output_tokens") or 0),
                      "usd": float(envelope.get("total_cost_usd") or 0)}
        return extract_json(str(envelope.get("result", "")))
