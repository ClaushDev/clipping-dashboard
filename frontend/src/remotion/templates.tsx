/**
 * Plantillas del editor: gráficos virales que van como capa encima del vídeo (overlay `graphic`, sin fondo propio).
 * Todo es código: sin GPU ni archivos externos.
 */
import React from "react";
import { AbsoluteFill, Img, interpolate, random, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fontFamily } from "./fonts";

export const TEMPLATE_SPECS: Record<string, string> = {
  checklist: '{"title": str, "items": [str, ...] (2-6), "tally": bool (counter 3/5)}',
  headline_storm: '{"title": str (final verdict, 2-5 words), "headlines": [{"source": str, "text": str}, ...] (3-7)}',
  growth_curve: '{"title": str, "points": [number, ...] (3-12, in order), "prefix": str, "suffix": str, "start_label": str, "end_label": str}',
  chat: '{"name": str (contact), "messages": [{"from": "me"|"them", "text": str}, ...] (2-8, short)}',
  phone: '{"user": str (@handle), "text": str (post text), "likes": number, "image": str (optional)}',
  magazine: '{"masthead": str (1 word), "headline": str, "lines": [str, ...] (2-4 cover lines), "issue": str, "image": str (optional)}',
  liquid_glass: '{"icon": str (one emoji), "title": str, "text": str, "image": str (optional)}',
};

type P = Record<string, unknown>;
const str = (v: unknown, d = "") => (typeof v === "string" ? v : v === undefined || v === null ? d : String(v));
const num = (v: unknown, d = 0) => (typeof v === "number" && isFinite(v) ? v : Number(v) || d);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** En una capa (`bare`) la plantilla no pinta fondo: se ve el vídeo de debajo. */
export const BareContext = React.createContext(false);

function useBase() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  const vertical = height > width;
  const t = frame / fps;
  const enter = (delay = 0, config = { damping: 15, mass: 0.7 }) => spring({ frame: frame - delay * fps, fps, config });
  return { frame, fps, t, unit, vertical, width, height, enter, bare: React.useContext(BareContext) };
}

/** Fondo oscuro con un toque del color de acento (o nada si es una capa). */
const Backdrop: React.FC<{ accent: string; image?: string; children: React.ReactNode }> = ({ accent, image, children }) => {
  const { bare, t } = useBase();
  if (bare) return <AbsoluteFill>{children}</AbsoluteFill>;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at 30% 20%, ${accent}40, transparent 55%), linear-gradient(160deg, #16181d, #0a0b0e)` }}>
      {image && <Img src={image} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${1.05 + t * 0.012})` }} />}
      {children}
    </AbsoluteFill>
  );
};

/** Cuánto espacio de tiempo le toca a cada elemento para que todos salgan antes del final. */
const stepOf = (duration: number, n: number, lo: number, hi: number, tail = 1) =>
  Math.min(hi, Math.max(lo, (duration - tail) / Math.max(1, n)));

// ---------- Checklist Pop / Tally ----------

const Checklist: React.FC<{ p: P; accent: string; duration: number }> = ({ p, accent, duration }) => {
  const { t, unit, enter, fps, frame } = useBase();
  const items = arr<unknown>(p.items).map((x) => str(x)).filter(Boolean).slice(0, 6);
  const step = stepOf(duration, items.length, 0.45, 1.1, 0.9);
  const card = enter();
  const checked = items.filter((_, i) => t >= 0.5 + i * step + 0.25).length;
  const tallyPop = checked ? spring({ frame: frame - (0.5 + (checked - 1) * step + 0.25) * fps, fps, config: { damping: 9, mass: 0.4 } }) : 0;
  return (
    <Backdrop accent={accent}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ width: "84%", maxWidth: 1300 * unit, background: "#ffffff", color: "#16181d", borderRadius: 40 * unit,
          padding: `${56 * unit}px ${60 * unit}px`, boxShadow: `0 ${30 * unit}px ${90 * unit}px rgba(0,0,0,0.45)`, fontFamily: fontFamily("Montserrat"),
          transform: `translateY(${(1 - card) * 120 * unit}px) scale(${interpolate(card, [0, 1], [0.92, 1])})`, opacity: card }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 30 * unit, marginBottom: 34 * unit }}>
            <div style={{ fontSize: 62 * unit, fontWeight: 900, lineHeight: 1.05 }}>{str(p.title)}</div>
            {p.tally !== false && (
              <div style={{ fontFamily: fontFamily("Anton"), fontSize: 84 * unit, color: accent, flex: "none",
                transform: `scale(${checked ? 1 + 0.35 * Math.max(0, 1 - tallyPop) : 1})` }}>
                {checked}/{items.length}
              </div>
            )}
          </div>
          {items.map((it, i) => {
            const at = 0.5 + i * step;
            const row = enter(at);
            const tick = spring({ frame: frame - (at + 0.25) * fps, fps, config: { damping: 8, mass: 0.35, stiffness: 240 } });
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 30 * unit, fontSize: 48 * unit, fontWeight: 700,
                padding: `${16 * unit}px 0`, borderTop: i ? `2px solid #ececec` : undefined, opacity: row,
                transform: `translateX(${(1 - row) * -60 * unit}px)` }}>
                <div style={{ width: 70 * unit, height: 70 * unit, borderRadius: 18 * unit, flex: "none", position: "relative",
                  border: `${6 * unit}px solid ${tick > 0.05 ? accent : "#c9cbd1"}`, background: tick > 0.05 ? accent : "transparent" }}>
                  <svg viewBox="0 0 24 24" style={{ position: "absolute", inset: 0, transform: `scale(${tick})` }}>
                    <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="#fff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <span style={{ color: tick > 0.5 ? "#16181d" : "#5b5f69" }}>{it}</span>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---------- Headline Storm ----------

