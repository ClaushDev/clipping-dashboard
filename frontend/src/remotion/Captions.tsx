import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fontFamily } from "./fonts";
import type { CaptionPunctuation, CaptionStyle, CaptionWord, Hook as HookT, WordAnimation, WordOut } from "./schema";

const BASE_H = 1920; // Los tamaños de las plantillas están pensados para un lienzo de 1080x1920
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const ANIMATIONS: { value: WordAnimation; label: string; group: "Gancho" | "Serio / minimalista" }[] = [
  { value: "pop", label: "Pop", group: "Gancho" },
  { value: "bounce", label: "Rebote", group: "Gancho" },
  { value: "glow", label: "Brillo", group: "Gancho" },
  { value: "chunk_fade", label: "Bloque suave (fundido)", group: "Serio / minimalista" },
  { value: "fade_in", label: "Aparición palabra a palabra", group: "Serio / minimalista" },
  { value: "reveal_up", label: "Aparecer subiendo", group: "Serio / minimalista" },
  { value: "dim", label: "Karaoke tenue", group: "Serio / minimalista" },
  { value: "blur_in", label: "Desenfoque a nítido", group: "Serio / minimalista" },
  { value: "typewriter", label: "Máquina de escribir", group: "Serio / minimalista" },
  { value: "sweep", label: "Subrayado que avanza", group: "Serio / minimalista" },
  { value: "none", label: "Sin animación", group: "Serio / minimalista" },
];

export const WORD_OUTS: { value: WordOut; label: string }[] = [
  { value: "none", label: "Sin salida" },
  { value: "fade", label: "Fundido" },
  { value: "shrink", label: "Encoger" },
  { value: "blur", label: "Desenfoque" },
  { value: "up", label: "Subir" },
];

export const PUNCTUATION_MODES: { value: CaptionPunctuation; label: string }[] = [
  { value: "all", label: "Todos los signos" },
  { value: "expressive", label: "Solo ¿? y ¡!" },
  { value: "none", label: "Sin signos" },
];

/** Texto que se pinta según el ajuste de signos. Solo quita signos de los bordes: «3,5» o «1.000» se quedan. */
export function shownWord(w: string, mode: CaptionPunctuation | undefined): string {
  if (!mode || mode === "all") return w;
  const re = mode === "expressive" ? /^[.,;:…]+|[.,;:…]+$/g : /^[.,;:…¿?¡!"«»“”]+|[.,;:…¿?¡!"«»“”]+$/g;
  return w.replace(re, "");
}

/** Animaciones en las que las palabras aún no dichas no se ven (ocupan su sitio para que el texto no salte). */
const HIDES_FUTURE = new Set<WordAnimation>(["fade_in", "reveal_up", "blur_in", "typewriter"]);

