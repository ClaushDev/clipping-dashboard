"""Detector de objetos por texto (Grounding DINO tiny): dónde está «the pedal» en un fotograma.

Trabajo: {"items": [{"id": "e1", "image": "frame.jpg", "query": "the red pedal"}], "threshold": 0.3}
Emite un {"item": {"id", "box": [x0, y0, x1, y1] (0-1) | null, "score"}} por cada imagen.
"""
from __future__ import annotations

import torch
from PIL import Image
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

from common import emit, main

MODEL = "IDEA-Research/grounding-dino-tiny"


def run(job: dict) -> None:
    items = job["items"]
    threshold = float(job.get("threshold", 0.3))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    processor = AutoProcessor.from_pretrained(MODEL)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(MODEL).to(device).eval()
    for n, it in enumerate(items):
        image = Image.open(it["image"]).convert("RGB")
        w, h = image.size
        # Grounding DINO espera minúsculas y cada frase terminada en punto.
        text = it["query"].strip().lower().rstrip(".") + "."
        inputs = processor(images=image, text=text, return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = model(**inputs)
        res = processor.post_process_grounded_object_detection(
            outputs, input_ids=inputs.input_ids, threshold=threshold, text_threshold=0.25, target_sizes=[(h, w)])[0]
        best = None
        if len(res["scores"]):
            i = int(torch.argmax(res["scores"]))
            x0, y0, x1, y1 = (float(v) for v in res["boxes"][i])
            best = {"box": [round(x0 / w, 4), round(y0 / h, 4), round(x1 / w, 4), round(y1 / h, 4)],
                    "score": round(float(res["scores"][i]), 3)}
        emit({"item": {"id": it["id"], **(best or {"box": None, "score": 0})}})
        emit({"progress": round((n + 1) / len(items), 3)})


if __name__ == "__main__":
    main(run)