const HeadlineStorm: React.FC<{ p: P; accent: string; duration: number }> = ({ p, accent, duration }) => {
  const { t, unit, fps, frame, width, height, vertical } = useBase();
  const heads = arr<P>(p.headlines).map((h) => ({ source: str(h?.source), text: str(h?.text) })).filter((h) => h.text).slice(0, 7);
  const title = str(p.title);
  const step = stepOf(duration - (title ? 1.2 : 0), heads.length, 0.3, 0.75, 0.4);
  const verdictAt = 0.2 + heads.length * step + 0.15;
  // Temblor breve en cada golpe
  const lastHit = Math.floor((t - 0.2) / step);
  const since = t - 0.2 - lastHit * step;
  const shake = lastHit >= 0 && lastHit < heads.length && since < 0.18 ? (1 - since / 0.18) * 14 * unit : 0;
  const verdict = spring({ frame: frame - verdictAt * fps, fps, config: { damping: 11, mass: 0.6 } });
  return (
    <Backdrop accent={accent}>
      <AbsoluteFill style={{ transform: `translate(${(random(`hx${frame}`) - 0.5) * shake}px, ${(random(`hy${frame}`) - 0.5) * shake}px)` }}>
        {heads.map((h, i) => {
          const at = 0.2 + i * step;
          if (t < at) return null;
          const s = spring({ frame: frame - at * fps, fps, config: { damping: 14, mass: 0.5, stiffness: 220 } });
          const rx = random(`hsx${i}`) - 0.5;
          const ry = (i + 0.5) / heads.length;
          const cardW = (vertical ? 0.86 : 0.56) * width;
          const x = width / 2 + rx * (width - cardW) * 0.9;
          const y = height * (0.14 + ry * (title ? 0.6 : 0.72));
          const rot = (random(`hsr${i}`) - 0.5) * 9;
          return (
            <div key={i} style={{ position: "absolute", left: x - cardW / 2, top: y, width: cardW, translate: "0 -50%",
              transform: `rotate(${rot}deg) scale(${interpolate(s, [0, 1], [1.7, 1])})`, opacity: Math.min(1, s * 2),
              background: "#f6f3ec", color: "#141414", padding: `${22 * unit}px ${30 * unit}px`, borderRadius: 6 * unit,
              boxShadow: `0 ${18 * unit}px ${50 * unit}px rgba(0,0,0,0.55)`, fontFamily: fontFamily("Playfair Display") }}>
              <div style={{ fontFamily: fontFamily("Inter"), fontSize: 28 * unit, fontWeight: 900, letterSpacing: 3 * unit, color: accent,
                textTransform: "uppercase", marginBottom: 8 * unit }}>{h.source || "BREAKING"}</div>
              <div style={{ fontSize: (vertical ? 58 : 46) * unit, fontWeight: 900, lineHeight: 1.12 }}>{h.text}</div>
            </div>
          );
        })}
        {title && t >= verdictAt && (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: height * 0.1, display: "flex", justifyContent: "center" }}>
            <div style={{ background: accent, color: "#111", fontFamily: fontFamily("Anton"), fontSize: 110 * unit, lineHeight: 1,
              padding: `${18 * unit}px ${40 * unit}px`, textTransform: "uppercase", maxWidth: "90%", textAlign: "center",
              transform: `rotate(-3deg) scale(${interpolate(verdict, [0, 1], [2.2, 1])})`, opacity: Math.min(1, verdict * 2),
              boxShadow: `0 ${16 * unit}px ${40 * unit}px rgba(0,0,0,0.5)` }}>{title}</div>
          </div>
        )}
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---------- Growth Curve ----------

