/**
 * Motion graphics que se pueden poner encima del clip. `component` elige el gráfico y `props` lo rellena;
 * cada componente se adapta a 16:9 y 9:16.
 */
import React from "react";
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fontFamily } from "./fonts";
import { BareContext, TEMPLATE_SPECS, templateScene } from "./templates";

export const GRAPHIC_SPECS: Record<string, string> = {
  title: '{"title": str, "subtitle": str}',
  big_number: '{"value": number, "prefix": str, "suffix": str, "label": str}',
  quote: '{"text": str, "author": str}',
  bullets: '{"title": str, "items": [str, ...] (2-5)}',
  timeline: '{"events": [{"year": str, "text": str}, ...] (2-5)}',
  comparison: '{"left": {"title": str, "items": [str]}, "right": {"title": str, "items": [str]}}',
  bar_chart: '{"title": str, "bars": [{"label": str, "value": number}, ...] (2-6), "unit": str}',
  chapter: '{"number": int, "title": str}',
  rank: '{"number": int, "total": int, "title": str, "subtitle": str}',
  case_file: '{"title": str, "number": str, "date": str, "location": str, "facts": [str, ...] (2-4), "stamp": str}',
  ...TEMPLATE_SPECS,
};

type P = Record<string, unknown>;
const str = (v: unknown, d = "") => (typeof v === "string" ? v : v === undefined || v === null ? d : String(v));
const num = (v: unknown, d = 0) => (typeof v === "number" && isFinite(v) ? v : Number(v) || d);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function useBase() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const unit = Math.min(width, height) / 1080; // Escala tipográfica común a 16:9 y 9:16
  const vertical = height > width;
  const enter = (delay = 0) => spring({ frame: frame - delay * fps, fps, config: { damping: 15, mass: 0.7 } });
  return { frame, fps, unit, vertical, enter };
}

const Frame: React.FC<{ children: React.ReactNode; accent: string }> = ({ children, accent }) => (
  <AbsoluteFill
    style={{
      // En una capa encima del vídeo (BareContext) no hay fondo
      background: React.useContext(BareContext) ? undefined
        : `radial-gradient(circle at 30% 20%, ${accent}33, transparent 55%), linear-gradient(160deg, #15171c, #0b0c0f)`,
      color: "#f4f4f2",
      fontFamily: fontFamily("Montserrat"),
      justifyContent: "center",
      alignItems: "center",
      padding: "8%",
    }}
  >
    {children}
  </AbsoluteFill>
);

const Title: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { unit, enter } = useBase();
  const a = enter();
  const b = enter(0.25);
  return (
    <Frame accent={accent}>
      <div style={{ textAlign: "center", transform: `translateY(${interpolate(a, [0, 1], [40, 0])}px)`, opacity: a }}>
        <div style={{ fontSize: 96 * unit, fontWeight: 900, lineHeight: 1.05 }}>{str(p.title)}</div>
        <div style={{ height: 10 * unit, width: `${b * 40}%`, background: accent, margin: `${30 * unit}px auto` }} />
        <div style={{ fontSize: 44 * unit, opacity: b, color: "#c9cad0" }}>{str(p.subtitle)}</div>
      </div>
    </Frame>
  );
};

const BigNumber: React.FC<{ p: P; accent: string; duration: number }> = ({ p, accent, duration }) => {
  const { frame, fps, unit, enter } = useBase();
  const value = num(p.value);
  const progress = interpolate(frame / fps, [0.1, Math.min(1.6, duration * 0.6)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: (x) => 1 - Math.pow(1 - x, 3),
  });
  const shown = Number.isInteger(value) ? Math.round(value * progress).toLocaleString("en-US") : (value * progress).toFixed(1);
  return (
    <Frame accent={accent}>
      <div style={{ textAlign: "center", opacity: enter() }}>
        <div style={{ fontSize: 200 * unit, fontWeight: 900, color: accent, lineHeight: 1 }}>
          {str(p.prefix)}
          {shown}
          {str(p.suffix)}
        </div>
        <div style={{ fontSize: 48 * unit, marginTop: 24 * unit, maxWidth: 900 * unit }}>{str(p.label)}</div>
      </div>
    </Frame>
  );
};

