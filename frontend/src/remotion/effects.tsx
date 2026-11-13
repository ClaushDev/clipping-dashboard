/**
 * Capa de enganche: formas que señalan (círculo, recuadro, flecha, subrayado), barra «espera…» y efectos de cámara.
 * Las formas se dibujan en un SVG del tamaño del lienzo; los efectos de cámara transforman solo el vídeo.
 */
import React from "react";
import { AbsoluteFill, interpolate, random, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fontFamily } from "./fonts";
import type { Fx, ProgressOverlay, ShapeOverlay } from "./schema";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Posición de la forma en el instante t: la fija o la interpolada de `path` (seguimiento de un objeto). */
function shapePos(o: ShapeOverlay, t: number): { x: number; y: number } {
  const p = o.path;
  if (!p?.length) return { x: o.x, y: o.y };
  if (t <= p[0].t) return p[0];
  for (let i = 1; i < p.length; i++) {
    if (t < p[i].t) {
      const k = (t - p[i - 1].t) / Math.max(p[i].t - p[i - 1].t, 1e-6);
      return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * k, y: p[i - 1].y + (p[i].y - p[i - 1].y) * k };
    }
  }
  return p[p.length - 1];
}

/** Elipse «a mano»: algo más de una vuelta, con el radio variando un poco, como un rotulador. */
function handCircle(cx: number, cy: number, rx: number, ry: number): string {
  const steps = 64;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = -0.6 + (i / steps) * (Math.PI * 2 + 0.5);
    const wob = 1 + 0.035 * Math.sin(a * 3) + 0.05 * (i / steps);
    pts.push(`${(cx + Math.cos(a) * rx * wob).toFixed(1)},${(cy + Math.sin(a) * ry * wob).toFixed(1)}`);
  }
  return "M" + pts.join(" L");
}

export const ShapeView: React.FC<{ o: ShapeOverlay }> = ({ o }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const dur = o.end - o.start;
  const scale = height / 1920;
  const { x, y } = shapePos(o, t);
  const cx = x * width;
  const cy = y * height;
  const sw = Math.max(2, o.stroke * scale);
  const draw = o.anim === "draw" ? interpolate(t, [0, 0.45], [0, 1], { ...clamp, easing: (v) => 1 - Math.pow(1 - v, 2) }) : 1;
  const fadeOut = interpolate(t, [dur - 0.2, dur], [1, 0], clamp);
  const pop = o.anim === "pop" ? spring({ frame, fps, config: { damping: 11, mass: 0.6, overshootClamping: true } }) : 1;
  const fadeIn = o.anim === "fade" ? interpolate(t, [0, 0.25], [0, 1], clamp) : 1;

  let paths: string[] = [];
  let head: string | null = null;
  if (o.shape === "circle") {
    paths = [handCircle(cx, cy, (o.w * width) / 2, (o.h * height) / 2)];
  } else if (o.shape === "box") {
    const w = o.w * width;
    const h = o.h * height;
    const l = cx - w / 2;
    const tp = cy - h / 2;
    paths = [`M${l},${tp} L${l + w},${tp} L${l + w},${tp + h} L${l},${tp + h} Z`];
  } else if (o.shape === "underline") {
    const w = o.w * width;
    paths = [`M${cx - w / 2},${cy} Q${cx},${cy + 18 * scale} ${cx + w / 2},${cy - 6 * scale}`];
  } else {
    // Flecha: (x, y) es la punta; el cuerpo sale en sentido contrario a `rotation` con una ligera curva.
    const len = o.w * width;
    const a = (o.rotation * Math.PI) / 180;
    const tx = cx - Math.cos(a) * len;
    const ty = cy - Math.sin(a) * len;
    const mx = (cx + tx) / 2 - Math.sin(a) * len * 0.12;
    const my = (cy + ty) / 2 + Math.cos(a) * len * 0.12;
    paths = [`M${tx},${ty} Q${mx},${my} ${cx},${cy}`];
    const hl = Math.max(28 * scale, len * 0.22);
    const back = Math.atan2(cy - my, cx - mx);
    const h1 = [cx - Math.cos(back - 0.5) * hl, cy - Math.sin(back - 0.5) * hl];
    const h2 = [cx - Math.cos(back + 0.5) * hl, cy - Math.sin(back + 0.5) * hl];
    head = `M${h1[0]},${h1[1]} L${cx},${cy} L${h2[0]},${h2[1]}`;
  }
  const headOpacity = o.anim === "draw" ? interpolate(t, [0.35, 0.5], [0, 1], clamp) : 1;

  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeOut, fadeIn), transform: `scale(${pop})`, transformOrigin: `${cx}px ${cy}px` }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0 }}>
        {paths.map((d, i) => (
          <g key={i} fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d={d} pathLength={1} stroke="rgba(0,0,0,0.45)" strokeWidth={sw * 1.6} strokeDasharray={1} strokeDashoffset={1 - draw} />
            <path d={d} pathLength={1} stroke={o.color} strokeWidth={sw} strokeDasharray={1} strokeDashoffset={1 - draw} />
          </g>
        ))}
        {head && (
          <g fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={headOpacity}>
            <path d={head} stroke="rgba(0,0,0,0.45)" strokeWidth={sw * 1.6} />
            <path d={head} stroke={o.color} strokeWidth={sw} />
          </g>
        )}
      </svg>
    </AbsoluteFill>
  );
};

