"""Seguimiento de un punto (SAM 2.1). Haces clic en algo del vídeo y se sigue su máscara fotograma a fotograma.

Trabajo: {"items": [{"id": "p1", "video": "a.mp4", "start": 3.2, "end": 9.0, "point": [0.5, 0.4], "fps": 10}]}
`point` (0-1) es dónde está el objeto en `start`. Se analizan `fps` fotogramas por segundo (10 por defecto: el
encuadre se suaviza después, no hace falta más).
Emite {"item": {"id", "path": [[t, x, y, w, h] | [t, null], ...]}}: t en segundos desde `start`; x, y = centro del
objeto (0-1); w, h = su caja (0-1). null = perdido en ese fotograma (tapado o fuera de cuadro).
"""
from __future__ import annotations

import numpy as np
import torch

from common import emit, main
from segment import DEVICE, SAM, _fit, _frames

INFER_SIDE = 640  # SAM reescala a 1024 por dentro; esto solo ahorra memoria al guardar los fotogramas
MAX_SECONDS = 60
MIN_AREA = 0.00005  # menos de esto (fracción del cuadro) = perdido


def _frames_at(path: str, start: float, dur: float, size: tuple[int, int], fps: float) -> list[np.ndarray]:
    _, gen = _frames(path, start, dur, size)
    meta, _ = _frames(path, start, 0.05)
    src_fps = float(meta.get("fps") or 30)
    step = max(1, round(src_fps / fps))
    out = []
    for n, b in enumerate(gen):
        if n % step == 0:
            out.append(np.frombuffer(b, np.uint8).reshape(size[1], size[0], 3))
    return out, step / src_fps


def run_item(it: dict) -> dict:
    from transformers import Sam2VideoModel, Sam2VideoProcessor
    start = float(it.get("start", 0))
    dur = min(MAX_SECONDS, float(it["end"]) - start)
    meta, _ = _frames(it["video"], start, 0.05)
    src_w, src_h = meta["source_size"]
    small = _fit(src_w, src_h, INFER_SIDE)
    frames, dt = _frames_at(it["video"], start, dur, small, float(it.get("fps") or 10))
    if not frames:
        raise RuntimeError("No se pudo leer el tramo del vídeo")
    emit({"progress": 0.1})

    processor = Sam2VideoProcessor.from_pretrained(SAM)
    model = Sam2VideoModel.from_pretrained(SAM).to(DEVICE, dtype=torch.bfloat16).eval()
    session = processor.init_video_session(video=frames, inference_device=DEVICE, video_storage_device="cpu",
                                           processing_device="cpu", dtype=torch.bfloat16)
    px, py = it["point"]
    processor.add_inputs_to_inference_session(session, frame_idx=0, obj_ids=1,
                                              input_points=[[[[float(px) * small[0], float(py) * small[1]]]]],
                                              input_labels=[[[1]]])
    path: list[list] = [[round(n * dt, 3), None] for n in range(len(frames))]
    with torch.no_grad():
        model(inference_session=session, frame_idx=0)
        for n, out in enumerate(model.propagate_in_video_iterator(session)):
            m = processor.post_process_masks([out.pred_masks.float()], original_sizes=[[small[1], small[0]]])[0]
            mask = m[0, 0].cpu().numpy() > 0
            area = float(mask.mean())
            if area >= MIN_AREA:
                ys, xs = np.nonzero(mask)
                path[out.frame_idx] = [round(out.frame_idx * dt, 3),
                                       round(float(xs.mean()) / small[0], 4), round(float(ys.mean()) / small[1], 4),
                                       round(float(xs.max() - xs.min() + 1) / small[0], 4),
                                       round(float(ys.max() - ys.min() + 1) / small[1], 4)]
            if n % 10 == 0:
                emit({"progress": round(0.1 + 0.9 * (n + 1) / len(frames), 3)})
    del model, session
    torch.cuda.empty_cache()
    return {"id": it["id"], "path": path}


def run(job: dict) -> None:
    for it in job["items"]:
        emit({"item": run_item(it)})


if __name__ == "__main__":
    main(run)
