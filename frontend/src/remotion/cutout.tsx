/** Efectos de recorte: el sujeto recortado (rotoscopia SAM 2) por encima de fondos, marcos y textos. */
import React from "react";
import { AbsoluteFill, Img, interpolate, OffthreadVideo, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { CutoutOverlay, Overlay } from "./schema";

/** Dentro de este contexto, los tramos y escenas se dibujan con su recorte (fondo transparente) o no se dibujan. */
export const MatteContext = React.createContext(false);

export const CUTOUT_PREMOUNT = 1.5; // Segundos: se monta antes para que el recorte ya esté cargado al aparecer

/** Desplazamiento (0-1 del lienzo) de una capa que sigue una cara o un punto, en el segundo t de la capa. */
export function followOffset(o: Pick<Overlay, "follow">, t: number): [number, number] {
  const f = o.follow;
  if (!f || f.length < 2) return [0, 0];
  let p = f[f.length - 1];
  if (t <= f[0].t) p = f[0];
  else {
    for (let i = 1; i < f.length; i++) {
      if (t < f[i].t) {
        const a = f[i - 1];
        const b = f[i];
        const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
        p = { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
        break;
      }
    }
  }
  return [p.x - f[0].x, p.y - f[0].y];
}

const isVideo = (url: string) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);

/** Fondo nuevo: color, el plano original desenfocado o una imagen/vídeo. */
const Backdrop: React.FC<{ bg: string; base: (matte: boolean) => React.ReactNode; fallback: string }> = ({ bg, base, fallback }) => {
  const { height } = useVideoConfig();
  if (bg === "blur") {
    return (
      <AbsoluteFill style={{ filter: `blur(${Math.round(height / 45)}px) brightness(0.6) saturate(1.2)`, transform: "scale(1.12)" }}>
        {base(false)}
      </AbsoluteFill>
    );
  }
  if (bg && !bg.startsWith("#")) {
    const style: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
    return (
      <AbsoluteFill style={{ backgroundColor: "black" }}>
        {isVideo(bg) ? <OffthreadVideo src={bg} muted style={style} /> : <Img src={bg} style={style} />}
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ backgroundColor: bg || fallback }} />;
};

/** Papel: grano fino y una viñeta suave encima del color. */
const PAPER = "radial-gradient(rgba(0,0,0,0.06) 1px, transparent 1.4px) 0 0 / 7px 7px, "
  + "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1.4px) 3px 4px / 9px 9px";

export const CutoutLayer: React.FC<{ o: CutoutOverlay; base: (matte: boolean) => React.ReactNode }> = ({ o, base }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps - o.start;
  const dur = o.end - o.start;
  if (t < -CUTOUT_PREMOUNT || t >= dur) return null;
  const hidden = t < 0;
  const u = height / 1920;
  const s = spring({ frame: Math.max(0, t) * fps, fps, config: { damping: 15, stiffness: 140, overshootClamping: true } });
  const out = interpolate(t, [dur - 0.18, dur], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const subject = base(true);
  let body: React.ReactNode;

  switch (o.mode) {
    case "screen":
      body = <><Backdrop bg={o.bg} base={base} fallback="#101418" />{subject}</>;
      break;
    case "paper": {
      // Recortable de papel: borde blanco grueso, sombra dura y un temblor de stop motion (cambia 6 veces por segundo).
      const step = Math.floor(Math.max(0, t) * 6);
      const jitter = ((step * 7919) % 5) - 2;
      const line = Math.max(2, Math.round(5 * u));
      const c = o.color || "#ffffff";
      body = (
        <>
          <AbsoluteFill style={{ background: `${PAPER}, ${o.bg && o.bg.startsWith("#") ? o.bg : "#efe4cf"}` }} />
          {o.bg && !o.bg.startsWith("#") && <Backdrop bg={o.bg} base={base} fallback="#efe4cf" />}
          <AbsoluteFill style={{
            transform: `translate(${jitter * 2 * u}px, ${-Math.abs(jitter) * 2 * u}px) rotate(${jitter * 0.5}deg) scale(${0.86 + 0.14 * s})`,
            filter: [1, 2, 3, 4].map((k) => `drop-shadow(0 0 ${line * (k > 2 ? 1 : 0.5)}px ${c})`).join(" ")
              + ` drop-shadow(${10 * u}px ${16 * u}px 0 rgba(0,0,0,0.35))`,
          }}>
            {subject}
          </AbsoluteFill>
        </>
      );
      break;
    }
    case "escape":
    case "portal": {
      // El plano se encoge dentro de un marco (o se abre un portal) y el sujeto, que sigue a tamaño completo, se sale.
      const cx = o.x * width;
      const cy = o.y * height;
      const ring = Math.max(4, Math.round(14 * u));
      const c = o.color || "#ffffff";
      let clip: string;
      let border: React.CSSProperties;
      if (o.mode === "portal") {
        const r = (o.w * width) / 2 * s;
        clip = `circle(${r}px at ${cx}px ${cy}px)`;
        border = { left: cx - r - ring, top: cy - r - ring, width: 2 * (r + ring), height: 2 * (r + ring), borderRadius: "50%",
          boxShadow: `0 0 ${40 * u}px ${c}, inset 0 0 ${30 * u}px ${c}` };
      } else {
        const fw = width * interpolate(s, [0, 1], [1, o.w]);
        const fh = height * interpolate(s, [0, 1], [1, Math.min(0.62, o.w * 0.75)]);
        const left = Math.max(0, cx - fw / 2);
        const top = Math.max(0, cy - fh / 2);
        clip = `inset(${top}px ${width - left - fw}px ${height - top - fh}px ${left}px)`;
        border = { left: left - ring, top: top - ring, width: fw + 2 * ring, height: fh + 2 * ring,
          boxShadow: `0 ${18 * u}px ${50 * u}px rgba(0,0,0,0.55)` };
      }
      const zoom = o.mode === "portal" ? interpolate(t, [0, dur], [1, 1.14], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
      body = (
        <AbsoluteFill style={{ transform: zoom !== 1 ? `scale(${zoom})` : undefined, transformOrigin: `${cx}px ${cy}px` }}>
          <Backdrop bg={o.bg} base={base} fallback={o.mode === "portal" ? "#07060f" : "#15151a"} />
          <div style={{ position: "absolute", border: `${ring}px solid ${c}`, boxSizing: "border-box", ...border }} />
          <AbsoluteFill style={{ clipPath: clip }}>{base(false)}</AbsoluteFill>
          <AbsoluteFill style={{ filter: `drop-shadow(0 ${12 * u}px ${24 * u}px rgba(0,0,0,0.5))` }}>{subject}</AbsoluteFill>
        </AbsoluteFill>
      );
      break;
    }
    case "orbit": {
      // 2,5D: el fondo y el sujeto se mueven en sentidos contrarios, como si la cámara girase alrededor.
      const k = interpolate(t, [0, dur], [-1, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      const e = Math.sin((k * Math.PI) / 2);
      const amp = width * 0.05 * (o.w || 1);
      body = (
        <AbsoluteFill style={{ perspective: width * 1.6 }}>
          <AbsoluteFill style={{ transform: `translateX(${-e * amp}px) scale(1.16)`, filter: `blur(${Math.round(5 * u)}px) brightness(0.75)` }}>
            {base(false)}
          </AbsoluteFill>
          <AbsoluteFill style={{ transform: `translateX(${e * amp * 0.7}px) rotateY(${-e * 6}deg) scale(1.05)`,
            filter: `drop-shadow(0 ${14 * u}px ${30 * u}px rgba(0,0,0,0.55))` }}>
            {subject}
          </AbsoluteFill>
        </AbsoluteFill>
      );
      break;
    }
    default: // Behind: solo el sujeto, por delante de las capas anteriores
      body = subject;
  }
  return <AbsoluteFill style={{ opacity: hidden ? 0 : out }}>{body}</AbsoluteFill>;
};