const GrowthCurve: React.FC<{ p: P; accent: string; duration: number }> = ({ p, accent, duration }) => {
  const { t, unit, enter, width, height, vertical } = useBase();
  let pts = arr<unknown>(p.points).map((v) => num(v, NaN)).filter((v) => isFinite(v)).slice(0, 12);
  if (pts.length < 2) pts = [1, 2, 4, 9, 20];
  const W = width * (vertical ? 0.84 : 0.72);
  const H = height * (vertical ? 0.36 : 0.5);
  const min = Math.min(0, ...pts);
  const max = Math.max(...pts) || 1;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * W, H - ((v - min) / (max - min || 1)) * H] as const);
  const prog = interpolate(t, [0.4, Math.max(1.2, Math.min(duration - 0.8, 3.2))], [0, 1], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 2.2) });
  const pos = prog * (pts.length - 1);
  const k = Math.min(pts.length - 2, Math.floor(pos));
  const f = pos - k;
  const tip = [xy[k][0] + (xy[k + 1][0] - xy[k][0]) * f, xy[k][1] + (xy[k + 1][1] - xy[k][1]) * f];
  const value = pts[k] + (pts[k + 1] - pts[k]) * f;
  const line = [...xy.slice(0, k + 1), tip].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L");
  const area = `M0,${H} L${line} L${tip[0].toFixed(1)},${H} Z`;
  const decimals = pts.some((v) => !Number.isInteger(v)) ? 1 : 0;
  const shown = value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const head = enter();
  const sw = 10 * unit;
  return (
    <Backdrop accent={accent}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: fontFamily("Montserrat"), color: "#fff" }}>
        <div style={{ width: W }}>
          <div style={{ fontSize: 64 * unit, fontWeight: 900, marginBottom: 110 * unit, opacity: head, lineHeight: 1.05,
            textShadow: "0 4px 18px rgba(0,0,0,0.5)" }}>{str(p.title)}</div>
          <div style={{ position: "relative", width: W, height: H }}>
            <svg width={W} height={H} style={{ overflow: "visible", position: "absolute", inset: 0 }}>
              <defs>
                <linearGradient id="gc-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={accent} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              {[0.25, 0.5, 0.75, 1].map((g) => <line key={g} x1={0} x2={W} y1={H * (1 - g)} y2={H * (1 - g)} stroke="#ffffff22" strokeWidth={2 * unit} />)}
              <line x1={0} x2={W} y1={H} y2={H} stroke="#ffffff66" strokeWidth={3 * unit} />
              <path d={area} fill="url(#gc-fill)" />
              <path d={`M${line}`} fill="none" stroke={accent} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
                style={{ filter: `drop-shadow(0 0 ${14 * unit}px ${accent})` }} />
              <circle cx={tip[0]} cy={tip[1]} r={22 * unit + Math.sin(t * 8) * 4 * unit} fill={accent} opacity={0.35} />
              <circle cx={tip[0]} cy={tip[1]} r={13 * unit} fill="#fff" />
            </svg>
            <div style={{ position: "absolute", left: tip[0] + (tip[1] < H * 0.3 ? -36 * unit : 0), top: tip[1] - (tip[1] < H * 0.3 ? 0 : 40 * unit),
              translate: tip[1] < H * 0.3 ? "-100% -20%" : tip[0] > W * 0.7 ? "-100% -100%" : "-50% -100%",
              background: "#fff", color: "#111", fontWeight: 900, fontSize: 52 * unit, padding: `${8 * unit}px ${20 * unit}px`,
              borderRadius: 16 * unit, whiteSpace: "nowrap", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
              {str(p.prefix)}{shown}{str(p.suffix)}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 34 * unit, color: "#d6d8de", marginTop: 20 * unit, fontWeight: 700 }}>
            <span>{str(p.start_label)}</span><span style={{ opacity: prog > 0.95 ? 1 : 0.4 }}>{str(p.end_label)}</span>
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---------- Chat Takeover ----------

