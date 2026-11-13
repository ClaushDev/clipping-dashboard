/**
 * Composición: la descripción completa de un vídeo. La comparten el editor (vista previa con @remotion/player),
 * el renderer (render.mjs) y el backend (clipping/pipeline/compose.py genera la inicial). Mantener ambos lados sincronizados.
 */

export type Aspect = "9:16" | "1:1" | "4:5" | "16:9";

export const ASPECT_SIZE: Record<Aspect, [number, number]> = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
  "16:9": [1920, 1080],
};

/** Crop: recorta siguiendo los puntos clave · fit_*: vídeo completo con bandas negras, fondo desenfocado o de color ·
 *  split: pantalla dividida en paneles horizontales, cada uno con su propio recorte (cámara + gameplay, podcast a dos). */
export type Layout = "crop" | "fit_black" | "fit_blur" | "fit_color" | "split";

/** Panel de pantalla dividida: franja del lienzo (y, h en 0-1, ancho completo) con su recorte del vídeo original. */
export interface Panel {
  y: number;
  h: number;
  keys: CropKey[];
  label?: string; // "Cámara", "Gameplay", "Persona 1"…
  /** Cover: recorta para llenar el panel · contain: se ve casi toda la escena (zoom 1 = entera) con fondo desenfocado. */
  fit?: "cover" | "contain";
}

/** Colocación del vídeo en un panel "contain": tamaño escalado y desplazamiento (px del panel), y la zona visible
 *  del original (normalizada) para dibujar el marco en el editor. */
export function containPlacement(srcW: number, srcH: number, boxW: number, boxH: number, k: { x: number; y: number; zoom: number }) {
  const scale = Math.min(boxW / srcW, boxH / srcH) * Math.max(1, k.zoom);
  const w = srcW * scale;
  const h = srcH * scale;
  const place = (box: number, size: number, center: number) =>
    size <= box ? (box - size) / 2 : Math.min(0, Math.max(box - size, box / 2 - center * size));
  const left = place(boxW, w, k.x);
  const top = place(boxH, h, k.y);
  return {
    width: w, height: h, left, top,
    visible: { x0: -left / w, y0: -top / h, x1: Math.min(1, (boxW - left) / w), y1: Math.min(1, (boxH - top) / h) },
  };
}

/** Punto clave de encuadre. t en segundos desde el inicio del tramo; x, y = centro del encuadre (0-1 sobre el
 *  vídeo original); zoom 1 = el encuadre más grande posible con el formato de salida. */
export interface CropKey {
  t: number;
  x: number;
  y: number;
  zoom: number;
  /** Cómo se llega a este punto desde el anterior: hold = corte · smooth = movimiento suave · cualquier curva de
   *  fotograma clave (custom = `bezier`). Sin campo, corte. */
  ease?: CamEase;
  bezier?: Bezier;
  /** A quién sigue este plano ("Persona 1"), cuando la cámara sigue a quien habla. */
  label?: string;
  /** Con movimiento suave, segundos que dura la rampa hasta este punto (acaba en `t`). Sin campo, todo el plano
   *  anterior. */
  dur?: number;
}

/** Corte, transición (fundido) o zoom que ya trae el vídeo original. t en segundos del original. */
export interface SourceCut {
  t: number;
  kind: "cut" | "transition" | "zoom";
}

export const SOURCE_CUT_LABEL: Record<SourceCut["kind"], string> = {
  cut: "Corte del vídeo original",
  transition: "Transición del vídeo original",
  zoom: "Zoom del vídeo original",
};

/** Cortes del original de un tramo en segundos de la timeline (desde el inicio del tramo, a su velocidad). */
export function sourceCutsLocal(s: Segment): (SourceCut & { at: number })[] {
  return (s.source_cuts ?? [])
    .filter((c) => c.t > s.src_in && c.t < s.src_out)
    .map((c) => ({ ...c, at: segmentLocalOf(s, c.t - s.src_in) }));
}

/** Curvas de la cámara (las de siempre más las de los fotogramas clave). */
export type CamEase = KeyEase | "smooth";

/** Fotograma clave de un solo valor (volumen). La curva por defecto es lineal, como en Premiere. */
export interface ValueKey {
  t: number;
  v: number;
  ease?: KeyEase;
  bezier?: Bezier;
}