const Quote: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { unit, enter } = useBase();
  const a = enter();
  return (
    <Frame accent={accent}>
      <div style={{ maxWidth: 1100 * unit, opacity: a }}>
        <div style={{ fontSize: 160 * unit, color: accent, lineHeight: 0.6, fontFamily: fontFamily("Playfair Display") }}>“</div>
        <div style={{ fontSize: 62 * unit, fontFamily: fontFamily("Playfair Display"), fontStyle: "italic", lineHeight: 1.25 }}>
          {str(p.text)}
        </div>
        <div style={{ fontSize: 38 * unit, marginTop: 30 * unit, color: "#c9cad0", opacity: enter(0.4) }}>— {str(p.author)}</div>
      </div>
    </Frame>
  );
};

const Bullets: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { unit, enter } = useBase();
  const items = arr<string>(p.items).slice(0, 5);
  return (
    <Frame accent={accent}>
      <div style={{ width: "100%", maxWidth: 1300 * unit }}>
        <div style={{ fontSize: 70 * unit, fontWeight: 900, marginBottom: 40 * unit, opacity: enter() }}>{str(p.title)}</div>
        {items.map((it, i) => {
          const s = enter(0.3 + i * 0.35);
          return (
            <div key={i} style={{ display: "flex", gap: 24 * unit, alignItems: "center", fontSize: 46 * unit, marginBottom: 24 * unit,
              opacity: s, transform: `translateX(${interpolate(s, [0, 1], [-40, 0])}px)` }}>
              <span style={{ width: 22 * unit, height: 22 * unit, borderRadius: 6 * unit, background: accent, flex: "none" }} />
              {str(it)}
            </div>
          );
        })}
      </div>
    </Frame>
  );
};

const Timeline: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { unit, enter, vertical } = useBase();
  const events = arr<{ year: unknown; text: unknown }>(p.events).slice(0, 5);
  const line = enter(0.1);
  return (
    <Frame accent={accent}>
      <div style={{ position: "relative", width: "100%", display: "flex", flexDirection: vertical ? "column" : "row",
        justifyContent: "space-between", gap: 30 * unit }}>
        <div style={{ position: "absolute", background: accent, opacity: 0.6,
          ...(vertical ? { left: 14 * unit, top: 0, width: 6 * unit, height: `${line * 100}%` }
            : { top: 14 * unit, left: 0, height: 6 * unit, width: `${line * 100}%` }) }} />
        {events.map((ev, i) => {
          const s = enter(0.4 + i * 0.4);
          return (
            <div key={i} style={{ opacity: s, flex: 1, paddingLeft: vertical ? 60 * unit : 0, paddingTop: vertical ? 0 : 50 * unit, position: "relative" }}>
              <div style={{ position: "absolute", width: 34 * unit, height: 34 * unit, borderRadius: "50%", background: accent,
                ...(vertical ? { left: 0, top: 6 * unit } : { top: 0, left: 0 }) }} />
              <div style={{ fontSize: 54 * unit, fontWeight: 900, color: accent }}>{str(ev.year)}</div>
              <div style={{ fontSize: 34 * unit, lineHeight: 1.3 }}>{str(ev.text)}</div>
            </div>
          );
        })}
      </div>
    </Frame>
  );
};

const Comparison: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { unit, enter, vertical } = useBase();
  const side = (v: unknown, color: string, delay: number) => {
    const o = (v ?? {}) as P;
    const s = enter(delay);
    return (
      <div style={{ flex: 1, background: "#ffffff0d", border: `2px solid ${color}`, borderRadius: 24 * unit, padding: 40 * unit, opacity: s }}>
        <div style={{ fontSize: 58 * unit, fontWeight: 900, color, marginBottom: 20 * unit }}>{str(o.title)}</div>
        {arr<string>(o.items).slice(0, 4).map((it, i) => (
          <div key={i} style={{ fontSize: 38 * unit, marginBottom: 12 * unit }}>• {str(it)}</div>
        ))}
      </div>
    );
  };
  return (
    <Frame accent={accent}>
      <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", gap: 40 * unit, width: "100%" }}>
        {side(p.left, "#f87171", 0)}
        {side(p.right, accent, 0.4)}
      </div>
    </Frame>
  );
};

