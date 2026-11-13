/** Capas de ajuste, etalonaje y máscaras. La capa de ajuste corrige el color de todo lo que hay debajo de ella
 *  (el vídeo y las capas anteriores de la lista) con un filtro SVG en `backdrop-filter`; los subtítulos van encima. */
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { type AdjustOverlay, type Grade, keyedAt, type Lut, type Mask } from "./schema";

/** Matriz de color 3×4 (filas r, g, b: coeficientes de r, g, b y desplazamiento). */
type Matrix = number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function saturate(s: number): Matrix {
  const [r, g, b] = [0.2126 * (1 - s), 0.7152 * (1 - s), 0.0722 * (1 - s)];
  return [r + s, g, b, 0, r, g + s, b, 0, r, g, b + s, 0];
}

function mul(a: Matrix, b: Matrix): Matrix {
  // A · b (b primero)
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      let v = j === 3 ? a[i * 4 + 3] : 0;
      for (let k = 0; k < 3; k++) v += a[i * 4 + k] * b[k * 4 + j];
      out.push(v);
    }
  }
  return out;
}

/** Looks incluidos: curvas por canal (tabla 0-1 de 5 puntos) y una matriz. */
export const LOOKS: Record<string, { label: string; curves?: [number[], number[], number[]]; matrix?: Matrix }> = {
  teal_orange: {
    label: "Cine (teal & orange)",
    curves: [[0, 0.16, 0.52, 0.87, 1], [0, 0.19, 0.5, 0.81, 0.99], [0.07, 0.27, 0.5, 0.72, 0.9]],
    matrix: saturate(1.15),
  },
  warm: { label: "Cálido dorado", curves: [[0.03, 0.28, 0.55, 0.8, 1], [0.01, 0.25, 0.51, 0.76, 0.98], [0, 0.19, 0.43, 0.68, 0.9]] },
  cool: { label: "Frío", curves: [[0, 0.21, 0.46, 0.72, 0.95], [0, 0.24, 0.5, 0.76, 0.99], [0.05, 0.3, 0.56, 0.8, 1]] },
  bw: { label: "Blanco y negro", curves: [[0, 0.18, 0.5, 0.84, 1], [0, 0.18, 0.5, 0.84, 1], [0, 0.18, 0.5, 0.84, 1]], matrix: saturate(0) },
  noir: { label: "Noir (contraste duro)", curves: [[0, 0.08, 0.45, 0.9, 1], [0, 0.08, 0.45, 0.9, 1], [0, 0.08, 0.45, 0.9, 1]], matrix: saturate(0) },
  vintage: {
    label: "Vintage",
    curves: [[0.1, 0.32, 0.56, 0.78, 0.94], [0.08, 0.29, 0.52, 0.74, 0.9], [0.1, 0.26, 0.45, 0.64, 0.8]],
    matrix: saturate(0.7),
  },
  bleach: { label: "Bleach bypass", curves: [[0, 0.13, 0.5, 0.88, 1], [0, 0.13, 0.5, 0.88, 1], [0, 0.13, 0.5, 0.88, 1]], matrix: saturate(0.45) },
  night: {
    label: "Noche azul",
    curves: [[0, 0.12, 0.33, 0.55, 0.75], [0, 0.15, 0.38, 0.62, 0.82], [0.06, 0.26, 0.52, 0.76, 0.95]],
    matrix: saturate(0.6),
  },
  vivid: { label: "Vivo", curves: [[0, 0.2, 0.5, 0.82, 1], [0, 0.2, 0.5, 0.82, 1], [0, 0.2, 0.5, 0.82, 1]], matrix: saturate(1.45) },
  matte: { label: "Mate (negros lavados)", curves: [[0.12, 0.3, 0.52, 0.76, 0.95], [0.12, 0.3, 0.52, 0.76, 0.95], [0.13, 0.31, 0.52, 0.75, 0.93]], matrix: saturate(0.85) },
};

const table = (v: number[]) => v.map((x) => x.toFixed(4)).join(" ");
const matrixValues = (m: Matrix) =>
  [0, 1, 2].map((i) => `${m[i * 4]} ${m[i * 4 + 1]} ${m[i * 4 + 2]} 0 ${m[i * 4 + 3]}`).join("  ") + "  0 0 0 1 0";

/** Filtro SVG con el etalonaje: exposición y contraste, saturación, temperatura y matiz, y el look o LUT mezclado con su
 *  intensidad. */