export interface Segment {
  id: string;
  src: string;
  src_w: number;
  src_h: number;
  src_in: number;
  src_out: number;
  layout: Layout;
  bg_color?: string;
  keys: CropKey[];
  /** Solo con layout "split". */
  panels?: Panel[];
  /** Por qué se eligió este encuadre automáticamente (se muestra en el editor). */
  note?: string;
  volume: number;
  /** Velocidad de reproducción (0.5 = cámara lenta). Los puntos clave siguen en segundos del original. */
  speed?: number;
  /** Segundos de imagen congelada (el último fotograma) al final del tramo. */
  freeze?: number;
  /** Etiqueta libre (p. ej. la frase que ilustra). */
  label?: string;
  /** Gancho adelantado: copia de un tramo posterior que se ve antes del inicio (compose.add_cold_open). */
  cold_open?: boolean;
  /** Sujeto recortado para los efectos de recorte. */
  matte?: Matte;
  /** Corte J/L: segundos que se desplaza el corte de audio respecto al de imagen al empezar este tramo.
   *  Negativo = corte J (se oye este plano antes de verlo) · positivo = corte L (sigue oyéndose el anterior). */
  audio_offset?: number;
  /** Cortes, transiciones y zooms del vídeo original dentro del tramo (se marcan en la pista «Cámara»).
   *  Sin el campo = aún no se han buscado. */
  source_cuts?: SourceCut[];
  /** Volumen con fotogramas clave (t en segundos del original desde src_in, como los encuadres). Con claves
   *  manda la curva y `volume` solo es el valor de partida. */
  vol_keys?: ValueKey[];
  /** Rampa de velocidad (remapeo de tiempo). t en segundos del original desde src_in, v = velocidad (0,1-8).
   *  Con claves no cuenta `speed`. El sonido original del tramo se silencia (como al congelar). */
  speed_keys?: ValueKey[];
  /** El tramo se ve marcha atrás (sin su sonido). */
  reverse?: boolean;
  /** Voz mejorada (ruido quitado con RNNoise): sonido limpio del mismo archivo, con los mismos tiempos, que suena
   *  en lugar del sonido del vídeo. level: light | strong. */
  voice?: { src: string; level: string };
  /** Pista de vídeo que se ve en este tramo (id de `Composition.angles`). Sin campo, la principal. El sonido sigue
   *  siendo el de la principal. */
  angle?: string;
}

/** Otra pista de vídeo (multicámara): la misma grabación duplicada con otro encuadre, u otro archivo
 *  sincronizado. Un tramo la elige con `Segment.angle`. */
export interface Angle {
  id: string;
  label: string;
  src: string;
  src_w: number;
  src_h: number;
  /** Segundos que se suman al tiempo del original para leer esta pista (sincronía). 0 = la misma grabación. */
  offset: number;
  /** Encuadre fijo encima del del tramo: zoom (≥ 1) hacia el punto (x, y) del plano. */
  zoom: number;
  x: number;
  y: number;
}

/** Pista que se ve en un tramo (undefined = la principal). */
export function angleOf(c: { angles?: Angle[] }, s: Segment): Angle | undefined {
  return s.angle ? c.angles?.find((a) => a.id === s.angle) : undefined;
}

/** Tramo con el tiempo cambiado (rampa o marcha atrás): se dibuja fotograma a fotograma y sin su sonido. */
export function isRemapped(s: Segment): boolean {
  return !!s.speed_keys?.length || !!s.reverse;
}

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 8;
const rampCache = new WeakMap<ValueKey[], { srcLen: number; out: number[]; h: number }>();

/** Tabla de la rampa: out[i] = segundos de timeline hasta el segundo i·h del original. */
function rampTable(s: Segment) {
  const keys = s.speed_keys!;
  const srcLen = Math.max(0, s.src_out - s.src_in);
  const hit = rampCache.get(keys);
  if (hit && hit.srcLen === srcLen) return hit;
  const n = Math.max(20, Math.ceil(srcLen * 60));
  const h = srcLen / n;
  const out = [0];
  for (let i = 0; i < n; i++) {
    const sp = Math.min(SPEED_MAX, Math.max(SPEED_MIN, valueAt(keys, (i + 0.5) * h, 1)));
    out.push(out[i] + h / sp);
  }
  const table = { srcLen, out, h };
  rampCache.set(keys, table);
  return table;
}

/** Lo que dura en la timeline la parte en movimiento del tramo (sin el congelado). */
export function movingLength(s: Segment): number {
  const srcLen = Math.max(0, s.src_out - s.src_in);
  if (!s.speed_keys?.length) return srcLen / (s.speed || 1);
  const t = rampTable(s);
  return t.out[t.out.length - 1];
}

/** Segundo del original que se ve en el segundo `local` del tramo, sin tener en cuenta la marcha atrás. */
function forwardSource(s: Segment, local: number): number {
  const srcLen = Math.max(0, s.src_out - s.src_in);
  if (!s.speed_keys?.length) return Math.min(local * (s.speed || 1), srcLen);
  const { out, h } = rampTable(s);
  if (local >= out[out.length - 1]) return srcLen;
  let lo = 0;
  let hi = out.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (out[m] <= local) lo = m;
    else hi = m;
  }
  return Math.min(srcLen, (lo + (local - out[lo]) / Math.max(out[hi] - out[lo], 1e-9)) * h);
}

/** Segundo del tramo en la timeline en el que se ve el segundo `srcLocal` del original (desde src_in). */
export function segmentLocalOf(s: Segment, srcLocal: number): number {
  const srcLen = Math.max(0, s.src_out - s.src_in);
  const x = s.reverse ? srcLen - srcLocal : srcLocal;
  if (!s.speed_keys?.length) return x / (s.speed || 1);
  const { out, h } = rampTable(s);
  const i = Math.min(out.length - 2, Math.max(0, Math.floor(x / Math.max(h, 1e-9))));
  return out[i] + (out[i + 1] - out[i]) * Math.min(1, Math.max(0, x / Math.max(h, 1e-9) - i));
}

/** Recorte del sujeto (rotoscopia SAM 2): el mismo vídeo o imagen con el fondo transparente. `src_in`: segundo del
 *  original en el que empieza el recorte (vídeo); se dibuja con el mismo encuadre que el original. */
export interface Matte {
  src: string;
  src_in: number;
}

/** Duración del tramo en la timeline: lo que dura a su velocidad más el congelado. */
export function segmentLength(s: Segment): number {
  return movingLength(s) + Math.max(0, s.freeze ?? 0);
}