const ChatTakeover: React.FC<{ p: P; accent: string; duration: number }> = ({ p, accent, duration }) => {
  const { t, unit, fps, frame, enter, bare } = useBase();
  const msgs = arr<P>(p.messages).map((m) => ({ me: str(m?.from) === "me", text: str(m?.text) })).filter((m) => m.text).slice(0, 8);
  const step = stepOf(duration, msgs.length, 0.7, 1.6, 0.6);
  const at = (i: number) => 0.45 + i * step;
  const name = str(p.name, "Unknown");
  const typing = msgs.findIndex((m, i) => !m.me && t >= at(i) - 0.6 && t < at(i));
  const open = enter(0, { damping: 18, mass: 0.8 });
  const bubble = (me: boolean): React.CSSProperties => ({
    alignSelf: me ? "flex-end" : "flex-start", maxWidth: "80%", fontSize: 54 * unit, lineHeight: 1.28,
    padding: `${20 * unit}px ${30 * unit}px`, borderRadius: 40 * unit, color: me ? "#fff" : "#111",
    background: me ? accent : "#e9e9eb", [me ? "borderBottomRightRadius" : "borderBottomLeftRadius"]: 10 * unit,
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: bare ? undefined : "#0b0c0f" }}>
      <div style={{ width: bare ? "86%" : "100%", height: bare ? "70%" : "100%", background: "#fff", borderRadius: bare ? 48 * unit : 0,
        overflow: "hidden", display: "flex", flexDirection: "column", fontFamily: fontFamily("Inter"),
        transform: `translateY(${(1 - open) * 100}%)`, boxShadow: bare ? "0 30px 90px rgba(0,0,0,0.5)" : undefined }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 * unit, padding: `${(bare ? 30 : 90) * unit}px ${40 * unit}px ${26 * unit}px`,
          borderBottom: "2px solid #ececec", background: "#f7f7f8" }}>
          <div style={{ width: 92 * unit, height: 92 * unit, borderRadius: "50%", background: `linear-gradient(135deg, ${accent}, #222)`, color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 44 * unit, fontWeight: 900, flex: "none" }}>
            {name.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <div style={{ fontSize: 50 * unit, fontWeight: 900, color: "#111" }}>{name}</div>
            <div style={{ fontSize: 32 * unit, color: typing >= 0 ? accent : "#8a8d96" }}>{typing >= 0 ? "typing…" : "online"}</div>
          </div>
        </div>
        {/* De abajo arriba: los mensajes viejos se van por arriba solos */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 18 * unit, padding: `${30 * unit}px ${36 * unit}px`, overflow: "hidden" }}>
          {msgs.map((m, i) => {
            if (t < at(i)) return null;
            const s = spring({ frame: frame - at(i) * fps, fps, config: { damping: 13, mass: 0.45, stiffness: 230 } });
            return (
              <div key={i} style={{ ...bubble(m.me), transform: `scale(${interpolate(s, [0, 1], [0.5, 1])})`, transformOrigin: m.me ? "100% 100%" : "0% 100%", opacity: s }}>
                {m.text}
              </div>
            );
          })}
          {typing >= 0 && (
            <div style={{ ...bubble(false), display: "flex", gap: 12 * unit, padding: `${26 * unit}px ${32 * unit}px` }}>
              {[0, 1, 2].map((d) => (
                <span key={d} style={{ width: 18 * unit, height: 18 * unit, borderRadius: "50%", background: "#8a8d96",
                  transform: `translateY(${Math.sin(t * 12 - d * 1.1) * 6 * unit}px)` }} />
              ))}
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------- Phone Mockup ----------

const PhoneMockup: React.FC<{ p: P; accent: string; duration: number }> = ({ p, accent, duration }) => {
  const { t, unit, fps, frame, enter, height } = useBase();
  const rise = enter(0, { damping: 16, mass: 0.9 });
  const ph = height * 0.72;
  const pw = ph * 0.49;
  const image = str(p.image);
  const likes = Math.round(num(p.likes, 12400) * interpolate(t, [0.8, Math.min(duration - 0.3, 2.6)], [0, 1], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 3) }));
  const heart = spring({ frame: frame - 0.8 * fps, fps, config: { damping: 7, mass: 0.4 } });
  const tilt = interpolate(rise, [0, 1], [24, 6]);
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString("en-US"));
  return (
    <Backdrop accent={accent}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", perspective: 2400 * unit }}>
        <div style={{ width: pw, height: ph, borderRadius: pw * 0.15, background: "#0d0d0f", padding: pw * 0.035,
          boxShadow: `0 ${40 * unit}px ${120 * unit}px rgba(0,0,0,0.6), inset 0 0 0 ${4 * unit}px #3a3b40`,
          transform: `translateY(${(1 - rise) * height * 0.8}px) rotateY(${-tilt}deg) rotateX(${tilt * 0.4}deg) rotateZ(${Math.sin(t * 1.2) * 1.2}deg)` }}>
          <div style={{ width: "100%", height: "100%", borderRadius: pw * 0.12, overflow: "hidden", position: "relative",
            background: image ? "#000" : `linear-gradient(160deg, ${accent}, #1b1c22 70%)`, fontFamily: fontFamily("Inter"), color: "#fff" }}>
            {image && <Img src={image} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${1.04 + t * 0.015})` }} />}
            <div style={{ position: "absolute", top: pw * 0.03, left: "50%", translate: "-50% 0", width: pw * 0.3, height: pw * 0.085,
              borderRadius: 99, background: "#000" }} />
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.75))" }} />
            <div style={{ position: "absolute", left: pw * 0.07, right: pw * 0.22, bottom: pw * 0.1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: pw * 0.03, fontSize: pw * 0.055, fontWeight: 900 }}>
                <span style={{ width: pw * 0.1, height: pw * 0.1, borderRadius: "50%", background: accent, border: "3px solid #fff" }} />
                {str(p.user, "@channel")}
              </div>
              <div style={{ fontSize: pw * 0.05, lineHeight: 1.3, marginTop: pw * 0.03 }}>{str(p.text)}</div>
            </div>
            <div style={{ position: "absolute", right: pw * 0.05, bottom: pw * 0.16, textAlign: "center", fontSize: pw * 0.045, fontWeight: 900 }}>
              <div style={{ fontSize: pw * 0.12, transform: `scale(${0.6 + 0.4 * heart + Math.max(0, Math.sin((t - 0.8) * 9)) * 0.08 * (t < 1.6 ? 1 : 0)})`,
                color: heart > 0.3 ? "#ff2d55" : "#fff" }}>♥</div>
              {fmt(likes)}
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---------- Magazine Cover ----------

const MagazineCover: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { t, unit, enter, width, height, bare } = useBase();
  const image = str(p.image);
  const lines = arr<unknown>(p.lines).map((x) => str(x)).filter(Boolean).slice(0, 4);
  const masthead = str(p.masthead, "TIME").toUpperCase();
  const card = enter(0, { damping: 17, mass: 0.9 });
  const cw = Math.min(width * 0.86, height * 0.72 * 0.77);
  const ch = cw / 0.77;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", perspective: 2600 * unit,
      background: bare ? undefined : "radial-gradient(circle at 50% 40%, #2a2c33, #0b0c0f)" }}>
      <div style={{ width: cw, height: ch, position: "relative", overflow: "hidden", background: `linear-gradient(170deg, ${accent}, #1a1b20)`,
        boxShadow: `0 ${40 * unit}px ${110 * unit}px rgba(0,0,0,0.65)`, color: "#fff",
        transform: `rotateY(${interpolate(card, [0, 1], [-35, -4])}deg) rotateZ(${interpolate(card, [0, 1], [6, 1])}deg) scale(${interpolate(card, [0, 1], [0.8, 1])})`,
        opacity: Math.min(1, card * 1.6) }}>
        {image && <Img src={image} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: `scale(${1.08 - t * 0.01})` }} />}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.35), transparent 30%, transparent 55%, rgba(0,0,0,0.8))" }} />
        <div style={{ position: "absolute", top: cw * 0.02, left: 0, right: 0, textAlign: "center", fontFamily: fontFamily("Playfair Display"),
          fontWeight: 900, fontSize: Math.min(cw * 0.3, (cw * 1.5) / Math.max(3, masthead.length)), lineHeight: 1, letterSpacing: -cw * 0.004,
          color: accent === "#ffffff" ? "#e11" : "#fff", textShadow: "0 6px 24px rgba(0,0,0,0.4)",
          transform: `translateY(${(1 - enter(0.25)) * -cw * 0.2}px)`, opacity: enter(0.25) }}>{masthead}</div>
        <div style={{ position: "absolute", top: cw * 0.37, left: cw * 0.06, width: cw * 0.45, fontFamily: fontFamily("Oswald"), fontWeight: 700 }}>
          {lines.map((l, i) => {
            const s = enter(0.7 + i * 0.25);
            return (
              <div key={i} style={{ fontSize: cw * 0.045, lineHeight: 1.15, marginBottom: cw * 0.035, textTransform: "uppercase",
                opacity: s, transform: `translateX(${(1 - s) * -cw * 0.1}px)`, textShadow: "0 3px 12px rgba(0,0,0,0.7)" }}>
                <span style={{ display: "block", width: cw * 0.06, height: cw * 0.008, background: accent, marginBottom: cw * 0.012 }} />{l}
              </div>
            );
          })}
        </div>
        <div style={{ position: "absolute", left: cw * 0.06, right: cw * 0.06, bottom: cw * 0.1, fontFamily: fontFamily("Anton"), fontSize: cw * 0.11,
          lineHeight: 0.98, textTransform: "uppercase", opacity: enter(1.2), transform: `scale(${interpolate(enter(1.2), [0, 1], [1.3, 1])})`,
          transformOrigin: "0% 100%", textShadow: "0 6px 24px rgba(0,0,0,0.6)" }}>{str(p.headline)}</div>
        <div style={{ position: "absolute", left: cw * 0.06, bottom: cw * 0.035, fontFamily: fontFamily("Inter"), fontSize: cw * 0.028, fontWeight: 700,
          letterSpacing: cw * 0.004, opacity: 0.85 }}>{str(p.issue).toUpperCase()}</div>
        <div style={{ position: "absolute", right: cw * 0.05, bottom: cw * 0.03, width: cw * 0.16, height: cw * 0.07, background: "#fff", padding: cw * 0.006,
          display: "flex", gap: cw * 0.003 }}>
          {Array.from({ length: 22 }, (_, i) => <span key={i} style={{ flex: random(`bc${i}`) > 0.5 ? 2 : 1, background: i % 2 ? "#fff" : "#000" }} />)}
        </div>
        {/* Brillo de papel que cruza la portada al llegar */}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.28) 50%, transparent 60%)",
          transform: `translateX(${interpolate(t, [0.3, 1.3], [-110, 110], clamp)}%)` }} />
      </div>
    </AbsoluteFill>
  );
};

