"""diarización local (quién habla cuándo) con sherpa-onnx, sin torch ni licencias de Hugging Face.

Modelos (gratis, se descargan solos la primera vez en data/models/diarization, ~33 MB):
- segmentación: pyannote segmentation 3.0 (MIT) exportado a ONNX por el proyecto sherpa-onnx;
- huellas de voz: WeSpeaker ResNet34 entrenado con VoxCeleb (Apache 2.0).
"""
from __future__ import annotations

import logging
import subprocess
import tarfile
from pathlib import Path

import httpx
import numpy as np

from ..config import MODELS_DIR, require_exe
from .media import NO_WINDOW

log = logging.getLogger(__name__)

DIR = MODELS_DIR / "diarization"
SEGMENTATION = DIR / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMBEDDING = DIR / "wespeaker_en_voxceleb_resnet34_LM.onnx"
RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
SEGMENTATION_URL = f"{RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
EMBEDDING_URL = f"{RELEASES}/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx"  # sic: así se llama
RATE = 16000


def installed() -> bool:
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError:
        return False
    return True


def available() -> bool:
    """¿Se puede diarizar? (sherpa-onnx instalado; los modelos se bajan al usarlo)."""
    return installed()


def _download(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    with httpx.stream("GET", url, timeout=120, follow_redirects=True) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_bytes(1 << 16):
                f.write(chunk)
    tmp.replace(dest)


def ensure_models() -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    if not SEGMENTATION.exists():
        log.info("Descargando el modelo de segmentación de hablantes…")
        arc = DIR / "segmentation.tar.bz2"
        _download(SEGMENTATION_URL, arc)
        with tarfile.open(arc, "r:bz2") as t:
            t.extractall(DIR, filter="data")
        arc.unlink(missing_ok=True)
    if not EMBEDDING.exists():
        log.info("Descargando el modelo de huellas de voz…")
        _download(EMBEDDING_URL, EMBEDDING)


def load_audio(video: Path, start: float, end: float) -> np.ndarray:
    """Audio mono a 16 kHz en float32 del tramo [start, end)."""
    cmd = [require_exe("ffmpeg"), "-v", "error", "-ss", f"{start:.3f}", "-t", f"{max(0.1, end - start):.3f}",
           "-i", str(video), "-vn", "-ac", "1", "-ar", str(RATE), "-f", "f32le", "pipe:1"]
    proc = subprocess.run(cmd, capture_output=True, timeout=600, creationflags=NO_WINDOW)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[-400:])
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


_engine = None


def _diarizer():
    global _engine
    if _engine is None:
        import sherpa_onnx

        ensure_models()
        cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(SEGMENTATION))),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(EMBEDDING)),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.3),
            min_duration_on=0.3, min_duration_off=0.5)
        if not cfg.validate():
            raise RuntimeError("Configuración de diarización no válida")
        _engine = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    return _engine


def turns(video: Path, start: float, end: float) -> list[dict]:
    """Turnos [{"start", "end", "speaker"}] en segundos relativos a `start`; speaker = "s0", "s1"…"""
    audio = load_audio(video, start, end)
    if audio.size < RATE // 2:
        return []
    result = _diarizer().process(audio).sort_by_start_time()
    return [{"start": round(r.start, 3), "end": round(r.end, 3), "speaker": f"s{r.speaker}"} for r in result]
