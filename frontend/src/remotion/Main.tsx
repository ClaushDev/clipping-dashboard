import React from "react";
import {
  AbsoluteFill,
  Audio,
  Freeze,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { BlockView } from "./block";
import { Captions, Hook, textStroke } from "./Captions";
import { CUTOUT_PREMOUNT, CutoutLayer, followOffset, MatteContext } from "./cutout";
import { CameraFx, cutTransitions, type CutTransition, FlashFx, ProgressView, ShapeView } from "./effects";
import { fontFamily } from "./fonts";
import { AdjustSubject, AdjustView, maskStyle } from "./grade";
import { GraphicScene } from "./graphics";
import { BareContext } from "./templates";
import {
  type AudioTrack,
  audioBus,
  busGain,
  type Composition,
  duckFactor,
  type Fx,
  containPlacement,
  type KenBurns,
  cropAt,
  cropRect,
  hasSplitAudio,
  keyedAt,
  type Mix,
  type Overlay,
  type Scene,
  type Segment,
  segmentLength,
  type TextOverlay,
  segmentOffsets,
  segmentAudioWindows,
  segmentSourceLocal,
  valueAt,
  isRemapped,
  movingLength,
  speechSpans,
  timelineWords,
  trackDuck,
  type VideoOverlay,
  videoBandBottom,
  type Angle,
} from "./schema";

/** Con cortes J/L el sonido de los tramos va aparte, en su propia ventana: los vídeos se dibujan mudos. */
const SplitAudioContext = React.createContext(false);

/** Mezcla: ganancia de cada grupo en el segundo t de la timeline (con el ducking automático). */
interface MixState { mix?: Mix; speech: [number, number][]; voice: boolean }
const MixContext = React.createContext<MixState>({ speech: [], voice: false });
/** Inicio en la timeline del tramo que se está dibujando (para el ducking del sonido original). */
const SegStartContext = React.createContext(0);

function mixGain(m: MixState, bus: "original" | "clips", t: number): number {
  const g = busGain(m.mix, bus);
  const d = m.mix?.duck;
  if (!g || !d) return g;
  // Los clips con sonido bajan bajo la voz; el original, solo si hay voz en off y está marcado.
  if (bus === "clips" || (d.original && m.voice)) return g * duckFactor(m.speech, t, d.level, d.attack, d.release);
  return g;
}

/** Pistas de vídeo extra (multicámara). */
const AnglesContext = React.createContext<Angle[]>([]);

/** Si el tramo enseña otra pista, se lee ese vídeo (con su sincronía y su encuadre fijo encima). El sonido va
 *  aparte, siempre de la principal (hasSplitAudio cuenta los tramos con pista). */
const SegmentView: React.FC<{ seg: Segment }> = ({ seg }) => {
  const angles = React.useContext(AnglesContext);
  const ang = seg.angle ? angles.find((a) => a.id === seg.angle) : undefined;
  const vseg = React.useMemo(() => (ang ? {
    ...seg, src: ang.src, src_w: ang.src_w, src_h: ang.src_h, src_in: seg.src_in + ang.offset, src_out: seg.src_out + ang.offset,
    voice: undefined, matte: undefined,
  } : seg), [seg, ang]);
  if (!ang) return <SegmentPlay seg={seg} />;
  const z = Math.max(1, ang.zoom || 1);
  return (
    <AbsoluteFill style={z > 1 ? { transform: `scale(${z})`, transformOrigin: `${ang.x * 100}% ${ang.y * 100}%` } : undefined}>
      <SegmentPlay seg={vseg} />
    </AbsoluteFill>
  );
};

/** Tramo con velocidad y congelado: la parte en movimiento y, si hay congelado, su último fotograma fijo. */
const SegmentPlay: React.FC<{ seg: Segment }> = ({ seg }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const plain = React.useMemo(() => ({ ...seg, speed: 1, speed_keys: undefined, reverse: false, freeze: 0, volume: 0, vol_keys: undefined }), [seg]);
  if (isRemapped(seg)) {
    // Rampa o marcha atrás. Cada fotograma enseña el instante del original que le toca (velocidad 1, congelado);
    // El sonido original se silencia.
    const last = Math.max(0, Math.floor((seg.src_out - seg.src_in) * fps) - 1);
    const at = Math.min(last, Math.round(segmentSourceLocal(seg, frame / fps) * fps));
    return (
      <Freeze frame={at}>
        <SegmentFrame seg={plain} />
      </Freeze>
    );
  }
  const moving = Math.max(1, Math.round(movingLength(seg) * fps));
  const voice = seg.voice ? <Sequence durationInFrames={moving} layout="none"><VoiceAudio seg={seg} /></Sequence> : null;
  if (!seg.freeze || frame < moving) return <><SegmentFrame seg={seg} />{voice}</>;
  return (
    <>
      <Freeze frame={moving - 1}>
        <SegmentFrame seg={seg} />
      </Freeze>
      {voice}
    </>
  );
};

/** Voz mejorada del tramo (sonido limpio del mismo archivo), en lugar del sonido del vídeo. */
const VoiceAudio: React.FC<{ seg: Segment }> = ({ seg }) => {
  const { fps } = useVideoConfig();
  const matte = React.useContext(MatteContext);
  const split = React.useContext(SplitAudioContext);
  const mixState = React.useContext(MixContext);
  const segStart = React.useContext(SegStartContext);
  if (!seg.voice || matte || split) return null;
  return (
    <Audio src={seg.voice.src} trimBefore={Math.round(seg.src_in * fps)} playbackRate={seg.speed || 1}
      volume={(f) => valueAt(seg.vol_keys, segmentSourceLocal(seg, f / fps), seg.volume) * mixGain(mixState, "original", segStart + f / fps)} />
  );
};

const SegmentFrame: React.FC<{ seg: Segment }> = ({ seg }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  // Los puntos clave van en segundos del original: con cámara lenta avanzan más despacio.
  const t = segmentSourceLocal(seg, frame / fps);
  const rate = seg.speed || 1;
  // Con el recorte, el mismo encuadre con el sujeto sobre fondo transparente y sin sonido.
  const matte = React.useContext(MatteContext);
  const split = React.useContext(SplitAudioContext);
  const mixState = React.useContext(MixContext);
  const segStart = React.useContext(SegStartContext);
  if (matte && !seg.matte) return null;
  const src = matte && seg.matte ? seg.matte.src : seg.src;
  const trim = Math.max(0, Math.round((seg.src_in - (matte && seg.matte ? seg.matte.src_in : 0)) * fps));
  const black = matte ? undefined : "black";
  const video = (style: React.CSSProperties) => (
    <OffthreadVideo src={src} trimBefore={trim} playbackRate={rate} volume={matte || split || seg.voice ? 0 : (f) => valueAt(seg.vol_keys, segmentSourceLocal(seg, f / fps), seg.volume) * mixGain(mixState, "original", segStart + f / fps)} transparent={matte} style={style} />
  );

  /** Recorte del original colocado en un rectángulo del lienzo (todo el lienzo o un panel). */
  const croppedVideo = (keys: Segment["keys"], boxW: number, boxH: number, muted: boolean) => {
    const r = cropRect(seg.src_w, seg.src_h, boxW, boxH, cropAt(keys, t));
    const scale = boxW / r.width;
    const style: React.CSSProperties = {
      position: "absolute", width: seg.src_w * scale, height: seg.src_h * scale,
      left: -r.left * scale, top: -r.top * scale, maxWidth: "none",
    };
    return muted
      ? <OffthreadVideo src={src} trimBefore={trim} playbackRate={rate} muted transparent={matte} style={style} />
      : video(style);
  };

  if (seg.layout === "crop") {
    return (
      <AbsoluteFill style={{ overflow: "hidden", backgroundColor: black }}>
        {croppedVideo(seg.keys, width, height, false)}
      </AbsoluteFill>
    );
  }

  if (seg.layout === "split" && seg.panels?.length) {
    // Un vídeo por panel; solo el primero lleva sonido para no duplicar el audio.
    return (
      <AbsoluteFill style={{ backgroundColor: black }}>
        {seg.panels.map((p, i) => {
          const boxH = Math.round(p.h * height);
          let content: React.ReactNode;
          if (p.fit === "contain") {
            // Se ve casi toda la escena; el hueco sobrante se rellena con una copia desenfocada.
            const pl = containPlacement(seg.src_w, seg.src_h, width, boxH, cropAt(p.keys, t));
            const style: React.CSSProperties = { position: "absolute", left: pl.left, top: pl.top, width: pl.width, height: pl.height, maxWidth: "none" };
            content = (
              <>
                {!matte && <OffthreadVideo src={src} trimBefore={trim} playbackRate={rate} muted
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: `blur(${Math.round(height / 50)}px) brightness(0.7)`, transform: "scale(1.15)" }} />}
                {i > 0 ? <OffthreadVideo src={src} trimBefore={trim} playbackRate={rate} muted transparent={matte} style={style} /> : video(style)}
              </>
            );
          } else {
            content = croppedVideo(p.keys, width, boxH, i > 0);
          }
          return (
            <div key={i} style={{
              position: "absolute", left: 0, width, top: Math.round(p.y * height), height: boxH,
              overflow: "hidden", borderTop: i > 0 ? `${Math.max(2, Math.round(height / 480))}px solid #000` : undefined,
            }}>
              {content}
            </div>
          );
        })}
      </AbsoluteFill>
    );
  }

  const bg = matte ? undefined : seg.layout === "fit_color" ? seg.bg_color || "#111111" : "black";
  return (
    <AbsoluteFill style={{ backgroundColor: bg, overflow: "hidden" }}>
      {seg.layout === "fit_blur" && !matte && (
        <OffthreadVideo
          src={src}
          trimBefore={trim}
          playbackRate={rate}
          muted
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: `blur(${Math.round(height / 40)}px) brightness(0.75)`,
            transform: "scale(1.15)",
          }}
        />
      )}
      {video({ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" })}
    </AbsoluteFill>
  );
};

// Sin rebote salvo que se pida («bounce» y «drop» lo piden a propósito): el spring no pasa de su valor final.
const spr = (t: number, fps: number, config: Parameters<typeof spring>[0]["config"], bounce = false) =>
  spring({ frame: t * fps, fps, config: { ...config, overshootClamping: !bounce } });

/** Entrada + movimiento continuo + giro fijo de una capa, como estilo CSS. */
function animStyle(o: Pick<Overlay, "anim" | "loop" | "rot">, t: number, dur: number, fps: number, width = 1080): React.CSSProperties {
  const fadeOut = interpolate(t, [dur - 0.2, dur], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const tf: string[] = [];
  let opacity = fadeOut;
  let filter: string | undefined;
  switch (o.anim) {
    case "fade":
      opacity = Math.min(interpolate(t, [0, 0.25], [0, 1], { extrapolateRight: "clamp" }), fadeOut);
      break;
    case "pop":
    case "count":
      tf.push(`scale(${spr(t, fps, { damping: 11, mass: 0.6 })})`);
      break;
    case "slide": {
      const s = spr(t, fps, { damping: 16 });
      tf.push(`translateY(${interpolate(s, [0, 1], [60, 0])}px)`);
      opacity = Math.min(s, fadeOut);
      break;
    }
    case "slide_left":
    case "slide_right": {
      const s = spr(t, fps, { damping: 15, stiffness: 140 });
      tf.push(`translateX(${interpolate(s, [0, 1], [o.anim === "slide_left" ? width * 0.6 : -width * 0.6, 0])}px)`);
      opacity = Math.min(interpolate(t, [0, 0.12], [0, 1], { extrapolateRight: "clamp" }), fadeOut);
      break;
    }
    case "bounce": {
      // Cae desde arriba y rebota dos veces.
      const s = spr(t, fps, { damping: 7, mass: 0.7, stiffness: 180 }, true);
      tf.push(`translateY(${interpolate(s, [0, 1], [-width * 0.35, 0])}px)`);
      tf.push(`scale(${interpolate(s, [0, 1], [0.7, 1])})`);
      opacity = Math.min(interpolate(t, [0, 0.08], [0, 1], { extrapolateRight: "clamp" }), fadeOut);
      break;
    }
    case "drop": {
      // Entra enorme y «aterriza» en su sitio, con un pequeño temblor.
      const s = spr(t, fps, { damping: 13, stiffness: 220 }, true);
      tf.push(`scale(${interpolate(s, [0, 1], [2.6, 1])})`);
      opacity = Math.min(interpolate(t, [0, 0.1], [0, 1], { extrapolateRight: "clamp" }), fadeOut);
      break;
    }
    case "zoom": {
      const s = spr(t, fps, { damping: 18, stiffness: 120 });
      tf.push(`scale(${interpolate(s, [0, 1], [0.2, 1])})`);
      filter = s < 0.98 ? `blur(${(1 - s) * 12}px)` : undefined;
      opacity = Math.min(s * 1.4, fadeOut);
      break;
    }
    case "spin": {
      const s = spr(t, fps, { damping: 12, mass: 0.7 });
      tf.push(`rotate(${interpolate(s, [0, 1], [-200, 0])}deg) scale(${s})`);
      break;
    }
  }
  if (o.rot) tf.push(`rotate(${o.rot}deg)`);
  switch (o.loop) {
    case "float":
      tf.push(`translateY(${Math.sin(t * 2.4) * width * 0.012}px) rotate(${Math.sin(t * 1.7) * 3}deg)`);
      break;
    case "pulse":
      tf.push(`scale(${1 + Math.sin(t * 6) * 0.05})`);
      break;
    case "wiggle":
      tf.push(`rotate(${Math.sin(t * 9) * 7}deg)`);
      break;
    case "spin":
      tf.push(`rotate(${t * 90}deg)`);
      break;
  }
  return { transform: tf.join(" ") || undefined, opacity, filter };
}

const NUM = /\d+(?:[.,]\d+)*/g;

/** Números del texto contando desde 0 hasta su valor (respeta separadores de miles y decimales). */
function countText(text: string, p: number): string {
  return text.replace(NUM, (m) => {
    const thousands = /^\d{1,3}([.,])\d{3}(\1\d{3})*$/.exec(m);
    const sep = thousands?.[1] ?? "";
    const dec = !thousands && /[.,]/.test(m) ? m.split(/[.,]/).pop()!.length : 0;
    const decSep = dec ? m[m.length - dec - 1] : ".";
    const value = Number(sep ? m.split(sep).join("") : m.replace(",", "."));
    if (!Number.isFinite(value)) return m;
    let out = (value * p).toFixed(dec);
    if (dec) out = out.replace(".", decSep);
    if (sep) {
      const [int, frac] = out.split(decSep);
      out = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep) + (frac !== undefined && dec ? decSep + frac : "");
    }
    return out;
  });
}

function shownText(o: TextOverlay, t: number, dur: number): string {
  if (o.anim === "count") {
    const len = Math.min(1.4, dur * 0.6);
    const p = interpolate(t, [0, len], [0, 1], { extrapolateRight: "clamp" });
    return countText(o.text, 1 - Math.pow(1 - p, 3));
  }
  if (o.anim === "type") {
    const len = Math.min(dur * 0.5, o.text.length * 0.045);
    return o.text.slice(0, Math.ceil(o.text.length * Math.min(1, len > 0 ? t / len : 1)));
  }
  return o.text;
}

/** Fotogramas clave: mueve, escala, gira y funde la capa entera alrededor de su centro. */
const Keyed: React.FC<{ o: Overlay; children: React.ReactNode }> = ({ o, children }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  if (!o.keys?.length) return <>{children}</>;
  const t = frame / fps;
  const k = keyedAt(o, t);
  const [fdx, fdy] = followOffset(o, t);
  return (
    <AbsoluteFill style={{
      transformOrigin: `${(o.x + fdx) * width}px ${(o.y + fdy) * height}px`, opacity: k.opacity,
      transform: `translate(${(k.x - o.x) * width}px, ${(k.y - o.y) * height}px) rotate(${k.rot}deg) scale(${k.scale})`,
    }}>
      {children}
    </AbsoluteFill>
  );
};

/** Clip de una pista de vídeo superior. */
const VideoLayer: React.FC<{ o: VideoOverlay; dx: number; dy: number; style: React.CSSProperties }> = ({ o, dx, dy, style }) => {
  const { fps, width, height } = useVideoConfig();
  const mixState = React.useContext(MixContext);
  const trim = Math.max(0, Math.round(o.src_in * fps));
  const video = (s: React.CSSProperties) => (
    <OffthreadVideo src={o.src} trimBefore={trim} volume={(f) => valueAt(o.vol_keys, f / fps, o.volume) * mixGain(mixState, "clips", o.start + f / fps)} muted={!o.volume && !o.vol_keys?.some((k) => k.v > 0)} style={s} />
  );
  if (o.fill) {
    return <AbsoluteFill style={{ opacity: o.opacity, ...style }}>{video({ width: "100%", height: "100%", objectFit: "cover" })}</AbsoluteFill>;
  }
  const w = o.w * width;
  const h = (w * (o.src_h || 9)) / (o.src_w || 16);
  const scale = height / 1920;
  return (
    <div style={{
      position: "absolute", left: (o.x + dx) * width - w / 2, top: (o.y + dy) * height - h / 2, width: w, height: h,
      opacity: o.opacity, overflow: "hidden", borderRadius: (o.radius ?? 0) * scale, boxSizing: "border-box",
      border: o.border ? `${Math.max(2, Math.round(8 * scale))}px solid ${o.border}` : undefined,
      boxShadow: o.border ? `0 ${12 * scale}px ${40 * scale}px rgba(0,0,0,0.45)` : undefined, ...style,
    }}>
      {video({ width: "100%", height: "100%", objectFit: "cover" })}
    </div>
  );
};

/** Máscara a mano de una capa, en el lienzo; va dentro de las claves, así se mueve con la capa. */
const Masked: React.FC<{ o: Overlay; children: React.ReactNode }> = ({ o, children }) => {
  const { width, height } = useVideoConfig();
  if (!o.mask || o.mask.shape === "subject") return <>{children}</>;
  return <AbsoluteFill style={maskStyle(o.mask, width, height)}>{children}</AbsoluteFill>;
};

const OverlayView: React.FC<{ o: Overlay }> = ({ o }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  if (o.kind === "cutout" || o.kind === "adjust") return null; // Los dibujan CutoutLayer y AdjustView
  if (o.kind === "shape") return <ShapeView o={o} />;
  if (o.kind === "progress") return <ProgressView o={o} style={animStyle(o, t, o.end - o.start, fps, width)} />;
  if (o.kind === "block") return <BlockView o={o} style={animStyle(o, t, o.end - o.start, fps, width)} />;
  const [fdx, fdy] = followOffset(o, t);
  if (o.kind === "video") return <VideoLayer o={o} dx={fdx} dy={fdy} style={animStyle(o, t, o.end - o.start, fps, width)} />;
  if (o.kind === "graphic") {
    // La plantilla se dibuja a tamaño de lienzo y se reduce a `w`; trae su propia entrada (sin opacidad por fuera:
    // Rompería el desenfoque del cristal líquido).
    const out = interpolate(t, [o.end - o.start - 0.25, o.end - o.start], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return (
      <AbsoluteFill style={{ transform: `translate(${(o.x + fdx - 0.5) * width}px, ${(o.y + fdy - 0.5) * height}px) scale(${o.w * (0.85 + 0.15 * out)})${o.rot ? ` rotate(${o.rot}deg)` : ""}`,
        clipPath: out < 1 ? `inset(${(1 - out) * 50}%)` : undefined }}>
        <BareContext.Provider value>
          <GraphicScene component={o.component} props={o.props} duration={o.end - o.start} />
        </BareContext.Provider>
      </AbsoluteFill>
    );
  }
  const scale = height / 1920;
  const align = o.kind === "text" ? o.align ?? "center" : "center";
  const box: React.CSSProperties = {
    position: "absolute",
    left: (o.x + fdx - o.w / 2) * width,
    top: (o.y + fdy) * height,
    width: o.w * width,
    translate: "0 -50%",
    display: "flex",
    justifyContent: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
    ...animStyle(o, t, o.end - o.start, fps, width),
  };
  if (o.kind === "image") {
    return (
      <div style={box}>
        <Img src={o.src} style={{ width: "100%", opacity: o.opacity }} />
      </div>
    );
  }
  return (
    <div style={box}>
      <div
        style={{
          fontFamily: fontFamily(o.font),
          fontWeight: o.weight,
          fontSize: o.size * scale,
          color: o.color,
          background: o.bg || undefined,
          padding: o.bg ? `${10 * scale}px ${20 * scale}px` : 0,
          borderRadius: 12 * scale,
          textAlign: align,
          lineHeight: 1.15,
          whiteSpace: "pre-wrap",
          opacity: o.opacity ?? 1,
          ...(o.bg ? {} : textStroke(o.stroke ?? 4, o.stroke_color || "#000000", scale)),
          ...(o.shadow ? { textShadow: `${o.shadow * scale}px ${o.shadow * scale}px ${o.shadow * 0.6 * scale}px ${o.stroke_color || "#000000"}` } : {}),
        }}
      >
        {shownText(o, t, o.end - o.start)}
      </div>
    </div>
  );
};

const AudioView: React.FC<{ a: AudioTrack; total: number; speech: [number, number][]; mix?: Mix }> = ({ a, total, speech, mix }) => {
  const { fps } = useVideoConfig();
  const dur = a.duration > 0 ? a.duration : total - a.start;
  const gain = busGain(mix, audioBus(a));
  const duck = trackDuck(a, mix);
  return (
    <Audio
      src={a.src}
      loop={a.loop}
      trimBefore={Math.round(a.src_in * fps)}
      volume={(f) => {
        const t = f / fps;
        const fin = a.fade_in > 0 ? Math.min(1, t / a.fade_in) : 1;
        const fout = a.fade_out > 0 ? Math.min(1, Math.max(0, (dur - t) / a.fade_out)) : 1;
        const k = duck ? duckFactor(speech, a.start + t, duck.level, duck.attack, duck.release) : 1;
        return valueAt(a.vol_keys, t, a.volume) * gain * fin * fout * k;
      }}
    />
  );
};

const SceneView: React.FC<{ scene: Scene }> = ({ scene: original }) => {
  let scene = original;
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;
  const opacity =
    scene.transition === "fade" ? interpolate(t, [0, 0.35], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const matte = React.useContext(MatteContext);
  if (matte) {
    // Escena con su recorte: la misma imagen o vídeo con el mismo movimiento, sin fondo.
    if (!scene.matte || scene.kind === "graphic") return null;
    scene = { ...scene, src: scene.matte.src, poster: undefined };
  }
  const black = matte ? undefined : "black";
  if (scene.kind === "graphic" && scene.graphic) {
    return (
      <AbsoluteFill style={{ opacity }}>
        <GraphicScene component={scene.graphic.component} props={scene.graphic.props} duration={scene.duration} />
      </AbsoluteFill>
    );
  }
  if (scene.kind === "video" && scene.src) {
    const clipLen = Math.min(scene.video_duration ?? scene.duration, scene.duration);
    const videoOpacity = scene.poster
      ? interpolate(t, [clipLen - 0.4, clipLen], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
      : 1;
    return (
      <AbsoluteFill style={{ opacity, backgroundColor: black }}>
        {scene.poster && <SceneView scene={{ ...scene, kind: "image", src: scene.poster, transition: "cut" }} />}
        <Sequence durationInFrames={Math.max(1, Math.round(clipLen * fps))} layout="none">
          <AbsoluteFill style={{ opacity: videoOpacity }}>
            <OffthreadVideo src={scene.src} muted transparent={matte} style={{ width: "100%", height: "100%", objectFit: "cover",
              ...(scene.motion ? (({ x, y, transform }) => ({ transform, transformOrigin: `${x * 100}% ${y * 100}%` }))(
                motionAt(scene.motion, t, clipLen, width)) : {}) }} />
          </AbsoluteFill>
        </Sequence>
      </AbsoluteFill>
    );
  }
  const cam = motionAt(scene.motion ?? { from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.5, y: 0.5, zoom: 1.12 } }, t, scene.duration, width);
  return (
    <AbsoluteFill style={{ opacity, overflow: "hidden", backgroundColor: black }}>
      {scene.src && (
        <Img
          src={scene.src}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: `${cam.x * 100}% ${cam.y * 100}%`,
            transform: cam.transform,
            transformOrigin: `${cam.x * 100}% ${cam.y * 100}%`,
          }}
        />
      )}
    </AbsoluteFill>
  );
};

/** Movimiento de cámara sobre una imagen o un vídeo: Ken Burns (zoom + paneo) con arranque suave y cámara en mano. */
function motionAt(m: KenBurns, t: number, duration: number, width: number) {
  let p = interpolate(t, [0, Math.max(0.1, duration)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (m.ease === "smooth") p = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  const zoom = m.from.zoom + (m.to.zoom - m.from.zoom) * p;
  const x = m.from.x + (m.to.x - m.from.x) * p;
  const y = m.from.y + (m.to.y - m.from.y) * p;
  let transform = `scale(${zoom})`;
  if (m.drift) {
    // Balanceo lento de cámara en mano: dos senos de periodo distinto y un leve giro; el zoom extra oculta los bordes.
    const a = width * 0.006 * m.drift;
    transform = `translate(${Math.sin(t * 0.9) * a + Math.sin(t * 2.3) * a * 0.3}px, ${Math.cos(t * 0.7) * a}px) `
      + `rotate(${Math.sin(t * 0.5) * 0.6 * m.drift}deg) scale(${zoom * (1 + 0.03 * m.drift)})`;
  }
  return { x, y, zoom, transform };
}

const PREMOUNT = 1.5; // Segundos

/** Un plano (tramo o escena) con sus transiciones de corte. Con «barrido» o «deslizar» en un corte, los dos planos se
 *  ven a la vez: el que sale se va hacia un lado y el que entra llega por el otro, así nunca asoma el fondo negro.
 *  Durante la transición, el que sale se queda en su último fotograma y el que entra en el primero (no se lee nada
 *  fuera de su tramo). `pre`/`post` son los fotogramas de transición antes y después del plano. */
const Shot: React.FC<{ pre: number; len: number; post: number; tin?: CutTransition; tout?: CutTransition; children: React.ReactNode }> = (
  { pre, len, post, tin, tout, children }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const inner = <Sequence from={pre} durationInFrames={len} layout="none">{children}</Sequence>;
  // Siempre dentro de Freeze (activo o no): cambiar el árbol volvería a montar el vídeo y daría un fotograma negro.
  const body = <Freeze frame={frame < pre ? pre : pre + len - 1} active={frame < pre || frame >= pre + len}>{inner}</Freeze>;
  let dx = 0;
  let dy = 0;
  let blur = 0;
  const push = (tr: CutTransition, p: number, out: boolean) => {
    const e = tr.kind === "whip" ? (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2) : (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
    const k = out ? e : e - 1; // El que sale va de 0 a 1 ancho hacia `dir`; el que entra llega de -1 a 0
    dx += tr.dir[0] * k * width;
    dy += tr.dir[1] * k * height;
    if (tr.kind === "whip") blur += Math.sin(p * Math.PI) * 28 * tr.amount * (height / 1920);
  };
  if (tin && pre > 0 && frame < 2 * pre) push(tin, frame / (2 * pre), false);
  if (tout && post > 0 && frame >= pre + len - post) push(tout, (frame - (pre + len - post)) / (2 * post), true);
  if (!dx && !dy && !blur) return <AbsoluteFill>{body}</AbsoluteFill>;
  return (
    <AbsoluteFill style={{ transform: `translate(${dx}px, ${dy}px)`, filter: blur > 0.2 ? `blur(${blur.toFixed(1)}px)` : undefined }}>
      {body}
    </AbsoluteFill>
  );
};

/** Planos seguidos con sus límites en fotogramas enteros: cada uno empieza justo donde acaba el anterior (redondear
 *  inicio y duración por separado dejaba a veces un fotograma sin nada, en negro). */
function shotFrames(starts: number[], ends: number[], fps: number, fx: Fx[]) {
  const f = (s: number) => Math.max(0, Math.round(s * fps));
  const from = starts.map(f);
  const to = ends.map((e, i) => Math.max(from[i] + 1, f(e)));
  const cuts = cutTransitions(fx, starts, ends);
  const half = starts.map((_, i) => {
    const tr = i > 0 ? cuts.at[i] : undefined;
    if (!tr) return 0;
    return Math.max(1, Math.min(Math.round((tr.len * fps) / 2), to[i - 1] - from[i - 1], to[i] - from[i]));
  });
  return {
    used: cuts.used,
    shots: starts.map((_, i) => ({
      from: from[i] - half[i], pre: half[i], len: to[i] - from[i], post: half[i + 1] ?? 0,
      tin: half[i] ? cuts.at[i] : undefined, tout: half[i + 1] ? cuts.at[i + 1] : undefined,
    })),
  };
}

/** Borde inferior del vídeo del tramo activo (para colocar los subtítulos debajo en los encuadres completos). */
function useCaptionTop(c: Composition): number | null {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const offsets = segmentOffsets(c.segments);
  const i = c.segments.findIndex((s, k) => t >= offsets[k] && t < offsets[k] + segmentLength(s));
  const seg = c.segments[i >= 0 ? i : 0];
  if (!seg) return null;
  if (seg.layout === "split" && seg.panels && seg.panels.length >= 2) {
    // Pantalla dividida: los subtítulos van centrados sobre la línea de corte entre los dos primeros paneles.
    const boundary = (seg.panels[0].y + seg.panels[0].h) * height;
    const lineH = c.captions.style.font_size * (height / 1920) * 1.18;
    return boundary - lineH / 2 - 30 * (height / 1920);
  }
  return videoBandBottom(seg.layout, seg.src_w, seg.src_h, width, height);
}

export const Main: React.FC<{ composition: Composition }> = ({ composition: c }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const total = durationInFrames / fps;
  const offsets = segmentOffsets(c.segments);
  const fx = c.fx ?? [];
  const segShots = shotFrames(offsets, c.segments.map((s, i) => offsets[i] + segmentLength(s)), fps, fx);
  const sceneShots = shotFrames(c.scenes.map((s) => s.start), c.scenes.map((s) => s.start + s.duration), fps, fx);
  const cameraFx = fx.filter((e) => !segShots.used.has(e.id) && !sceneShots.used.has(e.id));
  const words = React.useMemo(() => timelineWords(c), [c]);
  const speech = React.useMemo(() => (words.length || !c.speech ? speechSpans(words) : c.speech), [words, c.speech]);
  const captionTop = useCaptionTop(c);
  const f = (s: number) => Math.max(0, Math.round(s * fps));
  const mixState = React.useMemo<MixState>(() => ({
    mix: c.mix, speech, voice: c.audio.some((a) => audioBus(a) === "voice"),
  }), [c.mix, c.audio, speech]);
  const splitAudio = hasSplitAudio(c.segments);
  const audioWindows = splitAudio ? segmentAudioWindows(c.segments) : [];
  // Pistas de vídeo: encima del vídeo principal, las altas sobre las bajas; luego el resto de capas en su orden.
  const layers = [
    ...c.overlays.filter((o): o is VideoOverlay => o.kind === "video").sort((a, b) => a.track - b.track),
    ...c.overlays.filter((o) => o.kind !== "video"),
  ];

  /** Los planos con sus transiciones y efectos de cámara; con `matte`, solo los sujetos recortados. */
  const base = (matte: boolean) => (
    <MatteContext.Provider value={matte}>
     <SplitAudioContext.Provider value={splitAudio}>
      <CameraFx fx={cameraFx}>
        {/* PremountFor: cada escena y cada tramo se montan 1,5 s antes de aparecer para que el vídeo ya tenga el
            fotograma cargado en el corte (sin esto, la vista previa enseñaba negro unas décimas en cada cambio). */}
        {c.scenes.map((s, i) => {
          const sh = sceneShots.shots[i];
          return (
            <Sequence key={s.id} from={sh.from} durationInFrames={sh.pre + sh.len + sh.post} premountFor={f(PREMOUNT)}>
              <Shot {...sh}><SceneView scene={s} /></Shot>
            </Sequence>
          );
        })}
        {c.segments.map((s, i) => {
          const sh = segShots.shots[i];
          return (
            <Sequence key={s.id} from={sh.from} durationInFrames={sh.pre + sh.len + sh.post} premountFor={f(PREMOUNT)}>
              <SegStartContext.Provider value={offsets[i]}>
                <Shot {...sh}><SegmentView seg={s} /></Shot>
              </SegStartContext.Provider>
            </Sequence>
          );
        })}
      </CameraFx>
     </SplitAudioContext.Provider>
    </MatteContext.Provider>
  );

  return (
    <MixContext.Provider value={mixState}>
    <AnglesContext.Provider value={c.angles ?? []}>
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {base(false)}
      {/* Las capas van en orden: las que están antes de un efecto de recorte quedan detrás del sujeto. El recorte no
          va en un Sequence (los planos de dentro necesitan el tiempo de la timeline) y se monta un poco antes. */}
      {layers.map((o) => {
        const live = f(o.end) > frame && frame >= f(o.start - CUTOUT_PREMOUNT);
        if (o.kind === "cutout") return live ? <CutoutLayer key={o.id} o={o} base={base} /> : null;
        // Capa de ajuste: con la máscara del sujeto, como un recorte; si no, corrige lo que tiene debajo.
        if (o.kind === "adjust" && o.mask?.shape === "subject") return live ? <AdjustSubject key={o.id} o={o} base={base} /> : null;
        return (
          <Sequence key={o.id} from={f(o.start)} durationInFrames={Math.max(1, f(o.end - o.start))}
            premountFor={o.kind === "video" ? f(PREMOUNT) : undefined}>
            {o.kind === "adjust" ? <AdjustView o={o} /> : <Keyed o={o}><Masked o={o}><OverlayView o={o} /></Masked></Keyed>}
          </Sequence>
        );
      })}
      {c.captions.enabled && <Captions words={words} style={c.captions.style} topPx={captionTop} />}
      <Hook hook={c.hook} style={c.captions.style} />
      <FlashFx fx={c.fx ?? []} />
      {/* Cortes J/L: el sonido de cada tramo en su ventana, que no coincide con la imagen. */}
      {c.segments.map((s, i) => {
        if (!splitAudio || isRemapped(s)) return null;
        const [a, b] = audioWindows[i];
        const len = f(b) - f(a);
        if (len <= 0) return null;
        const rate = s.speed || 1;
        return (
          <Sequence key={`audio-${s.id}`} from={f(a)} durationInFrames={len} premountFor={f(PREMOUNT)}>
            <Audio src={s.voice?.src ?? s.src} trimBefore={Math.max(0, Math.round((s.src_in + (a - offsets[i]) * rate) * fps))} playbackRate={rate}
              volume={(fr) => valueAt(s.vol_keys, segmentSourceLocal(s, a - offsets[i] + fr / fps), s.volume) * mixGain(mixState, "original", a + fr / fps)} />
          </Sequence>
        );
      })}
      {c.audio.map((a) => (
        <Sequence key={a.id} from={f(a.start)} durationInFrames={Math.max(1, f(a.duration > 0 ? a.duration : total - a.start))}>
          <AudioView a={a} total={total} speech={speech} mix={c.mix} />
        </Sequence>
      ))}
    </AbsoluteFill>
    </AnglesContext.Provider>
    </MixContext.Provider>
  );
};