/** Ventana de audio de cada tramo en la timeline [inicio, fin): con cortes J/L no coincide con la imagen. El audio
 *  no entra en el congelado salvo lo que se alargue con un corte L. */
export function segmentAudioWindows(segments: Segment[]): [number, number][] {
  const offsets = segmentOffsets(segments);
  const shift = (i: number) => (i > 0 && i < segments.length ? audioOffset(segments, i) : 0);
  return segments.map((s, i) => {
    const moving = movingLength(s);
    const a = offsets[i] + shift(i);
    const next = i + 1 < segments.length ? offsets[i + 1] + shift(i + 1) : offsets[i] + segmentLength(s);
    return [a, Math.max(a, Math.min(next, offsets[i] + moving + Math.max(0, shift(i + 1))))];
  });
}

/** Desplazamiento J/L del corte al empezar el tramo i, limitado para que no se coma más de medio plano a ningún lado. */
export function audioOffset(segments: Segment[], i: number): number {
  const v = segments[i]?.audio_offset ?? 0;
  if (!v || i <= 0) return 0;
  const lim = Math.min(segmentLength(segments[i - 1]), segmentLength(segments[i])) / 2;
  return Math.max(-lim, Math.min(lim, v));
}

export function hasSplitAudio(segments: Segment[]): boolean {
  // Con multicámara el sonido va aparte (siempre el de la pista principal), como con los cortes J/L
  return segments.some((s, i) => audioOffset(segments, i) !== 0 || !!s.angle);
}

/** Segundo del original (relativo a src_in) que se ve en el segundo `local` del tramo en la timeline. */
export function segmentSourceLocal(s: Segment, local: number): number {
  const f = forwardSource(s, Math.max(0, local));
  return s.reverse ? Math.max(0, s.src_out - s.src_in - f) : f;
}

export interface CaptionWord {
  w: string;
  s: number;
  e: number;
  hl?: boolean; // Palabra destacada (color de resaltado aunque no sea la activa)
  hl2?: boolean; // Palabra destacada con el segundo color (highlight_color2): nombres, cifras, objetos
  /** Archivo del que sale la palabra (montajes de varios vídeos con time_base "source"): así un mismo segundo de dos
   *  archivos distintos no se confunde. Sin `src`, vale cualquier tramo. */
  src?: string;
  /** Estilo propio de esta palabra: mezcla colores, pesos, tamaños, fuentes y animaciones dentro de una frase. */
  st?: WordStyle;
}

/** Salida de una palabra cuando su bloque deja la pantalla. */
export type WordOut = "none" | "fade" | "shrink" | "blur" | "up";

/** Lo que una palabra cambia frente al estilo general de los subtítulos. Todo opcional: lo que falta, del estilo. */
export interface WordStyle {
  color?: string;
  weight?: number;
  /** Tamaño relativo (1 = el del estilo). */
  scale?: number;
  font?: string;
  italic?: boolean;
  /** Entrada / efecto mientras se dice (las mismas animaciones de los subtítulos). */
  anim?: WordAnimation;
  out?: WordOut;
}

/** Signos en los subtítulos: todos, solo los expresivos (¿? ¡!) o ninguno. Por defecto, todos. */
export type CaptionPunctuation = "all" | "expressive" | "none";

export type HighlightMode = "color" | "box" | "underline";
/** Animaciones de subtítulos. Gancho: pop, bounce, glow. Serias/minimalistas: chunk_fade, fade_in, dim,
 *  reveal_up, blur_in, typewriter, sweep, none. */
export type WordAnimation =
  | "pop" | "bounce" | "glow" | "none"
  | "chunk_fade" | "fade_in" | "dim" | "reveal_up" | "blur_in" | "typewriter" | "sweep";

export type HookAnim = "pop" | "fade" | "slide" | "drop" | "none";

/** Gancho en pantalla. Solo `text` es obligatorio: el resto se edita como una capa y, si falta, sale de los
 *  `hook_*` del estilo de subtítulos (lo que genera el backend sigue siendo `{text}`). */
export interface Hook {
  text: string;
  /** Centro horizontal y borde superior, en fracción del lienzo (por defecto 0,5 y 0,12). */
  x?: number;
  y?: number;
  /** Tamaño en px de un lienzo de 1920 de alto. */
  size?: number;
  font?: string;
  weight?: number;
  color?: string;
  /** Fondo de la caja ("" = sin caja). */
  bg?: string;
  anim?: HookAnim;
  start?: number;
  duration?: number;
  uppercase?: boolean;
}

export interface CaptionStyle {
  font: string;
  font_size: number;
  font_weight: number;
  primary_color: string;
  highlight_color: string;
  highlight_mode: HighlightMode;
  box_color: string;
  outline_color: string;
  outline_width: number;
  shadow: number;
  uppercase: boolean;
  words_per_chunk: number;
  margin_v: number;
  animation: WordAnimation;
  /** Caja detrás del bloque de subtítulos ("" = sin caja), estilo Netflix/corporativo. */
  chunk_bg_color?: string;
  chunk_bg_opacity?: number;
  hook_enabled: boolean;
  hook_font_size: number;
  hook_text_color: string;
  hook_bg_color: string;
  hook_duration: number;
  /** "below_video": en los encuadres de vídeo completo, justo debajo del vídeo (si cabe); si no, margin_v. */
  placement?: "bottom" | "below_video";
  /** Color de las palabras con `hl2` (segundo énfasis). Sin él, usan highlight_color. */
  highlight_color2?: string;
  /** False: la palabra que se está diciendo no cambia de color (solo las destacadas). Por defecto, sí. */
  active_highlight?: boolean;
  /** Margen lateral seguro, % del ancho a cada lado (por defecto 7). */
  side_margin?: number;
  /** Qué signos se ven en los subtítulos. La transcripción los conserva siempre: esto solo cambia lo que se pinta. */
  punctuation?: CaptionPunctuation;
}

