import { useEffect, useRef, useState } from "react";
import { canvasSize, type Composition, cropAt, cropRect, type Segment } from "../remotion/schema";

type Scope = "waveform" | "parade" | "histogram" | "vector";

const SCOPE_LABEL: Record<Scope, string> = {
  waveform: "Forma de onda",
  parade: "Desfile RGB",
  histogram: "Histograma",
  vector: "Vectorscopio",
};

const SW = 320; // Ancho de la muestra
const CH = 160; // Alto de los scopes

/** Scopes de color (como los de Lumetri): miden el plano del cursor tal como queda recortado y con las capas de
 *  ajuste de color que hay en ese instante (sin sus máscaras). Se actualizan al mover el cursor, no mientras se
 *  reproduce. */
export default function ColorScopes({ comp, seg, local, playhead, src }: { comp: Composition; seg: Segment; local: number; playhead: number; src: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const out = useRef<HTMLCanvasElement>(null);
  const [scope, setScope] = useState<Scope>("waveform");
  const [stats, setStats] = useState("");
  const [outW, outH] = canvasSize(comp);
  // Capas de ajuste activas en el cursor, sin máscara: su filtro SVG está montado en la vista previa.
  const grades = comp.overlays
    .filter((o) => o.kind === "adjust" && !o.mask && o.start <= playhead && playhead < o.end)
    .map((o) => `url(#grade-${o.id})`).join(" ");

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const at = seg.src_in + local;
    let raf: ReturnType<typeof setTimeout> | undefined;
    const draw = () => {
      clearTimeout(raf);
      raf = setTimeout(() => {
        if (!v.videoWidth || !out.current) return;
        const r = seg.layout === "crop" ? cropRect(v.videoWidth, v.videoHeight, outW, outH, cropAt(seg.keys, local))
          : { left: 0, top: 0, width: v.videoWidth, height: v.videoHeight };
        const h = Math.max(1, Math.round((SW * r.height) / r.width));
        const tmp = document.createElement("canvas");
        tmp.width = SW;
        tmp.height = h;
        const ctx = tmp.getContext("2d", { willReadFrequently: true })!;
        ctx.filter = grades || "none";
        ctx.drawImage(v, r.left, r.top, r.width, r.height, 0, 0, SW, h);
        const px = ctx.getImageData(0, 0, SW, h).data;
        setStats(paint(out.current, scope, px, SW, h));
      }, 30);
    };
    if (Math.abs(v.currentTime - at) > 0.02) v.currentTime = at;
    else draw();
    v.addEventListener("seeked", draw);
    v.addEventListener("loadeddata", draw);
    return () => {
      clearTimeout(raf);
      v.removeEventListener("seeked", draw);
      v.removeEventListener("loadeddata", draw);
    };
  }, [seg, local, scope, grades, outW, outH]);

  return (
    <div className="stack color-scopes">
      <div className="tabs">
        {(Object.keys(SCOPE_LABEL) as Scope[]).map((s) => (
          <button key={s} className={scope === s ? "on" : ""} onClick={() => setScope(s)}>{SCOPE_LABEL[s]}</button>
        ))}
      </div>
      <canvas ref={out} width={scope === "vector" ? CH : SW} height={CH} className="scope-canvas" aria-label={SCOPE_LABEL[scope]} />
      <div className="small muted">
        {stats}{grades ? " · con la corrección de color de este instante" : ""}. Se actualiza al mover el cursor.
      </div>
      <video ref={video} src={src} muted preload="auto" playsInline crossOrigin="anonymous" hidden />
    </div>
  );
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Pinta el scope y devuelve un resumen (negros y blancos recortados, brillo medio). */
function paint(cv: HTMLCanvasElement, scope: Scope, px: Uint8ClampedArray, w: number, h: number): string {
  const ctx = cv.getContext("2d")!;
  const W = cv.width;
  const H = cv.height;
  ctx.fillStyle = "#0e0e0d";
  ctx.fillRect(0, 0, W, H);
  const n = w * h;
  let clipLo = 0;
  let clipHi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const y = luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    sum += y;
    if (y <= 4) clipLo++;
    if (y >= 251) clipHi++;
  }
  const img = ctx.createImageData(W, H);
  const add = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const k = (Math.floor(y) * W + Math.floor(x)) * 4;
    img.data[k] = Math.min(255, img.data[k] + r);
    img.data[k + 1] = Math.min(255, img.data[k + 1] + g);
    img.data[k + 2] = Math.min(255, img.data[k + 2] + b);
    img.data[k + 3] = 255;
  };
  const gain = Math.max(6, Math.round(1600 / h));
  if (scope === "waveform" || scope === "parade") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4;
        const [r, g, b] = [px[k], px[k + 1], px[k + 2]];
        if (scope === "waveform") {
          add(x * (W / w), (H - 1) * (1 - luma(r, g, b) / 255), gain, gain, gain);
        } else {
          const third = W / 3;
          const xx = (x / w) * third;
          add(xx, (H - 1) * (1 - r / 255), gain * 1.6, 0, 0);
          add(third + xx, (H - 1) * (1 - g / 255), 0, gain * 1.6, 0);
          add(2 * third + xx, (H - 1) * (1 - b / 255), 0, 0, gain * 1.6);
        }
      }
    }
  } else if (scope === "vector") {
    for (let i = 0; i < n; i++) {
      const [r, g, b] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
      const cb = -0.1146 * r - 0.3854 * g + 0.5 * b;
      const cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
      add(W / 2 + (cb / 128) * (W / 2) * 0.95, H / 2 - (cr / 128) * (H / 2) * 0.95, r * 0.12 + 8, g * 0.12 + 8, b * 0.12 + 8);
    }
  }
  if (scope !== "histogram") ctx.putImageData(img, 0, 0);
  if (scope === "histogram") {
    const bins = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) bins[c][px[i * 4 + c]]++;
    const max = Math.max(...bins.flatMap((b) => b.slice(1, 255)), 1);
    ctx.globalCompositeOperation = "lighter";
    ["rgba(230,60,60,0.75)", "rgba(60,200,80,0.75)", "rgba(70,120,255,0.75)"].forEach((col, c) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let v = 0; v < 256; v++) ctx.lineTo((v / 255) * W, H - Math.min(1, bins[c][v] / max) * (H - 4));
      ctx.lineTo(W, H);
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
  }
  // Guías
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  if (scope === "vector") {
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, (W / 2) * 0.95, 0, Math.PI * 2);
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    // Línea de tono de piel (≈ 123° en un vectorscopio)
    ctx.strokeStyle = "rgba(245,196,81,0.6)";
    ctx.beginPath();
    ctx.moveTo(W / 2, H / 2);
    const a = (123 * Math.PI) / 180;
    ctx.lineTo(W / 2 + Math.cos(a) * W * 0.47, H / 2 - Math.sin(a) * H * 0.47);
    ctx.stroke();
  } else if (scope !== "histogram") {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const y = Math.round((H - 1) * (1 - v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
  }
  const pct = (v: number) => `${((v / n) * 100).toFixed(1)} %`;
  return `Brillo medio ${Math.round((sum / n / 255) * 100)} % · negros recortados ${pct(clipLo)} · blancos recortados ${pct(clipHi)}`;
}
