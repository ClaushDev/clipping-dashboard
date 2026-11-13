"""Rotoscopia automática (SAM 2.1): recorta el sujeto de un vídeo o una imagen y lo guarda con transparencia.

Trabajo: {"items": [{"id": "m1", "video": "a.mp4", "start": 3.2, "end": 9.0, "out": "m1.webm",
                     "points": [[0.5, 0.4]], "query": "person"}]}
         o {"id": ..., "image": "a.png", "out": "m1.png", ...}
Cómo se elige el sujeto: con `points` (0-1, en el primer fotograma), si no con `query` (Grounding DINO da la caja) y
si no tampoco, el centro. Vídeo → WebM VP9 con canal alfa al ritmo del original; imagen → PNG con alfa.
Emite {"item": {"id", "out", "frames", "coverage"}} por cada uno.
"""
from __future__ import annotations

import subprocess

import imageio_ffmpeg
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from common import emit, main

SAM = "facebook/sam2.1-hiera-small"
DINO = "IDEA-Research/grounding-dino-tiny"
MAX_SIDE = 1920  # lado largo máximo del recorte
INFER_SIDE = 1024  # SAM trabaja a 1024: los fotogramas se guardan a ese tamaño
MAX_SECONDS = 30
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def _box(image: Image.Image, query: str) -> list[float] | None:
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
    processor = AutoProcessor.from_pretrained(DINO)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(DINO).to(DEVICE).eval()
    w, h = image.size
    inputs = processor(images=image, text=query.strip().lower().rstrip(".") + ".", return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        out = model(**inputs)
    res = processor.post_process_grounded_object_detection(
        out, input_ids=inputs.input_ids, threshold=0.3, text_threshold=0.25, target_sizes=[(h, w)])[0]
    del model
    torch.cuda.empty_cache()
    if not len(res["scores"]):
        return None
    return [float(v) for v in res["boxes"][int(torch.argmax(res["scores"]))]]


def _prompt(it: dict, first: Image.Image) -> dict:
    """Puntos o caja en píxeles de `first`."""
    w, h = first.size
    pts = [p for p in it.get("points") or [] if len(p) == 2]
    if pts:
        return {"input_points": [[[[float(x) * w, float(y) * h] for x, y in pts]]], "input_labels": [[[1] * len(pts)]]}
    box = _box(first, it["query"]) if it.get("query") else None
    if box:
        return {"input_boxes": [[box]]}
    return {"input_points": [[[[w / 2, h / 2]]]], "input_labels": [[[1]]]}


def _alpha(prob: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Probabilidad (h, w) a tamaño de salida, con el borde suavizado un par de píxeles."""
    t = torch.from_numpy(prob)[None, None].float()
    # Apertura (erosión + dilatación): quita las motas sueltas, que con el borde del papel o la sombra se notarían.
    o = max(3, (min(prob.shape) // 120) | 1)
    t = F.max_pool2d(-F.max_pool2d(-t, o, stride=1, padding=o // 2), o, stride=1, padding=o // 2)
    t = F.interpolate(t, size=(size[1], size[0]), mode="bilinear", align_corners=False)
    a = torch.clamp((t - 0.35) / 0.3, 0, 1)  # umbral suave: ni halo ni bordes de sierra
    k = max(3, (min(size) // 400) * 2 + 1)
    a = F.avg_pool2d(a, k, stride=1, padding=k // 2)
    return (a[0, 0].numpy() * 255).astype(np.uint8)


def _fit(w: int, h: int, side: int) -> tuple[int, int]:
    s = min(1.0, side / max(w, h))
    return max(2, round(w * s / 2) * 2), max(2, round(h * s / 2) * 2)


def run_image(it: dict) -> dict:
    from transformers import Sam2Model, Sam2Processor
    image = Image.open(it["image"]).convert("RGB")
    processor = Sam2Processor.from_pretrained(SAM)
    model = Sam2Model.from_pretrained(SAM).to(DEVICE).eval()
    inputs = processor(images=image, **_prompt(it, image), return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        out = model(**inputs, multimask_output=False)
    prob = processor.post_process_masks(out.pred_masks.cpu(), inputs["original_sizes"], binarize=False)[0]
    alpha = _alpha(torch.sigmoid(prob[0, 0]).numpy(), image.size)
    rgba = np.dstack([np.asarray(image), alpha])
    Image.fromarray(rgba, "RGBA").save(it["out"])
    return {"id": it["id"], "out": it["out"], "frames": 1, "coverage": round(float((alpha > 127).mean()), 3)}


def _frames(path: str, start: float, dur: float, size: tuple[int, int] | None = None):
    params = ["-ss", f"{start:.3f}"]
    out = ["-t", f"{dur:.3f}"] + (["-vf", f"scale={size[0]}:{size[1]}"] if size else [])
    gen = imageio_ffmpeg.read_frames(path, input_params=params, output_params=out)
    meta = next(gen)
    return meta, gen


def run_video(it: dict) -> dict:
    from transformers import Sam2VideoModel, Sam2VideoProcessor
    start = float(it.get("start", 0))
    dur = min(MAX_SECONDS, float(it["end"]) - start)
    meta, _ = _frames(it["video"], start, 0.1)
    src_w, src_h = meta["source_size"]
    fps = float(meta.get("fps") or 30)
    small = _fit(src_w, src_h, INFER_SIDE)
    _, gen = _frames(it["video"], start, dur, small)
    frames = [np.frombuffer(b, np.uint8).reshape(small[1], small[0], 3) for b in gen]
    if not frames:
        raise RuntimeError("No se pudo leer el tramo del vídeo")
    emit({"progress": 0.05})

    processor = Sam2VideoProcessor.from_pretrained(SAM)
    model = Sam2VideoModel.from_pretrained(SAM).to(DEVICE, dtype=torch.bfloat16).eval()
    session = processor.init_video_session(video=frames, inference_device=DEVICE, video_storage_device="cpu",
                                           processing_device="cpu", dtype=torch.bfloat16)
    processor.add_inputs_to_inference_session(session, frame_idx=0, obj_ids=1, **_prompt(it, Image.fromarray(frames[0])))
    probs: list[np.ndarray] = [None] * len(frames)  # type: ignore[list-item]
    with torch.no_grad():
        model(inference_session=session, frame_idx=0)
        for n, out in enumerate(model.propagate_in_video_iterator(session)):
            m = processor.post_process_masks([out.pred_masks.float()], original_sizes=[[small[1], small[0]]],
                                             binarize=False)[0]
            probs[out.frame_idx] = torch.sigmoid(m[0, 0]).cpu().numpy().astype(np.float16)
            if n % 10 == 0:
                emit({"progress": round(0.05 + 0.75 * (n + 1) / len(frames), 3)})
    del model, session
    torch.cuda.empty_cache()

    out_size = _fit(src_w, src_h, MAX_SIDE)
    enc = subprocess.Popen(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
         "-pix_fmt", "rgba", "-s", f"{out_size[0]}x{out_size[1]}", "-r", f"{fps:.6f}", "-i", "-",
         "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "0", "-crf", "32",
         "-deadline", "realtime", "-cpu-used", "6", "-row-mt", "1", it["out"]],
        stdin=subprocess.PIPE)
    _, gen = _frames(it["video"], start, dur, out_size)
    last = probs[0]
    covered = 0.0
    for n, b in enumerate(gen):
        rgb = np.frombuffer(b, np.uint8).reshape(out_size[1], out_size[0], 3)
        p = probs[n] if n < len(probs) and probs[n] is not None else last
        last = p
        alpha = _alpha(p.astype(np.float32), out_size)
        covered += float((alpha > 127).mean())
        assert enc.stdin is not None
        enc.stdin.write(np.dstack([rgb, alpha]).tobytes())
        if n % 15 == 0:
            emit({"progress": round(0.8 + 0.2 * (n + 1) / len(frames), 3)})
    assert enc.stdin is not None
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError("ffmpeg no pudo escribir el recorte")
    return {"id": it["id"], "out": it["out"], "frames": len(frames), "fps": fps,
            "coverage": round(covered / max(1, len(frames)), 3)}


def run(job: dict) -> None:
    for it in job["items"]:
        emit({"item": run_image(it) if it.get("image") else run_video(it)})


if __name__ == "__main__":
    main(run)