/** Borde inferior (px) del vídeo cuando se muestra completo (bandas/fondo), o null si no deja hueco debajo. */
export function videoBandBottom(layout: Layout, srcW: number, srcH: number, outW: number, outH: number): number | null {
  if (layout === "crop" || layout === "split" || !srcW || !srcH) return null;
  const scale = Math.min(outW / srcW, outH / srcH);
  const bottom = (outH + srcH * scale) / 2;
  return outH - bottom > outH * 0.12 ? bottom : null;
}

/** Draw: la forma se dibuja (círculo, recuadro, flecha, subrayado). */
/** Entrada de la capa. pop/bounce/zoom/spin/drop/slide*: cómo aparece · draw: se dibuja (señales) ·
 *  count: los números del texto cuentan desde 0 · type: el texto se escribe letra a letra. */
export type OverlayAnim = "none" | "fade" | "pop" | "slide" | "draw" | "bounce" | "zoom" | "spin" | "drop" | "slide_left"
  | "slide_right" | "count" | "type";
/** Movimiento mientras está en pantalla (stickers, emojis, fotos): flota, late, se balancea o gira. */
export type OverlayLoop = "none" | "float" | "pulse" | "wiggle" | "spin";

interface OverlayBase {
  id: string;
  start: number;
  end: number;
  x: number; // Centro, 0-1 sobre el lienzo
  y: number;
  w: number; // Ancho, 0-1 del lienzo
  anim: OverlayAnim;
  loop?: OverlayLoop;
  rot?: number; // Giro fijo en grados (textos e imágenes)
  /** Fotogramas clave: posición, escala, giro y opacidad a lo largo de la capa; t relativo a su inicio. */
  keys?: OverlayKey[];
  /** Sigue una cara o un punto: recorrido en el lienzo, t relativo al inicio de la capa. La capa se mueve lo
   *  mismo que el recorrido desde su primer punto (así puede ir encima de la cabeza, al lado…). */
  follow?: { t: number; x: number; y: number }[];
  /** Máscara: solo se ve (o, en las capas de ajuste, solo se corrige) lo que queda dentro. */
  mask?: Mask;
}

/** Máscara en el lienzo (0-1): rectángulo o elipse (centro x, y y tamaño w, h), polígono dibujado a mano (`points`) o,
 *  solo en capas de ajuste, el sujeto recortado del plano (5b). feather: borde suave (0-0,3) · invert: lo de fuera. */
export interface Mask {
  shape: "rect" | "ellipse" | "poly" | "subject";
  x: number;
  y: number;
  w: number;
  h: number;
  points?: [number, number][];
  feather: number;
  invert?: boolean;
}

/** Curva con la que se llega a un fotograma clave desde el anterior. custom = `bezier` (como cubic-bezier de CSS). */
export type KeyEase = "linear" | "ease" | "ease_in" | "ease_out" | "back" | "hold" | "custom";
export type Bezier = [number, number, number, number];
export const EASE_BEZIER: Record<Exclude<KeyEase, "hold" | "custom">, Bezier> = {
  linear: [0, 0, 1, 1],
  ease: [0.42, 0, 0.58, 1],
  ease_in: [0.5, 0, 0.9, 0.4],
  ease_out: [0.1, 0.6, 0.5, 1],
  back: [0.34, 1.56, 0.64, 1],
};

/** X, y = centro en el lienzo (0-1) · scale = sobre el tamaño de la capa · rot en grados · opacity 0-1. */
export interface OverlayKey {
  t: number;
  x: number;
  y: number;
  scale: number;
  rot: number;
  opacity: number;
  ease?: KeyEase;
  bezier?: Bezier;
}

export type KeyedState = Pick<OverlayKey, "x" | "y" | "scale" | "rot" | "opacity">;

/** Valor de una curva cubic-bezier (como en CSS) en el progreso p (0-1). */
export function bezierAt(b: Bezier, p: number): number {
  const [x1, y1, x2, y2] = b;
  const coord = (u: number, a: number, c: number) => 3 * a * u * (1 - u) ** 2 + 3 * c * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  let u = p;
  for (let i = 0; i < 30; i++) {
    const x = coord(u, x1, x2);
    if (Math.abs(x - p) < 1e-5) break;
    if (x < p) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return coord(u, y1, y2);
}

/** Progreso (0-1) con la curva de una clave; null = salto (se queda en la clave anterior). */
export function easeAt(ease: CamEase, bezier: Bezier | undefined, p: number): number | null {
  if (ease === "hold") return null;
  if (ease === "smooth") return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // EaseInOutQuad
  return bezierAt(ease === "custom" ? bezier ?? EASE_BEZIER.ease : EASE_BEZIER[ease], p);
}

/** Bézier equivalente a una curva (para dibujarla o pasarla a personalizada); null = salto. */
export function easeBezier(ease: CamEase, bezier?: Bezier): Bezier | null {
  if (ease === "hold") return null;
  if (ease === "smooth") return [0.45, 0, 0.55, 1];
  return ease === "custom" ? bezier ?? EASE_BEZIER.ease : EASE_BEZIER[ease];
}

/** Valor de unas claves de un solo valor en t; sin claves, `fallback`. */
export function valueAt(keys: ValueKey[] | undefined, t: number, fallback: number): number {
  if (!keys?.length) return fallback;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t < b.t) {
      const e = easeAt(b.ease ?? "linear", b.bezier, (t - a.t) / Math.max(b.t - a.t, 1e-6));
      return e === null ? a.v : a.v + (b.v - a.v) * e;
    }
  }
  return keys[keys.length - 1].v;
}