const BarChart: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { unit, enter } = useBase();
  const bars = arr<{ label: unknown; value: unknown }>(p.bars).slice(0, 6);
  const max = Math.max(...bars.map((b) => num(b.value)), 1);
  return (
    <Frame accent={accent}>
      <div style={{ width: "100%", maxWidth: 1400 * unit }}>
        <div style={{ fontSize: 60 * unit, fontWeight: 900, marginBottom: 40 * unit }}>{str(p.title)}</div>
        {bars.map((b, i) => {
          const s = enter(0.2 + i * 0.2);
          const v = num(b.value);
          return (
            <div key={i} style={{ marginBottom: 22 * unit }}>
              <div style={{ fontSize: 34 * unit, marginBottom: 8 * unit, display: "flex", justifyContent: "space-between" }}>
                <span>{str(b.label)}</span>
                <span style={{ color: accent, fontWeight: 800 }}>{(v * s).toLocaleString("en-US", { maximumFractionDigits: 1 })}{str(p.unit)}</span>
              </div>
              <div style={{ height: 30 * unit, background: "#ffffff14", borderRadius: 8 * unit }}>
                <div style={{ height: "100%", width: `${(v / max) * 100 * s}%`, background: accent, borderRadius: 8 * unit }} />
              </div>
            </div>
          );
        })}
      </div>
    </Frame>
  );
};

const Chapter: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { unit, enter } = useBase();
  const a = enter();
  return (
    <Frame accent={accent}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 40 * unit, letterSpacing: 12 * unit, color: accent, opacity: a }}>CHAPTER {num(p.number, 1)}</div>
        <div style={{ fontSize: 100 * unit, fontWeight: 900, marginTop: 16 * unit, opacity: enter(0.2),
          transform: `scale(${interpolate(enter(0.2), [0, 1], [0.9, 1])})` }}>{str(p.title)}</div>
      </div>
    </Frame>
  );
};

const Rank: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { unit, enter, vertical } = useBase();
  const n = Math.max(1, Math.round(num(p.number, 1)));
  const total = Math.min(20, Math.max(n, Math.round(num(p.total, 10))));
  const a = enter();
  const b = enter(0.2);
  return (
    <Frame accent={accent}>
      <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center", gap: 50 * unit, maxWidth: 1600 * unit }}>
        <div style={{ fontFamily: fontFamily("Anton"), fontSize: 420 * unit, lineHeight: 0.9, color: accent, transform: `scale(${interpolate(a, [0, 1], [1.6, 1])})`,
          opacity: a, textShadow: `0 ${12 * unit}px 0 rgba(0,0,0,0.35)` }}>#{n}</div>
        <div style={{ textAlign: vertical ? "center" : "left", opacity: b, transform: `translateX(${interpolate(b, [0, 1], [vertical ? 0 : 60, 0])}px)` }}>
          <div style={{ fontSize: 96 * unit, fontWeight: 900, lineHeight: 1.05 }}>{str(p.title)}</div>
          {str(p.subtitle) && <div style={{ fontSize: 44 * unit, color: "#c9cad0", marginTop: 16 * unit }}>{str(p.subtitle)}</div>}
        </div>
      </div>
      <div style={{ position: "absolute", bottom: 70 * unit, display: "flex", gap: 14 * unit }}>
        {Array.from({ length: total }, (_, i) => total - i).map((k) => (
          <div key={k} style={{ width: 22 * unit, height: 22 * unit, borderRadius: 99, background: k === n ? accent : k < n ? "#3a3d45" : "#8a8d96",
            transform: k === n ? `scale(${1 + 0.4 * b})` : undefined }} />
        ))}
      </div>
    </Frame>
  );
};

