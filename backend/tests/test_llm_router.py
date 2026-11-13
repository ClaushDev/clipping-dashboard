from urllib.parse import unquote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

from clipping import api
from clipping.config import Settings
from clipping.llm import get_provider
from clipping.llm import router


class Fake:
    def __init__(self, kind, model, log, fail=False):
        self.kind, self.model, self.log, self.fail = kind, model, log, fail

    def complete_json(self, prompt, schema=None, images=None):
        self.log.append((self.kind, self.model, prompt))
        if self.fail:
            raise RuntimeError("boom")
        return {"n": len(self.log), "by": f"{self.kind}:{self.model}"}


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Caché y contador en una carpeta temporal; los proveedores reales se sustituyen por Fake."""
    monkeypatch.setattr(router, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(router, "USAGE_FILE", tmp_path / "usage.jsonl")
    state = {"log": [], "ollama_ok": True, "ollama_fails": False}
    monkeypatch.setattr(router, "ollama_available", lambda s: state["ollama_ok"])
    monkeypatch.setattr(router, "_make", lambda kind, model, s, effort="": Fake(
        kind, model, state["log"], fail=kind == "ollama" and state["ollama_fails"]))
    return state


def test_resolve_routes_by_task(env):
    s = Settings(llm_provider="claude", claude_model="claude-opus-x", ollama_model="qwen3:14b")
    assert router.resolve("punctuation", "claude", s) == ("ollama", "qwen3:14b", "")
    assert router.resolve("moments", "claude", s) == ("claude", "claude-sonnet-5-5", "")
    # Con Ollama como proveedor se ignora la tabla
    assert router.resolve("moments", "ollama", s)[0] == "ollama"
    # Imágenes con un modelo local sin visión, u Ollama caído → Haiku con aviso
    kind, model, note = router.resolve("punctuation", "claude", s, images=["a.jpg"])
    assert (kind, model) == ("claude", "claude-haiku-5-5") and note
    env["ollama_ok"] = False
    kind, model, note = router.resolve("score", "claude", s)
    assert (kind, model) == ("claude", "claude-haiku-5-5") and "Ollama" in note
    s2 = Settings(llm_task_models={"niche": "opus", "moments": "default", "score": "sonnet"}, claude_model="my-model")
    assert router.resolve("niche", "claude", s2)[:2] == ("claude", "claude-opus-5-5")
    assert router.resolve("moments", "claude", s2)[:2] == ("claude", "my-model")
    assert router.resolve("score", "claude", s2)[:2] == ("claude", "claude-sonnet-5-5")


def test_cache_reuses_identical_requests_and_fresh_bypasses(env):
    p = get_provider("claude", Settings(), task="breakdown")
    a = p.complete_json("same prompt")
    b = p.complete_json("same prompt")
    assert a == b and len(env["log"]) == 1
    p.complete_json("other prompt")
    assert len(env["log"]) == 2
    # «Regenerar»: la petición del dashboard pide no leer la caché (y guarda la respuesta nueva)
    token = router.REQUEST.set({"fresh": True, "cached": False, "notes": []})
    try:
        c = p.complete_json("same prompt")
    finally:
        router.REQUEST.reset(token)
    assert c["n"] == 3 and p.complete_json("same prompt")["n"] == 3
    # El chat del editor nunca se guarda
    e = get_provider("claude", Settings(), task="editor")
    e.complete_json("hi")
    e.complete_json("hi")
    assert len(env["log"]) == 5


def test_ollama_failure_falls_back_to_haiku_with_note(env):
    env["ollama_fails"] = True
    req = {"fresh": False, "cached": False, "notes": []}
    token = router.REQUEST.set(req)
    try:
        out = get_provider("claude", Settings(), task="punctuation").complete_json("title please")
    finally:
        router.REQUEST.reset(token)
    assert out["by"] == "claude:claude-haiku-5-5"
    assert [k for k, _, _ in env["log"]] == ["ollama", "claude"]
    assert req["notes"] and "Haiku" in req["notes"][0]
    # Con Ollama elegido como proveedor no hay respaldo: el error sube
    with pytest.raises(RuntimeError):
        get_provider("ollama", Settings(), task="punctuation").complete_json("x")


def test_usage_counts_by_provider_and_task(env):
    p = get_provider("claude", Settings())
    p.complete_json("a", task="moments")
    p.complete_json("a", task="moments")  # caché (no hay petición del dashboard)
    p.complete_json("b", task="score")
    u = router.usage(7)
    rows = {(r["provider"], r["task"]): r["calls"] for r in u["rows"]}
    assert rows[("Claude · claude-sonnet-5-5", "moments")] == 1
    assert rows[("Caché", "moments")] == 1
    assert rows[("Ollama", "score")] == 1
    assert u["total"] == 3 and u["cached"] == 1
    assert router.cache_size() == 2 and router.cache_clear() == 2


def test_chunk_seconds_follow_the_model_of_the_task(env):
    assert get_provider("claude", Settings(), task="moments").chunk_seconds == 1500
    assert get_provider("claude", Settings(), task="score").chunk_seconds == 420
    assert get_provider("ollama", Settings(), task="moments").chunk_seconds == 420


def test_middleware_headers(env):
    mini = FastAPI()
    mini.add_middleware(BaseHTTPMiddleware, dispatch=api.llm_request)

    @mini.get("/api/x")
    def x(task: str = "breakdown"):
        return get_provider("claude", Settings(), task=task).complete_json("p")

    c = TestClient(mini)
    first = c.get("/api/x")
    assert "x-llm-cached" not in first.headers
    again = c.get("/api/x")
    assert again.headers.get("x-llm-cached") == "1" and again.json() == first.json()
    fresh = c.get("/api/x", headers={"X-LLM-Fresh": "1"})
    assert "x-llm-cached" not in fresh.headers and fresh.json()["n"] == 2
    env["ollama_fails"] = True
    note = c.get("/api/x?task=score")
    assert "Haiku" in unquote(note.headers["x-llm-note"])


def test_llm_endpoints():
    client = TestClient(api.app)
    info = client.get("/api/llm").json()
    assert {t["id"] for t in info["tasks"]} == set(router.TASKS)
    assert info["routes"][0] == "auto" and "ollama" in info
    assert "rows" in client.get("/api/llm/usage?days=7").json()
    s = client.get("/api/settings").json()
    bad = client.put("/api/settings", json={**s, "llm_task_models": {"moments": "gpt"}})
    assert bad.status_code == 400


def test_jobs_inherit_the_dashboard_request():
    from clipping import worker
    from clipping.db import init_db

    init_db()
    assert worker.enqueue("noop", 1).llm == 0  # lanzado por la propia producción
    for fresh, want in ((False, 1), (True, 2)):
        token = router.REQUEST.set({"fresh": fresh, "cached": False, "notes": []})
        try:
            assert worker.enqueue("noop", 1).llm == want
        finally:
            router.REQUEST.reset(token)