/** Crea o cambia la clave de t (a medio fotograma de distancia cuenta como la misma) y deja las claves ordenadas. */
export function upsertValueKey(keys: ValueKey[] | undefined, t: number, v: number, fps: number): ValueKey[] {
  const list = keys ?? [];
  const i = list.findIndex((k) => Math.abs(k.t - t) < 0.5 / fps);
  if (i >= 0) return list.map((k, j) => (j === i ? { ...k, v } : k));
  return [...list, { t: +t.toFixed(3), v }].sort((a, b) => a.t - b.t);
}

/** Estado de la capa en el segundo t (relativo a su inicio) según sus fotogramas clave; sin claves, el de la capa. */
export function keyedAt(o: { x: number; y: number; keys?: OverlayKey[] }, t: number): KeyedState {
  const keys = o.keys;
  if (!keys?.length) return { x: o.x, y: o.y, scale: 1, rot: 0, opacity: 1 };
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t < b.t) {
      const e = easeAt(b.ease ?? "ease", b.bezier, (t - a.t) / Math.max(b.t - a.t, 1e-6));
      if (e === null) return a;
      const mix = (k: keyof KeyedState) => a[k] + (b[k] - a[k]) * e;
      return { x: mix("x"), y: mix("y"), scale: mix("scale"), rot: mix("rot"), opacity: Math.max(0, Math.min(1, mix("opacity"))) };
    }
  }
  return keys[keys.length - 1];
}

export interface TextOverlay extends OverlayBase {
  kind: "text";
  text: string;
  size: number;
  color: string;
  bg: string; // "" = sin fondo
  font: string;
  weight: number;
  /** Alineación dentro de su caja (por defecto centrado). */
  align?: "left" | "center" | "right";
  /** Contorno en px de un lienzo de 1920 de alto (sin fondo, 4 por defecto) y su color (negro por defecto). */
  stroke?: number;
  stroke_color?: string;
  /** Sombra paralela en px (0 o ausente = sin sombra); usa el color del contorno. */
  shadow?: number;
  opacity?: number;
}

export interface ImageOverlay extends OverlayBase {
  kind: "image";
  src: string;
  opacity: number;
}

/** Señalización (capa de enganche). x, y = centro (círculo, recuadro, subrayado) o punta (flecha); w, h en 0-1 del
 *  lienzo; rotation en grados: hacia dónde apunta la flecha (0 = derecha, 90 = abajo). `path` mueve la forma para
 *  seguir un objeto (t en segundos desde el inicio de la capa). */
export interface ShapeOverlay extends OverlayBase {
  kind: "shape";
  shape: "circle" | "box" | "arrow" | "underline";
  h: number;
  color: string;
  stroke: number; // Grosor en px de un lienzo de 1920 de alto
  rotation: number;
  path?: { t: number; x: number; y: number }[];
}

/** Barra «espera…»: texto con una barra que se llena durante la capa. */
export interface ProgressOverlay extends OverlayBase {
  kind: "progress";
  text: string;
  color: string;
}

/** Bloque animado del catálogo de HyperFrames (heygen-com/hyperframes, Apache 2.0): rótulos, títulos, gráficos,
 *  mapas, tarjetas de redes… Se dibuja en un iframe aislado y se lleva a cada fotograma (remotion/block.tsx).
 *  x, y = centro y w, h = caja en 0-1 del lienzo; el bloque cabe dentro conservando su proporción (base_w × base_h)
 *  o, si es un componente (base_w = 0), llena la caja. Los cambios los aplica el backend al servir `src`. */
export interface BlockOverlay extends OverlayBase {
  kind: "block";
  block: string;
  title: string;
  /** "/api/blocks/<nombre>/doc" (el backend la hace absoluta al renderizar). */
  src: string;
  h: number;
  base_w: number;
  base_h: number;
  /** Variables declaradas por el bloque (id → valor). */
  vars: Record<string, string | number | boolean>;
  /** Textos cambiados: índice del texto en el bloque → texto nuevo. */
  texts: Record<string, string>;
  /** Colores cambiados: original (#rrggbb) → nuevo. */
  colors: Record<string, string>;
  /** Imágenes cambiadas: ruta original → URL nueva. */
  images: Record<string, string>;
  /** Quita el fondo del bloque para ponerlo encima del vídeo. */
  transparent: boolean;
}

/** Plantilla o gráfico animado (checklist, chat, curva…) encima del vídeo, sin su fondo. Se dibuja a tamaño de
 *  lienzo y se reduce a `w` (1 = pantalla completa) con su centro en x, y; la plantilla trae su propia entrada. */
export interface GraphicOverlay extends OverlayBase {
  kind: "graphic";
  component: string;
  props: Record<string, unknown>;
}

