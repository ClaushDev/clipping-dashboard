// Renderiza una composición con Remotion. Lo lanza el backend:
//   node render.mjs <job.json>
// job.json: { "id": "Main", "composition": {...}, "out": "ruta.mp4", "codec": "h264"|"h265", "crf": 18,
//             "scale": 1, "audio_bitrate": "192k", "x264_preset": "medium", "jpeg_quality": 100, "image_format": "jpeg"|"png" }
// Escribe en stdout una línea JSON por evento: {"progress": 0.42} · {"done": "ruta"} · {"error": "..."}
import { renderMedia, selectComposition } from "@remotion/renderer";
import { readFileSync } from "node:fs";
import os from "node:os";
import { emit, getServeUrl } from "./remotion-bundle.mjs";

async function main() {
  const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const serveUrl = await getServeUrl();
  const inputProps = { composition: job.composition };
  const composition = await selectComposition({ serveUrl, id: job.id || "Main", inputProps });
  emit({ stage: "rendering", frames: composition.durationInFrames });
  const codec = job.codec === "h265" ? "h265" : "h264";
  await renderMedia({
    composition,
    serveUrl,
    codec,
    inputProps,
    outputLocation: job.out,
    crf: job.crf ?? 18,
    scale: job.scale ?? 1,
    audioBitrate: job.audio_bitrate ?? "192k",
    x264Preset: codec === "h264" ? job.x264_preset ?? "medium" : undefined,
    concurrency: job.concurrency ?? Math.max(1, Math.floor(os.cpus().length / 2)),
    pixelFormat: "yuv420p",
    // Cada fotograma pasa por una imagen antes del códec. Remotion usa JPEG de calidad 80 por defecto, que emborrona
    // texto y bordes (H1): se sube a 100 salvo que el trabajo pida otra cosa.
    imageFormat: job.image_format ?? "jpeg",
    jpegQuality: (job.image_format ?? "jpeg") === "jpeg" ? job.jpeg_quality ?? 100 : undefined,
    timeoutInMilliseconds: job.timeout_ms ?? 120000,
    chromiumOptions: { gl: "angle" }, // WebGL en la GPU para las escenas 3D (F10c)
    onProgress: ({ progress }) => emit({ progress: Math.round(progress * 1000) / 1000 }),
  });
  emit({ done: job.out });
}

main().catch((err) => {
  emit({ error: String(err?.stack || err).slice(0, 4000) });
  process.exit(1);
});