export const GradeFilter: React.FC<{ id: string; g: Grade }> = ({ id, g }) => {
  const e = Math.pow(2, g.exposure ?? 0);
  const c = g.contrast ?? 1;
  const temp = g.temperature ?? 0;
  const tint = g.tint ?? 0;
  const tone = mul(
    [1 + 0.14 * temp + 0.05 * tint, 0, 0, 0, 0, 1 - 0.07 * tint, 0, 0, 0, 0, 1 - 0.14 * temp + 0.05 * tint, 0],
    saturate(g.saturation ?? 1),
  );
  const look: { curves?: [number[], number[], number[]]; matrix?: Matrix } | undefined =
    g.look === "lut" ? g.lut : g.look ? LOOKS[g.look] : undefined;
  const amount = g.amount ?? 1;
  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
      <filter id={id} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
        <feComponentTransfer>
          {(["R", "G", "B"] as const).map((ch) => (
            React.createElement(`feFunc${ch}`, { key: ch, type: "linear", slope: e * c, intercept: 0.5 - 0.5 * c })
          ))}
        </feComponentTransfer>
        <feColorMatrix type="matrix" values={matrixValues(tone)} result="base" />
        {look && (
          <>
            {look.curves ? (
              <feComponentTransfer in="base">
                {(["R", "G", "B"] as const).map((ch, i) => (
                  React.createElement(`feFunc${ch}`, { key: ch, type: "table", tableValues: table(look.curves![i]) })
                ))}
              </feComponentTransfer>
            ) : <feOffset in="base" dx={0} dy={0} />}
            <feColorMatrix type="matrix" values={matrixValues(look.matrix ?? IDENTITY)} result="look" />
            <feComposite in="look" in2="base" operator="arithmetic" k1={0} k2={amount} k3={1 - amount} k4={0} />
          </>
        )}
      </filter>
    </svg>
  );
};