export const ProgressView: React.FC<{ o: ProgressOverlay; style: React.CSSProperties }> = ({ o, style }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = height / 1920;
  const p = interpolate(frame / fps, [0, Math.max(0.2, o.end - o.start - 0.15)], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: (o.x - o.w / 2) * width, top: o.y * height, width: o.w * width, translate: "0 -50%", ...style }}>
      <div style={{ fontFamily: fontFamily("Montserrat"), fontWeight: 900, fontSize: 64 * scale, color: "#fff", textAlign: "center",
        marginBottom: 16 * scale, WebkitTextStroke: `${8 * scale}px #000`, paintOrder: "stroke fill" }}>{o.text}</div>
      <div style={{ height: 28 * scale, borderRadius: 14 * scale, background: "rgba(0,0,0,0.6)", border: `${4 * scale}px solid #fff`, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${p * 100}%`, background: o.color }} />
      </div>
    </div>
  );
};

const active = (fx: Fx[], t: number) => fx.filter((e) => t >= e.start && t < e.end);

/** «Barrido» o «deslizar» colocado sobre un corte: se dibuja con los dos planos a la vez (Shot en Main.tsx). */
export interface CutTransition { kind: "whip" | "slide"; len: number; dir: [number, number]; amount: number }

/** Asigna cada barrido/deslizar al corte más cercano a su centro (a menos de un cuarto de su duración, mínimo 0,15 s).
 *  `at[i]` = transición del corte entre el plano i-1 y el i. Los que no caen en un corte siguen en CameraFx. */
export function cutTransitions(fx: Fx[], starts: number[], ends: number[]): { at: (CutTransition | undefined)[]; used: Set<string> } {
  const at: (CutTransition | undefined)[] = starts.map(() => undefined);
  const used = new Set<string>();
  for (const e of fx) {
    if (e.kind !== "whip" && e.kind !== "slide") continue;
    const mid = (e.start + e.end) / 2;
    const tol = Math.max(0.15, (e.end - e.start) / 4);
    let best = -1;
    for (let i = 1; i < starts.length; i++) {
      if (Math.abs(ends[i - 1] - starts[i]) > 0.05 || at[i]) continue;
      const d = Math.abs(starts[i] - mid);
      if (d <= tol && (best < 0 || d < Math.abs(starts[best] - mid))) best = i;
    }
    if (best < 0) continue;
    at[best] = { kind: e.kind, len: Math.max(0.1, e.end - e.start), dir: DIRS[e.dir ?? "left"], amount: e.amount || 1 };
    used.add(e.id);
  }
  return { at, used };
}
/** 0 al principio y al final, 1 en el corte (mitad), con entrada y salida suaves. */
const bell = (p: number) => { const x = 1 - Math.abs(p * 2 - 1); return x * x * (3 - 2 * x); };
const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const DIRS: Record<NonNullable<Fx["dir"]>, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** Transforma el vídeo (escenas y tramos) según los efectos activos: zooms, temblor, glitch, blanco y negro. */
export const CameraFx: React.FC<{ fx: Fx[]; children: React.ReactNode }> = ({ fx, children }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const on = active(fx, t);
  // Siempre el mismo árbol (con o sin efecto activo): si cambiara, React volvería a montar los vídeos de dentro y el
  // Reproductor enseñaría negro al empezar y al acabar cada efecto mientras los recarga.
  let zoom = 1;
  let ox = 0.5;
  let oy = 0.5;
  let dx = 0;
  let dy = 0;
  let rot = 0;
  let cover = 1; // Zoom mínimo para que el desplazamiento no enseñe bordes negros
  const filters: string[] = [];
  for (const e of on) {
    const local = t - e.start;
    if (e.kind === "punch") {
      if (e.ramp) {
        // Con rampa: entra y sale suave en `ramp` segundos (vuelve al encuadre normal al terminar el énfasis).
        const len = e.end - e.start;
        const r = Math.min(e.ramp, len / 2);
        const p = Math.min(interpolate(local, [0, r], [0, 1], clamp), interpolate(local, [len - r, len], [1, 0], clamp));
        zoom *= 1 + e.amount * ease(p);
      } else {
        // Entra en ~0,12 s con salida suave (sin rebote) y se mantiene hasta el final del efecto.
        zoom *= 1 + e.amount * (1 - Math.pow(1 - Math.min(1, local / 0.12), 3));
      }
      ox = e.x;
      oy = e.y;
    } else if (e.kind === "zoom") {
      let p = interpolate(local, [0, e.end - e.start], [0, 1], clamp);
      if (e.steps && e.steps > 1) {
        // Zoom digital: cada salto entra en ~0,08 s y se mantiene hasta el siguiente
        const len = (e.end - e.start) / e.steps;
        const k = Math.min(e.steps - 1, Math.floor(local / len));
        p = (k + Math.min(1, (local - k * len) / 0.08)) / e.steps;
      }
      zoom *= 1 + e.amount * (e.steps && e.steps > 1 ? p : p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
      ox = e.x;
      oy = e.y;
    } else if (e.kind === "shake") {
      const amp = 28 * e.amount * (height / 1920);
      cover = Math.max(cover, 1 + (2 * amp) / width); // Fijo: si siguiera a cada sacudida, el zoom temblaría
      dx += (random(`sx${frame}${e.id}`) - 0.5) * 2 * amp;
      dy += (random(`sy${frame}${e.id}`) - 0.5) * 2 * amp;
    } else if (e.kind === "glitch") {
      cover = Math.max(cover, 1 + (60 * e.amount * (height / 1920)) / width);
      if (random(`g${Math.floor(frame / 2)}${e.id}`) < 0.6) {
        dx += (random(`gx${frame}${e.id}`) - 0.5) * 60 * e.amount * (height / 1920);
        filters.push(`hue-rotate(${Math.round(random(`gh${frame}`) * 180)}deg) saturate(${1 + e.amount * 2})`);
      }
    } else if (e.kind === "bw") {
      filters.push(`grayscale(${Math.min(1, e.amount || 1)}) contrast(1.15)`);
    } else if (e.kind === "pan") {
      // Barrido lento hacia `dir`: se amplía lo justo para tener margen y se recorre de un lado al otro.
      const p = ease(interpolate(local, [0, e.end - e.start], [0, 1], clamp));
      const a = Math.min(0.5, e.amount || 0.15);
      const [ux, uy] = DIRS[e.dir ?? "right"];
      cover = Math.max(cover, 1 + a);
      dx -= ux * (p - 0.5) * a * width;
      dy -= uy * (p - 0.5) * a * height;
    } else if (e.kind === "drift") {
      const a = width * 0.008 * (e.amount || 0.5);
      dx += Math.sin(t * 0.9) * a + Math.sin(t * 2.3) * a * 0.3;
      dy += Math.cos(t * 0.7) * a;
      rot += Math.sin(t * 0.5) * 0.8 * (e.amount || 0.5);
      cover = Math.max(cover, 1 + 0.04 * (e.amount || 0.5));
    } else if (e.kind === "whip" || e.kind === "slide") {
      // Transición centrada en el corte: la imagen sale disparada hacia `dir` y la siguiente entra desde el otro lado.
      const len = e.end - e.start;
      const p = interpolate(local, [0, len], [0, 1], clamp);
      const [ux, uy] = DIRS[e.dir ?? "left"];
      const reach = e.kind === "whip" ? 0.35 * (e.amount || 1) : 1;
      const off = p < 0.5 ? Math.pow(p * 2, 2) : -Math.pow((1 - p) * 2, 2); // Acelera hasta el corte y frena después
      dx += ux * off * reach * width;
      dy += uy * off * reach * height;
      if (e.kind === "whip") {
        const blur = Math.sin(p * Math.PI) * 28 * (e.amount || 1) * (height / 1920);
        filters.push(`blur(${blur.toFixed(1)}px)`);
        cover = Math.max(cover, 1.05);
      }
    } else if (e.kind === "zoom_cut") {
      // Zoom que atraviesa el corte: se acerca deprisa hasta el corte y la nueva imagen llega acercada y se abre.
      const p = interpolate(local, [0, e.end - e.start], [0, 1], clamp);
      const peak = 1 + 0.8 * (e.amount || 1);
      zoom *= p < 0.5 ? 1 + (peak - 1) * Math.pow(p * 2, 2) : 1 + (peak - 1) * Math.pow((1 - p) * 2, 2);
      filters.push(`blur(${(Math.sin(p * Math.PI) * 14 * (height / 1920)).toFixed(1)}px)`);
      ox = e.x;
      oy = e.y;
    } else if (e.kind === "zoom_through") {
      // Se mete muy dentro del punto (×5 con la intensidad 1) acelerando, y el plano nuevo sale de ahí frenando.
      const p = interpolate(local, [0, e.end - e.start], [0, 1], clamp);
      const peak = 1 + 4 * (e.amount || 1);
      const q = p < 0.5 ? Math.pow(p * 2, 3) : Math.pow((1 - p) * 2, 3);
      zoom *= Math.pow(peak, q);
      rot += (p < 0.5 ? q : -q) * 6 * (e.amount || 1);
      filters.push(`blur(${(q * 22 * (height / 1920)).toFixed(1)}px) brightness(${(1 + q * 0.35).toFixed(2)})`);
      ox = e.x;
      oy = e.y;
    } else if (e.kind === "blur" || e.kind === "blur_zoom") {
      // El plano se desenfoca hasta el corte y el siguiente llega borroso y se aclara. amount = radio (1 = 36 px a 1080p).
      const p = interpolate(local, [0, e.end - e.start], [0, 1], clamp);
      const q = bell(p);
      filters.push(`blur(${(q * 36 * (e.amount || 1) * (height / 1920)).toFixed(1)}px)`);
      if (e.kind === "blur_zoom") {
        zoom *= 1 + 0.25 * (e.amount || 1) * q;
        ox = e.x;
        oy = e.y;
      }
    } else if (e.kind === "leak") {
      // La fuga de luz también sobreexpone un poco el vídeo (la mancha de color va encima, en FlashFx).
      const p = interpolate(local, [0, e.end - e.start], [0, 1], clamp);
      filters.push(`brightness(${(1 + bell(p) * 0.3 * (e.amount || 1)).toFixed(2)})`);
    }
  }
  // Zoom mínimo para que ni el desplazamiento ni el giro dejen ver el borde negro: el margen que deja la ampliación
  // Hacia cada lado depende del punto de origen del zoom.
  const rad = Math.abs((rot * Math.PI) / 180);
  const turn = Math.cos(rad) + Math.sin(rad) * Math.max(width / height, height / width);
  const mx = Math.max(0.2, Math.min(ox, 1 - ox));
  const my = Math.max(0.2, Math.min(oy, 1 - oy));
  const z = on.length ? Math.max(1, zoom, cover, turn, 1 + Math.abs(dx) / (mx * width), 1 + Math.abs(dy) / (my * height)) : 1;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill style={on.length ? { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${z})`, transformOrigin: `${ox * 100}% ${oy * 100}%`,
        filter: filters.join(" ") || undefined } : undefined}>
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Fuga de luz: dos manchas de color que cruzan el plano en diagonal y se encienden en el corte. */
const Leak: React.FC<{ e: Fx; t: number }> = ({ e, t }) => {
  const p = interpolate(t - e.start, [0, e.end - e.start], [0, 1], clamp);
  const c = e.color || "#ff9a3c";
  const a = Math.min(1, bell(p) * (e.amount || 1));
  const x1 = -20 + p * 90;
  const x2 = 110 - p * 70;
  return (
    <AbsoluteFill style={{ mixBlendMode: "screen", opacity: a,
      background: `radial-gradient(ellipse 70% 55% at ${x1}% ${30 + p * 20}%, ${c} 0%, transparent 70%), `
        + `radial-gradient(ellipse 55% 45% at ${x2}% ${75 - p * 25}%, ${c}cc 0%, transparent 65%), `
        + `linear-gradient(${120 + p * 40}deg, transparent 20%, rgba(255,240,210,${(0.5 * a).toFixed(2)}) 50%, transparent 80%)` }} />
  );
};