/** Efecto de recorte sobre el plano con sujeto recortado: las capas que van antes en la lista quedan detrás
 *  del sujeto. behind = solo el sujeto delante · screen = fondo nuevo (croma sin verde) · paper = recortable de papel ·
 *  escape = el sujeto se sale del marco · portal = portal circular con zoom · orbit = paralaje 2,5D. */
export type CutoutMode = "behind" | "screen" | "paper" | "escape" | "portal" | "orbit";

export interface CutoutOverlay extends OverlayBase {
  kind: "cutout";
  mode: CutoutMode;
  /** Fondo: color (#hex), "blur" (el original desenfocado) o la URL de una imagen o vídeo. */
  bg: string;
  /** Borde del papel, del marco o del portal. */
  color: string;
}

/** Clip de vídeo en una pista superior (V2, V3…): B-roll, imagen en imagen o un plano encima del principal.
 *  x, y = centro y w = ancho (0-1 del lienzo); el alto sale de la proporción del vídeo. `fill`: cubre todo el lienzo
 *  (plano de recurso a pantalla completa). Las pistas altas se dibujan encima de las bajas. */
export interface VideoOverlay extends OverlayBase {
  kind: "video";
  src: string;
  src_in: number;
  src_w: number;
  src_h: number;
  volume: number;
  /** Volumen con fotogramas clave (t en segundos desde el inicio de la capa). Con claves manda la curva. */
  vol_keys?: ValueKey[];
  opacity: number;
  track: number;
  fill?: boolean;
  /** Esquinas redondeadas y borde (imagen en imagen). */
  radius?: number;
  border?: string;
}

/** LUT .cube importado, ajustado a curvas por canal + matriz 3×4 (se dibuja en vivo; `fit` = parecido con el
 *  original, 0-1). */
export interface Lut {
  name: string;
  curves: [number[], number[], number[]];
  matrix: number[];
  fit?: number;
}

/** Etalonaje. exposure en pasos (0 = igual) · contrast y saturation (1 = igual) · temperature (-1 frío, 1
 *  cálido) y tint (-1 verde, 1 magenta) · vignette 0-1 · look: id de un look incluido o "lut" (usa `lut`), con su
 *  intensidad `amount` (0-1). */
export interface Grade {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  vignette?: number;
  look?: string;
  amount?: number;
  lut?: Lut;
}

/** Capa de ajuste: corrige el color de todo lo que está debajo (el vídeo y las capas anteriores de la lista)
 *  mientras dura, entera o dentro de su máscara. Las claves mueven y escalan la máscara y su opacidad funde el efecto. */
export interface AdjustOverlay extends OverlayBase {
  kind: "adjust";
  grade: Grade;
}

export type Overlay = AdjustOverlay | VideoOverlay | CutoutOverlay | TextOverlay | ImageOverlay | ShapeOverlay | ProgressOverlay | BlockOverlay | GraphicOverlay;

/** Efectos de cámara sobre el vídeo (no afectan a subtítulos ni capas). x, y = punto hacia el que se hace zoom.
 *  Cámara — punch: zoom brusco y se mantiene · zoom: acercamiento lento durante todo el efecto · pan: barrido hacia
 *  `dir` · drift: cámara en mano que flota · shake: temblor.
 *  Transiciones (centradas en el corte) — whip: barrido rápido con desenfoque · slide: empuje lateral ·
 *  zoom_cut: zoom que atraviesa el corte · zoom_through: se mete muy dentro del punto y sale al plano nuevo ·
 *  flash: destello (blanco o `color`) · glitch: interferencia · blur: desenfoque que crece hasta el corte y se aclara
 *  en el plano nuevo · blur_zoom: desenfoque con un zoom suave · leak: fuga de luz de color.
 *  Color — bw: blanco y negro. amount: intensidad (zoom: 0.3 = +30 %). */
export type FxKind = "punch" | "zoom" | "pan" | "drift" | "shake" | "whip" | "slide" | "zoom_cut" | "zoom_through" | "flash" | "glitch"
  | "blur" | "blur_zoom" | "leak" | "bw";
export type FxDir = "left" | "right" | "up" | "down";
export const TRANSITION_FX: FxKind[] = ["whip", "slide", "zoom_cut", "zoom_through", "flash", "glitch", "blur", "blur_zoom", "leak"];

export interface Fx {
  id: string;
  kind: FxKind;
  start: number;
  end: number;
  x: number;
  y: number;
  amount: number;
  dir?: FxDir; // Pan, whip, slide
  /** Punch: segundos de entrada y de salida suaves (sin él, entra con rebote y vuelve de golpe). */
  ramp?: number;
  /** Zoom: llega en `steps` saltos secos en vez de en continuo («zoom digital» de cámara). */
  steps?: number;
  /** Flash y leak: color de la luz (sin él, blanco y ámbar). */
  color?: string;
  /** Id del sonido (whoosh) que va con esta transición; se mueve y se borra con ella. */
  whoosh?: string;
}

export interface AudioTrack {
  id: string;
  src: string;
  start: number; // En la timeline
  src_in: number;
  duration: number; // 0 = hasta el final del vídeo
  volume: number;
  fade_in: number;
  fade_out: number;
  /** Voice: narración · music: música de fondo · sfx: efecto de sonido. */
  kind?: "voice" | "music" | "sfx";
  /** Volumen relativo mientras habla la voz (0.3 = baja al 30 %); 0 o ausente = sin ducking. */
  duck?: number;
  /** Nombre legible (sonidos de la librería). */
  label?: string;
  /** Repetir la pista hasta cubrir su duración (música de fondo de un vídeo largo). */
  loop?: boolean;
  /** Volumen con fotogramas clave (t en segundos desde el inicio de la pista). Con claves manda la curva. */
  vol_keys?: ValueKey[];
}