const CaseFile: React.FC<{ p: P; accent: string; duration: number }> = ({ p, accent, duration }) => {
  const { frame, fps, unit, enter, vertical } = useBase();
  const facts = arr<string>(p.facts).map((f) => str(f).trim()).filter(Boolean).slice(0, 4);
  const card = enter();
  const stamp = spring({ frame: frame - 0.5 * fps, fps, config: { damping: 9, mass: 0.5 } });
  const typed = (text: string, at: number) => {
    const n = Math.floor(Math.max(0, frame / fps - at) * 38);
    return text.slice(0, n);
  };
  const step = Math.min(1.2, Math.max(0.5, (duration - 1.2) / Math.max(1, facts.length + 1)));
  const mono = '"Courier New", Courier, monospace';
  return (
    <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 35%, #2b2420, #0d0b0a)", justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: vertical ? "86%" : "62%", background: "#efe6d2", color: "#1d1a16", padding: `${60 * unit}px ${70 * unit}px`,
        boxShadow: `0 ${30 * unit}px ${80 * unit}px rgba(0,0,0,0.6)`, transform: `rotate(-1.2deg) translateY(${(1 - card) * 80}px)`, opacity: card,
        fontFamily: mono, position: "relative" }}>
        <div style={{ fontSize: 30 * unit, letterSpacing: 6 * unit, color: "#6d6250" }}>CASE FILE {str(p.number) && `· No. ${str(p.number)}`}</div>
        <div style={{ fontSize: 66 * unit, fontWeight: 700, margin: `${16 * unit}px 0 ${24 * unit}px`, lineHeight: 1.1 }}>{str(p.title)}</div>
        <div style={{ display: "flex", gap: 40 * unit, fontSize: 32 * unit, borderTop: "2px solid #b9ab8f", borderBottom: "2px solid #b9ab8f", padding: `${12 * unit}px 0` }}>
          {str(p.date) && <span><b>DATE</b> {typed(str(p.date), 0.4)}</span>}
          {str(p.location) && <span><b>PLACE</b> {typed(str(p.location), 0.6)}</span>}
        </div>
        <div style={{ marginTop: 24 * unit, fontSize: 36 * unit, lineHeight: 1.45 }}>
          {/* Cada línea ocupa su sitio desde el principio (la tarjeta no salta) pero no se ve hasta que se teclea */}
          {facts.map((f, i) => <div key={i} style={{ visibility: frame / fps >= 1 + i * step ? "visible" : "hidden" }}>— {typed(f, 1 + i * step) || " "}</div>)}
        </div>
        <div style={{ position: "absolute", top: 40 * unit, right: 50 * unit, border: `${6 * unit}px solid ${accent}`, color: accent,
          fontSize: 54 * unit, fontWeight: 900, padding: `${4 * unit}px ${18 * unit}px`, transform: `rotate(12deg) scale(${interpolate(stamp, [0, 1], [2.2, 1])})`,
          opacity: stamp, fontFamily: fontFamily("Anton"), letterSpacing: 3 * unit }}>{str(p.stamp, "UNSOLVED")}</div>
      </div>
    </AbsoluteFill>
  );
};

/** Flecha o círculo rojo sobre el objeto de la miniatura . `x`/`y` en proporción del lienzo. La flecha
 * sale del lado del texto hacia el objeto. */