/** Destellos, fugas de luz y franjas del glitch, por encima del vídeo. */
export const FlashFx: React.FC<{ fx: Fx[] }> = ({ fx }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const t = frame / fps;
  const on = active(fx, t).filter((e) => e.kind === "flash" || e.kind === "glitch" || e.kind === "leak");
  if (!on.length) return null;
  return (
    <>
      {on.map((e) => {
        if (e.kind === "flash") {
          const o = interpolate(t - e.start, [0, e.end - e.start], [Math.min(1, e.amount || 0.9), 0], clamp);
          return <AbsoluteFill key={e.id} style={{ backgroundColor: e.color || "white", opacity: o }} />;
        }
        if (e.kind === "leak") return <Leak key={e.id} e={e} t={t} />;
        if (random(`gb${Math.floor(frame / 2)}${e.id}`) > 0.55) return null;
        const bars = [0, 1, 2].map((i) => ({
          top: random(`gt${frame}${i}${e.id}`) * height,
          h: (6 + random(`gw${frame}${i}`) * 40) * (height / 1920),
          color: i % 2 ? "rgba(255,0,80,0.35)" : "rgba(0,255,230,0.35)",
        }));
        return (
          <AbsoluteFill key={e.id} style={{ mixBlendMode: "screen" }}>
            {bars.map((b, i) => <div key={i} style={{ position: "absolute", left: 0, right: 0, top: b.top, height: b.h, background: b.color }} />)}
          </AbsoluteFill>
        );
      })}
    </>
  );
};