/** Máscara (rectángulo, elipse o polígono a mano) como imagen SVG del tamaño del lienzo, con el borde suavizado. */
export function maskStyle(m: Mask, width: number, height: number, dx = 0, dy = 0, scale = 1): React.CSSProperties {
  const cx = (m.x + dx) * width;
  const cy = (m.y + dy) * height;
  const w = m.w * width * scale;
  const h = m.h * height * scale;
  const blur = Math.max(0, m.feather) * Math.min(width, height) * 0.5;
  let shape: string;
  if (m.shape === "ellipse") shape = `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}"`;
  else if (m.shape === "poly" && m.points && m.points.length >= 3) {
    // Los puntos van en el lienzo; con fotogramas clave se mueven y escalan alrededor del centro de la máscara.
    const pts = m.points.map(([x, y]) => `${(m.x + dx + (x - m.x) * scale) * width},${(m.y + dy + (y - m.y) * scale) * height}`);
    shape = `<polygon points="${pts.join(" ")}"`;
  } else shape = `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}"`;
  const f = blur > 0 ? ` filter="url(#b)"` : "";
  const defs = blur > 0
    ? `<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(blur / 2).toFixed(1)}"/></filter>` : "";
  const body = m.invert
    ? `<mask id="m">${`<rect width="${width}" height="${height}" fill="white"/>`}${shape} fill="black"${f}/></mask>`
      + `<rect width="${width}" height="${height}" fill="white" mask="url(#m)"/>`
    : `${shape} fill="white"${f}/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs}</defs>${body}</svg>`;
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  return { maskImage: url, WebkitMaskImage: url, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" };
}

/** Opacidad de la capa de ajuste: fundido de entrada y salida si `anim` es "fade", por las claves si las tiene. */
function adjustOpacity(o: AdjustOverlay, t: number): number {
  const dur = o.end - o.start;
  const fade = o.anim === "fade"
    ? Math.min(interpolate(t, [0, 0.4], [0, 1], { extrapolateRight: "clamp" }), interpolate(t, [dur - 0.4, dur], [1, 0], { extrapolateLeft: "clamp" }))
    : 1;
  return Math.max(0, Math.min(1, fade * keyedAt(o, t).opacity));
}

/** Viñeta: bordes oscurecidos. */
const vignette = (v: number) => `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.round(60 - v * 25)}%, rgba(0,0,0,${(0.35 + v * 0.5).toFixed(2)}) 100%)`;

/** Capa de ajuste con máscara a mano o sin máscara. Va dentro de su Sequence (t relativo a la capa). */
export const AdjustView: React.FC<{ o: AdjustOverlay }> = ({ o }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const k = keyedAt(o, t);
  const opacity = adjustOpacity(o, t);
  const mask = o.mask && o.mask.shape !== "subject" ? maskStyle(o.mask, width, height, k.x - o.x, k.y - o.y, k.scale) : {};
  const id = `grade-${o.id}`;
  // Backdrop-filter: la máscara va en el mismo elemento (en un padre lo convertiría en raíz del fondo y no vería nada).
  return (
    <>
      <GradeFilter id={id} g={o.grade} />
      <AbsoluteFill style={{ backdropFilter: `url(#${id})`, WebkitBackdropFilter: `url(#${id})`, opacity, ...mask }} />
      {!!o.grade.vignette && <AbsoluteFill style={{ background: vignette(o.grade.vignette), opacity, ...mask }} />}
    </>
  );
};

/** Capa de ajuste con la máscara del sujeto recortado (5b): corrige solo el sujeto, o todo menos el sujeto. Como los
 *  recortes, va fuera de Sequence (los planos necesitan el tiempo de la timeline). */
export const AdjustSubject: React.FC<{ o: AdjustOverlay; base: (matte: boolean) => React.ReactNode }> = ({ o, base }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps - o.start;
  if (t < 0) return <AbsoluteFill style={{ opacity: 0 }}>{base(true)}</AbsoluteFill>; // Montado antes, invisible
  const opacity = adjustOpacity(o, t);
  const id = `grade-${o.id}`;
  if (o.mask?.invert) {
    // Todo menos el sujeto: se corrige lo de debajo y el sujeto se vuelve a dibujar tal cual encima.
    return (
      <>
        <GradeFilter id={id} g={o.grade} />
        <AbsoluteFill style={{ backdropFilter: `url(#${id})`, WebkitBackdropFilter: `url(#${id})`, opacity }} />
        {!!o.grade.vignette && <AbsoluteFill style={{ background: vignette(o.grade.vignette), opacity }} />}
        <AbsoluteFill style={{ opacity }}>{base(true)}</AbsoluteFill>
      </>
    );
  }
  return (
    <>
      <GradeFilter id={id} g={o.grade} />
      <AbsoluteFill style={{ filter: `url(#${id})`, opacity }}>{base(true)}</AbsoluteFill>
    </>
  );
};

/** Ajusta un LUT .cube (3D) a lo que se puede dibujar en vivo: curvas por canal sacadas de la diagonal gris y una matriz
 *  3×4 por mínimos cuadrados. `fit`: parecido medio con el LUT original (1 = idéntico). */
export function fitCube(text: string, name: string): Lut {
  let size = 0;
  const rows: number[][] = [];
  let dmin = [0, 0, 0];
  let dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === "LUT_3D_SIZE") size = Number(rest[0]);
    else if (key === "DOMAIN_MIN") dmin = rest.map(Number);
    else if (key === "DOMAIN_MAX") dmax = rest.map(Number);
    else if (/^[-\d.]/.test(key)) {
      const v = [key, ...rest].slice(0, 3).map(Number);
      if (v.length === 3 && v.every(Number.isFinite)) rows.push(v);
    }
  }
  if (!size || rows.length < size ** 3) throw new Error("No es un LUT 3D .cube válido (falta LUT_3D_SIZE o faltan filas).");
  const norm = (v: number[]) => v.map((x, i) => (x - dmin[i]) / (dmax[i] - dmin[i] || 1));
  // Orden .cube: el rojo cambia más rápido.
  const at = (r: number, g: number, b: number) => norm(rows[r + g * size + b * size * size]);
  const n = 17;
  const curves: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < n; i++) {
    const p = (i / (n - 1)) * (size - 1);
    const lo = Math.floor(p);
    const hi = Math.min(size - 1, lo + 1);
    const f = p - lo;
    const a = at(lo, lo, lo);
    const b = at(hi, hi, hi);
    for (let ch = 0; ch < 3; ch++) curves[ch].push(Math.max(0, Math.min(1, a[ch] + (b[ch] - a[ch]) * f)));
  }
  const curve = (ch: number, v: number) => {
    const p = Math.max(0, Math.min(1, v)) * (n - 1);
    const lo = Math.floor(p);
    const hi = Math.min(n - 1, lo + 1);
    return curves[ch][lo] + (curves[ch][hi] - curves[ch][lo]) * (p - lo);
  };
  // Muestras: x = curvas(entrada), y = LUT(entrada); matriz por mínimos cuadrados (ecuaciones normales 4×4).
  const step = Math.max(1, Math.floor(size / 9));
  const xs: number[][] = [];
  const ys: number[][] = [];
  for (let b = 0; b < size; b += step) for (let g = 0; g < size; g += step) for (let r = 0; r < size; r += step) {
    const inp = [r, g, b].map((v) => v / (size - 1));
    xs.push([curve(0, inp[0]), curve(1, inp[1]), curve(2, inp[2]), 1]);
    ys.push(at(r, g, b));
  }
  const matrix: number[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const A = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => xs.reduce((s, x) => s + x[i] * x[j], 0) + (i === j ? 1e-6 : 0)));
    const y = [0, 1, 2, 3].map((i) => xs.reduce((s, x, k) => s + x[i] * ys[k][ch], 0));
    matrix.push(...solve4(A, y));
  }
  let err = 0;
  xs.forEach((x, k) => {
    for (let ch = 0; ch < 3; ch++) {
      const v = matrix[ch * 4] * x[0] + matrix[ch * 4 + 1] * x[1] + matrix[ch * 4 + 2] * x[2] + matrix[ch * 4 + 3];
      err += Math.abs(Math.max(0, Math.min(1, v)) - ys[k][ch]);
    }
  });
  const fit = Math.max(0, 1 - (err / (xs.length * 3)) * 4);
  return { name, curves, matrix: matrix.map((v) => +v.toFixed(4)), fit: +fit.toFixed(3) };
}

function solve4(A: number[][], y: number[]): number[] {
  const m = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 5; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[4] / row[i]);
}
