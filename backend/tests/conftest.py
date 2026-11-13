import os
import tempfile

# Los tests nunca tocan la base de datos ni los archivos reales de data/.
os.environ.setdefault("CLIPPING_DATA", tempfile.mkdtemp(prefix="clipping_test_"))


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _no_heatmap_requests(monkeypatch):
    """El «Más reproducido» de YouTube nunca se pide por red en los tests."""
    from clipping.pipeline import heatmap
    monkeypatch.setattr(heatmap, "fetch", lambda url: [])