const ThumbMark: React.FC<{ kind: string; x: number; y: number; fromRight: boolean; color: string }> = ({ kind, x, y, fromRight, color }) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const cx = x * width, cy = y * height;
  const stroke = { stroke: color, strokeWidth: 22 * u, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const outline = { ...stroke, stroke: "#000", strokeWidth: 36 * u };
  if (kind === "circle") {
    const rx = 190 * u, ry = 150 * u;
    // Dos vueltas algo desplazadas: parece trazado a mano
    const d = `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx * 0.2} ${cy - ry * 0.98} A ${rx * 1.06} ${ry * 1.04} 0 0 1 ${cx + rx * 1.04} ${cy + ry * 0.12}`;
    return <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}><path d={d} {...outline} /><path d={d} {...stroke} /></svg>;
  }
  const dir = fromRight ? 1 : -1; // La cola de la flecha queda del lado del texto
  const len = 300 * u;
  const tx = cx + dir * len * 0.85, ty = cy + len * 0.55;
  const ang = Math.atan2(cy - ty, cx - tx);
  const head = 70 * u;
  const tip = { x: cx - Math.cos(ang) * 40 * u, y: cy - Math.sin(ang) * 40 * u };
  const h1 = { x: tip.x - Math.cos(ang - 0.5) * head, y: tip.y - Math.sin(ang - 0.5) * head };
  const h2 = { x: tip.x - Math.cos(ang + 0.5) * head, y: tip.y - Math.sin(ang + 0.5) * head };
  const midX = (tx + tip.x) / 2 + dir * 40 * u, midY = (ty + tip.y) / 2 + 30 * u;
  const d = `M ${tx} ${ty} Q ${midX} ${midY} ${tip.x} ${tip.y} M ${h1.x} ${h1.y} L ${tip.x} ${tip.y} L ${h2.x} ${h2.y}`;
  return <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}><path d={d} {...outline} /><path d={d} {...stroke} /></svg>;
};

/** Miniatura de YouTube: imagen a sangre, degradado y texto enorme con una palabra resaltada.
 * Con `mark` ("arrow" | "circle") y `mark_x`/`mark_y`, una marca roja sobre el objeto. */
const Thumbnail: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { unit, vertical } = useBase();
  const text = str(p.text).toUpperCase();
  const hl = str(p.highlight).toUpperCase();
  const right = str(p.side) === "right";
  const mark = str(p.mark);
  const shade = vertical ? "180deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.35) 30%, transparent 50%"
    : `${right ? 270 : 90}deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.35) 45%, transparent 70%`;
  return (
    <AbsoluteFill style={{ background: "#111" }}>
      {str(p.image) && <Img src={str(p.image)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      <AbsoluteFill style={{ background: `linear-gradient(${shade})` }} />
      {(mark === "arrow" || mark === "circle") && (
        <ThumbMark kind={mark} x={num(p.mark_x, right ? 0.3 : 0.72)} y={num(p.mark_y, 0.5)} fromRight={vertical ? num(p.mark_x, 0.5) < 0.5 : right}
          color={str(p.mark_color, "#ff2a2a")} />
      )}
      <div style={{ position: "absolute", [right ? "right" : "left"]: "5%", top: vertical ? "8%" : "50%", transform: vertical ? undefined : "translateY(-50%)",
        width: vertical ? "90%" : "55%", textAlign: right ? "right" : "left", fontFamily: fontFamily("Anton"), fontSize: (vertical ? 150 : 170) * unit,
        lineHeight: 0.95, color: "#fff", WebkitTextStroke: `${10 * unit}px #000`, paintOrder: "stroke fill",
        textShadow: `0 ${10 * unit}px ${24 * unit}px rgba(0,0,0,0.6)` }}>
        {text.split(" ").map((word, i) => (
          <span key={i} style={{ color: hl && word.replace(/[^A-Z0-9]/g, "") === hl.replace(/[^A-Z0-9]/g, "") ? accent : "#fff" }}>{word} </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const GraphicScene: React.FC<{ component: string; props: P; duration: number }> = ({ component, props, duration }) => {
  const accent = str(props.accent, "#f5c518");
  const template = templateScene(component, props, accent, duration);
  if (template) return template;
  switch (component) {
    case "title": return <Title p={props} accent={accent} />;
    case "big_number": return <BigNumber p={props} accent={accent} duration={duration} />;
    case "quote": return <Quote p={props} accent={accent} />;
    case "bullets": return <Bullets p={props} accent={accent} />;
    case "timeline": return <Timeline p={props} accent={accent} />;
    case "comparison": return <Comparison p={props} accent={accent} />;
    case "bar_chart": return <BarChart p={props} accent={accent} />;
    case "chapter": return <Chapter p={props} accent={accent} />;
    case "rank": return <Rank p={props} accent={accent} />;
    case "case_file": return <CaseFile p={props} accent={accent} duration={duration} />;
    case "thumbnail": return <Thumbnail p={props} accent={accent} />;
    default: return <Title p={{ title: str(props.title, component) }} accent={accent} />;
  }
};