// ---------- Liquid Glass ----------

const LiquidGlass: React.FC<{ p: P; accent: string }> = ({ p, accent }) => {
  const { t, unit, enter, bare, width, height, vertical } = useBase();
  const image = str(p.image);
  const s = enter(0.1, { damping: 16, mass: 0.8 });
  const blob = (i: number, color: string) => {
    const a = t * (0.35 + i * 0.12) + i * 2.1;
    return <div key={i} style={{ position: "absolute", width: width * 0.7, height: width * 0.7, borderRadius: "50%", background: color, filter: `blur(${60 * unit}px)`,
      left: width * (0.15 + 0.3 * Math.cos(a)) - width * 0.35 + width * 0.35 * (i % 2), top: height * (0.3 + 0.2 * Math.sin(a * 1.3)) - width * 0.35, opacity: 0.85 }} />;
  };
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", overflow: "hidden", background: bare ? undefined : "#0d0f17" }}>
      {!bare && (image
        ? <Img src={image} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: `scale(${1.06 + t * 0.012})` }} />
        : <>{blob(0, accent)}{blob(1, "#7c5cff")}{blob(2, "#00d2ff")}</>)}
      <div style={{ position: "relative", width: vertical ? "80%" : "52%", padding: `${64 * unit}px ${60 * unit}px`, borderRadius: 64 * unit, overflow: "hidden",
        background: "linear-gradient(135deg, rgba(255,255,255,0.28), rgba(255,255,255,0.08))", backdropFilter: "blur(28px) saturate(180%)",
        WebkitBackdropFilter: "blur(28px) saturate(180%)", border: `${2 * unit}px solid rgba(255,255,255,0.45)`,
        boxShadow: `0 ${30 * unit}px ${80 * unit}px rgba(0,0,0,0.35), inset 0 ${2 * unit}px ${2 * unit}px rgba(255,255,255,0.6), inset 0 -${10 * unit}px ${30 * unit}px rgba(255,255,255,0.12)`,
        color: "#fff", fontFamily: fontFamily("Outfit"), textAlign: "center",
        transform: `scale(${interpolate(s, [0, 1], [0.85, 1])}) translateY(${(1 - s) * 60 * unit}px)` }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.35) 48%, transparent 60%)",
          transform: `translateX(${interpolate((t - 0.4) % 4, [0, 1.2], [-120, 120], clamp)}%)` }} />
        {str(p.icon) && <div style={{ fontSize: 120 * unit, lineHeight: 1, marginBottom: 20 * unit, transform: `scale(${enter(0.35)})` }}>{str(p.icon)}</div>}
        <div style={{ fontSize: 70 * unit, fontWeight: 900, lineHeight: 1.05, textShadow: "0 2px 14px rgba(0,0,0,0.25)", opacity: enter(0.3) }}>{str(p.title)}</div>
        {str(p.text) && <div style={{ fontSize: 40 * unit, lineHeight: 1.35, marginTop: 22 * unit, opacity: enter(0.5) * 0.92 }}>{str(p.text)}</div>}
      </div>
    </AbsoluteFill>
  );
};

/** La plantilla `component`, o null si no es una de estas. */
export function templateScene(component: string, p: P, accent: string, duration: number): React.ReactElement | null {
  switch (component) {
    case "checklist": return <Checklist p={p} accent={accent} duration={duration} />;
    case "headline_storm": return <HeadlineStorm p={p} accent={accent} duration={duration} />;
    case "growth_curve": return <GrowthCurve p={p} accent={accent} duration={duration} />;
    case "chat": return <ChatTakeover p={p} accent={accent} duration={duration} />;
    case "phone": return <PhoneMockup p={p} accent={accent} duration={duration} />;
    case "magazine": return <MagazineCover p={p} accent={accent} />;
    case "liquid_glass": return <LiquidGlass p={p} accent={accent} />;
    default: return null;
  }
}