/** Agrupa palabras en bloques cortos; corta también en finales de frase y en pausas largas. */
export function chunkWords(words: CaptionWord[], perChunk: number): CaptionWord[][] {
  const chunks: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  for (const w of words) {
    if (current.length && (current.length >= perChunk || w.s - current[current.length - 1].e > 0.6)) {
      chunks.push(current);
      current = [];
    }
    current.push(w);
    if (/[.?!,;:]$/.test(w.w)) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Bloque visible en el instante t (se mantiene hasta que empieza el siguiente si la pausa es corta). */
function activeChunk(chunks: CaptionWord[][], t: number): { chunk: CaptionWord[]; end: number } | null {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const start = c[0].s;
    const next = chunks[i + 1]?.[0].s;
    const lastEnd = c[c.length - 1].e;
    const end = next !== undefined && next - lastEnd < 0.5 ? next : lastEnd + 0.2;
    if (t >= start && t < end) return { chunk: c, end };
  }
  return null;
}

export function textStroke(width: number, color: string, scale: number): React.CSSProperties {
  if (!width) return {};
  return { WebkitTextStroke: `${width * 2 * scale}px ${color}`, paintOrder: "stroke fill" };
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
}

type WordState = "past" | "active" | "future";

const Word: React.FC<{
  word: CaptionWord;
  state: WordState;
  style: CaptionStyle;
  scale: number;
  sinceStart: number;
  /** Segundos hasta que el bloque deja la pantalla (para la salida de la palabra). */
  untilEnd: number;
}> = ({ word, state, style, scale, sinceStart, untilEnd }) => {
  const { fps } = useVideoConfig();
  const st = word.st;
  const shown = shownWord(word.w, style.punctuation);
  const text = style.uppercase ? shown.toUpperCase() : shown;
  const anim = st?.anim ?? style.animation;
  const active = state === "active";
  const css: React.CSSProperties = { display: "inline-block" };
  // Estilo propio de la palabra
  if (st?.weight) css.fontWeight = st.weight;
  if (st?.font) css.fontFamily = fontFamily(st.font);
  if (st?.scale && st.scale !== 1) css.fontSize = `${st.scale}em`;
  if (st?.italic) css.fontStyle = "italic";
  const dur = Math.max(0.08, word.e - word.s);

  if (state === "future" && HIDES_FUTURE.has(anim)) css.opacity = 0;
  if (state === "future" && anim === "dim") css.opacity = 0.35;

  if (active) {
    const s = spring({ frame: Math.max(0, sinceStart * fps), fps, config: { damping: anim === "bounce" ? 8 : 14, mass: 0.5, overshootClamping: anim !== "bounce" } });
    if (anim === "pop" || anim === "bounce") {
      css.transform = `scale(${interpolate(s, [0, 1], [1, 1 + (anim === "bounce" ? 0.1 : 0.06)])})`;
    } else if (anim === "fade_in") {
      css.opacity = interpolate(sinceStart, [0, 0.15], [0, 1], clamp);
    } else if (anim === "reveal_up") {
      css.opacity = interpolate(sinceStart, [0, 0.12], [0, 1], clamp);
      css.transform = `translateY(${interpolate(s, [0, 1], [0.35, 0])}em)`;
    } else if (anim === "blur_in") {
      css.opacity = interpolate(sinceStart, [0, 0.1], [0.2, 1], clamp);
      css.filter = `blur(${interpolate(sinceStart, [0, 0.22], [10 * scale, 0], clamp)}px)`;
    } else if (anim === "glow") {
      css.textShadow = `0 0 ${0.35 * style.font_size * scale}px ${style.highlight_color}`;
    }
  }

  // Resaltado de la palabra activa (o de las destacadas a mano). La activa usa siempre el primer color; las
  // Destacadas con hl2, el segundo.
  const activeHl = active && style.active_highlight !== false;
  const highlighted = activeHl || word.hl || word.hl2;
  const hlColor = !activeHl && word.hl2 && !word.hl ? style.highlight_color2 || style.highlight_color : style.highlight_color;
  if (highlighted && anim !== "sweep") {
    if (style.highlight_mode === "box") {
      css.background = style.box_color;
      css.color = hlColor;
      css.borderRadius = 0.18 * style.font_size * scale;
      css.padding = `0 ${0.18 * style.font_size * scale}px`;
    } else if (style.highlight_mode === "underline") {
      css.textDecoration = "underline";
      css.textDecorationColor = hlColor;
      css.textDecorationThickness = 0.09 * style.font_size * scale;
      css.textUnderlineOffset = 0.12 * style.font_size * scale;
    } else {
      css.color = hlColor;
    }
  }
  if (st?.color) css.color = st.color; // El color elegido para la palabra manda
  if (st?.out && st.out !== "none" && state !== "future") {
    const k = interpolate(untilEnd, [0, 0.18], [1, 0], clamp); // 0 → 1 en los últimos 0,18 s del bloque
    if (k > 0) {
      const tf = css.transform ? [css.transform] : [];
      if (st.out === "fade") css.opacity = 1 - k;
      if (st.out === "shrink") { tf.push(`scale(${1 - 0.6 * k})`); css.opacity = 1 - k; }
      if (st.out === "blur") { css.filter = `blur(${12 * k * scale}px)`; css.opacity = 1 - k; }
      if (st.out === "up") { tf.push(`translateY(${-0.4 * k}em)`); css.opacity = 1 - k; }
      if (tf.length) css.transform = tf.join(" ");
    }
  }
  if (anim === "sweep" && (active || state === "past" || word.hl || word.hl2)) {
    // Barra bajo la palabra que crece de izquierda a derecha mientras se pronuncia.
    const p = active ? interpolate(sinceStart, [0, dur], [0, 1], clamp) : 1;
    css.backgroundImage = `linear-gradient(${style.highlight_color}, ${style.highlight_color})`;
    css.backgroundRepeat = "no-repeat";
    css.backgroundSize = `${p * 100}% ${0.09 * style.font_size * scale}px`;
    css.backgroundPosition = "0 100%";
    css.paddingBottom = 0.06 * style.font_size * scale;
  }

  if (active && anim === "typewriter") {
    // Las letras aparecen al ritmo de la palabra; el resto ocupa su hueco invisible para que nada salte.
    const n = Math.max(1, Math.ceil(text.length * interpolate(sinceStart, [0, dur * 0.8], [0, 1], clamp)));
    return (
      <span style={css}>
        {text.slice(0, n)}
        <span style={{ opacity: 0 }}>{text.slice(n)}</span>
      </span>
    );
  }
  return <span style={css}>{text}</span>;
};

/** `topPx`: si se da y la plantilla usa placement "below_video", los subtítulos empiezan ahí (debajo del vídeo). */
export const Captions: React.FC<{ words: CaptionWord[]; style: CaptionStyle; topPx?: number | null }> = ({ words, style, topPx }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const t = frame / fps;
  const scale = height / BASE_H;
  const chunks = React.useMemo(() => chunkWords(words, Math.max(1, style.words_per_chunk)), [words, style.words_per_chunk]);
  const hit = activeChunk(chunks, t);
  if (!hit) return null;
  const chunk = hit.chunk;
  const activeIdx = chunk.findIndex((w, i) => t >= w.s && (t < (chunk[i + 1]?.s ?? Infinity)));
  const below = style.placement === "below_video" && topPx != null;
  const sinceChunk = t - chunk[0].s;
  const chunkAnim: React.CSSProperties = style.animation === "chunk_fade"
    ? {
        opacity: interpolate(sinceChunk, [0, 0.18], [0, 1], clamp),
        transform: `translateY(${interpolate(sinceChunk, [0, 0.25], [0.15, 0], clamp)}em)`,
      }
    : {};
  const boxed = !!style.chunk_bg_color;

  return (
    <AbsoluteFill style={{ justifyContent: below ? "flex-start" : "flex-end", alignItems: "center", pointerEvents: "none" }}>
      <div
        style={{
          ...(below ? { marginTop: topPx! + 30 * scale } : { marginBottom: style.margin_v * scale }),
          maxWidth: `${100 - 2 * (style.side_margin ?? 7)}%`,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          // Hueco suficiente para que la palabra activa, al agrandarse, no pise a sus vecinas.
          columnGap: style.animation === "pop" || style.animation === "bounce" ? "0.5em" : "0.3em",
          rowGap: "0.05em",
          textAlign: "center",
          lineHeight: 1.18,
          fontFamily: fontFamily(style.font),
          fontWeight: style.font_weight,
          fontSize: style.font_size * scale,
          color: style.primary_color,
          ...textStroke(style.outline_width, style.outline_color, scale),
          textShadow: style.shadow
            ? `${style.shadow * 1.5 * scale}px ${style.shadow * 1.5 * scale}px 0 rgba(0,0,0,0.55)`
            : undefined,
          ...(boxed ? {
            background: hexToRgba(style.chunk_bg_color!, style.chunk_bg_opacity ?? 0.6),
            padding: `${0.18 * style.font_size * scale}px ${0.4 * style.font_size * scale}px`,
            borderRadius: 0.16 * style.font_size * scale,
          } : {}),
          ...chunkAnim,
        }}
      >
        {chunk.map((w, i) => (
          <Word key={`${w.s}-${i}`} word={w} state={i < activeIdx ? "past" : i === activeIdx ? "active" : "future"}
            style={style} scale={scale} sinceStart={t - w.s} untilEnd={hit.end - t} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** Valores efectivos del gancho: los suyos o, si faltan, los del estilo de subtítulos. */
export function hookProps(hook: HookT, style: CaptionStyle) {
  return {
    x: hook.x ?? 0.5,
    y: hook.y ?? 230 / BASE_H,
    size: hook.size ?? style.hook_font_size,
    font: hook.font ?? style.font,
    weight: hook.weight ?? Math.max(style.font_weight, 700),
    color: hook.color ?? style.hook_text_color,
    bg: hook.bg ?? style.hook_bg_color,
    anim: hook.anim ?? ("pop" as const),
    start: hook.start ?? 0,
    duration: hook.duration ?? style.hook_duration,
    uppercase: hook.uppercase ?? false,
  };
}

export const Hook: React.FC<{ hook: HookT; style: CaptionStyle }> = ({ hook, style }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const scale = height / BASE_H;
  const p = hookProps(hook, style);
  const t = frame / fps - p.start;
  if (!style.hook_enabled || !hook.text.trim() || t < 0 || t > p.duration) return null;
  // Si arranca con el vídeo, se ve desde el primer fotograma (la miniatura y el editor lo enseñan); si no, entra con fundido.
  const fade = p.start > 0
    ? interpolate(t, [0, 0.12, p.duration - 0.2, p.duration], [0, 1, 1, 0], clamp)
    : interpolate(t, [p.duration - 0.2, p.duration], [1, 0], clamp);
  const s = spring({ frame: t * fps, fps, config: { damping: 13, stiffness: p.anim === "drop" ? 200 : 120, overshootClamping: true } });
  const tf = ["translateX(-50%)"];
  let opacity = fade;
  if (p.anim === "pop") tf.push(`scale(${interpolate(s, [0, 1], [0.85, 1])})`);
  else if (p.anim === "slide") tf.push(`translateY(${interpolate(s, [0, 1], [-80 * scale, 0])}px)`);
  else if (p.anim === "drop") tf.push(`scale(${interpolate(s, [0, 1], [2.2, 1])})`);
  else if (p.anim === "none") opacity = t > p.duration - 0.2 ? fade : 1;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: `${p.x * 100}%`,
          top: `${p.y * 100}%`,
          maxWidth: "84%",
          width: "max-content",
          opacity,
          transform: tf.join(" "),
          transformOrigin: "50% 0",
          background: p.bg || undefined,
          color: p.color,
          fontFamily: fontFamily(p.font),
          fontWeight: p.weight,
          fontSize: p.size * scale,
          textTransform: p.uppercase ? "uppercase" : undefined,
          lineHeight: 1.15,
          textAlign: "center",
          padding: p.bg ? `${14 * scale}px ${26 * scale}px` : 0,
          borderRadius: 14 * scale,
          textShadow: p.bg ? undefined : `0 ${4 * scale}px ${14 * scale}px rgba(0,0,0,0.55)`,
        }}
      >
        {hook.text}
      </div>
    </AbsoluteFill>
  );
};