/** Grupos de la mezcla: sonido del vídeo original, voz en off, música, efectos y clips de las pistas V2+. */
export type MixBus = "original" | "voice" | "music" | "sfx" | "clips";
export const MIX_BUSES: MixBus[] = ["original", "voice", "music", "sfx", "clips"];

/** Mezcla: ganancia por grupo y general, silenciar y solo, y ducking automático: la música (y los clips con
 *  sonido) bajan a `level` mientras se habla, con entrada `attack` y salida `release` en segundos. `original`: también
 *  baja el sonido del vídeo original bajo la voz en off. El `duck` de cada pista manda sobre el automático. */
export interface Mix {
  master?: number;
  gain?: Partial<Record<MixBus, number>>;
  mute?: MixBus[];
  solo?: MixBus[];
  duck?: { level: number; attack: number; release: number; original?: boolean };
}

export function audioBus(a: Pick<AudioTrack, "id" | "kind">): MixBus {
  if (a.kind === "voice" || a.id === "narration") return "voice";
  return a.kind === "sfx" ? "sfx" : "music";
}

/** Ganancia final de un grupo con la mezcla (silencio y solo incluidos). */
export function busGain(mix: Mix | undefined, bus: MixBus): number {
  if (!mix) return 1;
  if (mix.mute?.includes(bus) || (mix.solo?.length && !mix.solo.includes(bus))) return 0;
  return (mix.master ?? 1) * (mix.gain?.[bus] ?? 1);
}

/** Tramos en los que se habla (palabras unidas si la pausa es corta). */
export function speechSpans(words: { s: number; e: number }[]): [number, number][] {
  const out: [number, number][] = [];
  for (const w of [...words].sort((a, b) => a.s - b.s)) {
    const last = out[out.length - 1];
    if (last && w.s - last[1] < 0.5) last[1] = Math.max(last[1], w.e);
    else out.push([w.s, w.e]);
  }
  return out;
}

/** Ducking: 1 lejos de la voz y `level` mientras se habla; baja en `attack` s antes de hablar y sube en `release` s. */
export function duckFactor(spans: [number, number][], t: number, level: number, attack = 0.3, release = 0.3): number {
  let k = 1;
  for (const [s, e] of spans) {
    if (t < s - 0.1 - attack || t > e + 0.2 + release) continue;
    const d = t < s - 0.1 ? (s - 0.1 - t) / Math.max(attack, 0.01) : t > e + 0.2 ? (t - e - 0.2) / Math.max(release, 0.01) : 0;
    k = Math.min(k, Math.min(1, d));
    if (k === 0) break;
  }
  return level + (1 - level) * k;
}

/** Nivel de ducking de una pista: el suyo o, para música, el automático de la mezcla. */
export function trackDuck(a: AudioTrack, mix: Mix | undefined): { level: number; attack: number; release: number } | null {
  const attack = mix?.duck?.attack ?? 0.3;
  const release = mix?.duck?.release ?? 0.3;
  if (a.duck) return { level: a.duck, attack, release };
  if (mix?.duck && audioBus(a) === "music") return { level: mix.duck.level, attack, release };
  return null;
}

export interface KenBurns {
  from: { x: number; y: number; zoom: number };
  to: { x: number; y: number; zoom: number };
  ease?: "linear" | "smooth"; // Smooth = arranca y frena suave
  drift?: number; // 0-1: balanceo de cámara en mano encima del movimiento
}

/** Escena: imagen con movimiento, vídeo o motion graphic (vídeos hechos de escenas en vez de un original). */
export interface Scene {
  id: string;
  kind: "image" | "video" | "graphic";
  start: number;
  duration: number;
  src?: string;
  /** Escenas de vídeo IA: imagen de respaldo con movimiento cuando el clip (más corto que la escena) termina. */
  poster?: string;
  video_duration?: number;
  motion?: KenBurns;
  graphic?: { component: string; props: Record<string, unknown> };
  matte?: Matte;
  transition: "cut" | "fade";
}

export interface Composition {
  version: 1;
  aspect: Aspect;
  /** Tamaño exacto del lienzo al exportar (p. ej. 720p). Si falta, el tamaño base del formato. */
  size?: [number, number];
  fps: number;
  segments: Segment[];
  scenes: Scene[];
  captions: {
    enabled: boolean;
    /** "source": tiempos del vídeo original (clipping; se recolocan solos al recortar) · "timeline": tiempos finales. */
    time_base: "source" | "timeline";
    style: CaptionStyle;
    words: CaptionWord[];
  };
  hook: Hook;
  overlays: Overlay[];
  audio: AudioTrack[];
  fx?: Fx[];
  mix?: Mix;
  /** Tramos con voz en la timeline cuando no hay palabras (p. ej. un vídeo importado), para bajar la música. */
  speech?: [number, number][];
  /** Marcadores de la timeline (no se ven en el vídeo). */
  markers?: Marker[];
  /** Pistas de vídeo extra (multicámara). */
  angles?: Angle[];
  /** False = no poner un whoosh al añadir una transición en este proyecto. */
  auto_whoosh?: boolean;
}

/** Marcador con nombre, color y nota, en segundos de la timeline (como en Premiere). */
export interface Marker {
  id: string;
  t: number;
  label: string;
  color?: string;
  note?: string;
}

export const MARKER_COLORS = ["#2f6fd6", "#346538", "#956400", "#9f2f2d", "#6940a5", "#1f6c9f"];

export function canvasSize(c: Composition): [number, number] {
  if (c.size) return c.size;
  return ASPECT_SIZE[c.aspect] ?? ASPECT_SIZE["9:16"];
}

export function segmentsDuration(segments: Segment[]): number {
  return segments.reduce((acc, s) => acc + segmentLength(s), 0);
}

export function compositionDuration(c: Composition): number {
  const seg = segmentsDuration(c.segments);
  const scenes = c.scenes.reduce((acc, s) => Math.max(acc, s.start + s.duration), 0);
  return Math.max(seg, scenes, 0.5);
}

/** Inicio de cada tramo en la timeline. */
export function segmentOffsets(segments: Segment[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of segments) {
    out.push(t);
    t += segmentLength(s);
  }
  return out;
}

/** Convierte un tiempo del vídeo original a la timeline; null si ese instante se ha recortado. Con `src`, solo
 *  cuentan los tramos de ese archivo (montajes de varios vídeos). */
export function sourceToTimeline(segments: Segment[], t: number, src?: string): number | null {
  const offsets = segmentOffsets(segments);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (src && s.src !== src) continue;
    if (t >= s.src_in && t < s.src_out) return offsets[i] + segmentLocalOf(s, t - s.src_in);
  }
  return null;
}

/** Palabras de subtítulo en tiempo de timeline, ordenadas. Con tiempos del original, cada tramo enseña las palabras
 *  de su trozo: si un tramo está duplicado (p. ej. copiado delante como gancho), sus palabras salen en las dos copias. */
export function timelineWords(c: Composition): CaptionWord[] {
  if (c.captions.time_base === "timeline") return c.captions.words;
  return sourceWordsOnTimeline(c).map(({ idx: _idx, ...w }) => w);
}

/** Cada aparición en la timeline de las palabras con tiempos del original, con el índice de la palabra (`idx`). */
export function sourceWordsOnTimeline(c: Composition): (CaptionWord & { idx: number })[] {
  // Las palabras van con el audio del tramo: con cortes J/L se oyen (y se leen) antes o después que su imagen.
  const offsets = segmentOffsets(c.segments);
  const windows = segmentAudioWindows(c.segments);
  const out: (CaptionWord & { idx: number })[] = [];
  c.segments.forEach((seg, k) => {
    if (seg.reverse) return; // Marcha atrás: sin sonido ni subtítulos
    if (seg.speed_keys?.length) {
      // Rampa: cada palabra donde se ve su imagen (el tramo no lleva su sonido, así que no hay cortes J/L)
      c.captions.words.forEach((w, idx) => {
        if (w.s < seg.src_in || w.s >= seg.src_out || (w.src && w.src !== seg.src)) return;
        const s = offsets[k] + segmentLocalOf(seg, w.s - seg.src_in);
        out.push({ ...w, idx, s, e: Math.max(s + 0.05, offsets[k] + segmentLocalOf(seg, Math.min(w.e, seg.src_out) - seg.src_in)) });
      });
      return;
    }
    const rate = seg.speed || 1;
    const end = windows[k][1];
    const from = seg.src_in + (windows[k][0] - offsets[k]) * rate;
    const to = seg.src_in + (end - offsets[k]) * rate;
    c.captions.words.forEach((w, idx) => {
      if (w.s < from || w.s >= to || (w.src && w.src !== seg.src)) return;
      const s = offsets[k] + (w.s - seg.src_in) / rate;
      out.push({ ...w, idx, s, e: Math.min(end, offsets[k] + (w.e - seg.src_in) / rate) });
    });
  });
  return out.sort((a, b) => a.s - b.s);
}

/** Interpola el encuadre de un tramo en el segundo t (relativo al tramo). */
export function cropAt(keys: CropKey[], t: number): { x: number; y: number; zoom: number } {
  if (!keys.length) return { x: 0.5, y: 0.5, zoom: 1 };
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t < b.t) {
      // La rampa puede durar menos que el plano: hasta su inicio se queda en el punto anterior
      const from = b.dur && (b.ease ?? "hold") !== "hold" ? Math.max(a.t, b.t - b.dur) : a.t;
      if (t < from) return a;
      const e = easeAt(b.ease ?? "hold", b.bezier, (t - from) / Math.max(b.t - from, 1e-6));
      if (e === null) return a;
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, zoom: a.zoom + (b.zoom - a.zoom) * e };
    }
  }
  return keys[keys.length - 1];
}

/** Rectángulo de recorte en píxeles del original para un formato de salida. */
export function cropRect(srcW: number, srcH: number, outW: number, outH: number, k: { x: number; y: number; zoom: number }) {
  const outAspect = outW / outH;
  let cw: number;
  let ch: number;
  if (srcW / srcH > outAspect) {
    ch = srcH;
    cw = srcH * outAspect;
  } else {
    cw = srcW;
    ch = srcW / outAspect;
  }
  const zoom = Math.max(1, k.zoom);
  cw /= zoom;
  ch /= zoom;
  const left = Math.min(Math.max(k.x * srcW - cw / 2, 0), srcW - cw);
  const top = Math.min(Math.max(k.y * srcH - ch / 2, 0), srcH - ch);
  return { left, top, width: cw, height: ch };
}
