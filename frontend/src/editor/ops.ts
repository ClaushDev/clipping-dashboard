/** Operaciones puras sobre una composición (no mutan: devuelven una copia). */
import {
  type AdjustOverlay, type AudioTrack, type BlockOverlay, type CaptionStyle, type Composition, compositionDuration, type CropKey, cropAt, type Fx, type FxDir, type FxKind, type ImageOverlay,
  keyedAt, type Overlay, type OverlayAnim, type OverlayKey, type OverlayLoop, type ProgressOverlay, type Segment, movingLength, segmentLength, segmentOffsets, segmentsDuration, segmentSourceLocal, type ShapeOverlay,
  sourceWordsOnTimeline, type TextOverlay, MARKER_COLORS, TRANSITION_FX, valueAt, type ValueKey, type VideoOverlay,
} from "../remotion/schema";
import { LOOKS } from "../remotion/grade";
import type { BlockItem, SoundEffect, Template } from "../types";

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Cambio de la composición: el valor nuevo o una función sobre la última (lo que termina tras una espera —seguir
 *  una cara, recortar con SAM, subir un archivo— usa la función, así no borra lo que editaste mientras tanto). */
export type CompUpdate = Composition | ((c: Composition) => Composition);
const clone = <T,>(v: T): T => structuredClone(v);

export function segmentAt(c: Composition, t: number): { index: number; local: number } | null {
  const offsets = segmentOffsets(c.segments);
  for (let i = 0; i < c.segments.length; i++) {
    const d = segmentLength(c.segments[i]);
    if (t >= offsets[i] && t < offsets[i] + d) return { index: i, local: t - offsets[i] };
  }
  return null;
}

/** Parte una lista de puntos clave en el instante local: la segunda mitad hereda el encuadre de ese instante. */
function splitKeys(keys: CropKey[], local: number): [CropKey[], CropKey[]] {
  const at = cropAt(keys, local);
  const a = keys.filter((k) => k.t < local);
  const b = [{ ...at, t: 0, ease: "hold" as const }, ...keys.filter((k) => k.t > local).map((k) => ({ ...k, t: k.t - local }))];
  return [a.length ? a : [{ ...at, t: 0, ease: "hold" }], b];
}

/** Marcador nuevo en t (o el que ya hay a menos de 0,05 s). Devuelve también su id. */
export function addMarker(c: Composition, t: number): { comp: Composition; id: string } {
  const near = (c.markers ?? []).find((m) => Math.abs(m.t - t) < 0.05);
  if (near) return { comp: c, id: near.id };
  const markers = c.markers ?? [];
  const m = { id: uid(), t: +t.toFixed(3), label: `Marcador ${markers.length + 1}`, color: MARKER_COLORS[markers.length % MARKER_COLORS.length] };
  return { comp: { ...c, markers: [...markers, m].sort((a, b) => a.t - b.t) }, id: m.id };
}

/** Claves de un valor vistas desde `delta` segundos más tarde (las anteriores se resumen en una clave en 0). */
export function shiftValueKeys(keys: ValueKey[] | undefined, delta: number): ValueKey[] | undefined {
  if (!keys?.length) return keys;
  const later = keys.filter((k) => k.t > delta).map((k) => ({ ...k, t: +(k.t - delta).toFixed(3) }));
  return keys.some((k) => k.t <= delta) ? [{ t: 0, v: valueAt(keys, delta, 0) }, ...later] : later;
}

/** La primera mitad de unas claves de un valor, cortada en `at` (acaba con el valor de ese instante). */
function headValueKeys(keys: ValueKey[] | undefined, at: number): ValueKey[] | undefined {
  if (!keys?.length) return keys;
  const before = keys.filter((k) => k.t < at);
  return [...before, ...(keys.some((k) => k.t >= at) ? [{ ...keys.find((k) => k.t >= at)!, t: +at.toFixed(3), v: valueAt(keys, at, 0) }] : [])];
}

/** Divide el tramo bajo el cursor en dos. El segundo hereda el encuadre (y el de cada panel) de ese instante,
 *  y el congelado del final si lo había. */
export function splitAt(c: Composition, t: number, min = 0.2): Composition {
  const hit = segmentAt(c, t);
  if (!hit || hit.local < min) return c;
  const seg = c.segments[hit.index];
  const local = segmentSourceLocal(seg, hit.local);
  if (seg.src_out - seg.src_in - local < min) return c;
  const cut = seg.src_in + local;
  const [ka, kb] = splitKeys(seg.keys, local);
  const panelsA = seg.panels?.map((p) => ({ ...p, keys: splitKeys(p.keys, local)[0] }));
  const panelsB = seg.panels?.map((p) => ({ ...p, keys: splitKeys(p.keys, local)[1] }));
  const a: Segment = { ...clone(seg), src_out: cut, keys: ka, freeze: 0, ...(panelsA ? { panels: panelsA } : {}),
    ...(seg.vol_keys ? { vol_keys: headValueKeys(seg.vol_keys, local) } : {}),
    ...(seg.speed_keys ? { speed_keys: headValueKeys(seg.speed_keys, local) } : {}) };
  const b: Segment = { ...clone(seg), id: uid(), src_in: cut, keys: kb, audio_offset: undefined, ...(panelsB ? { panels: panelsB } : {}),
    ...(seg.vol_keys ? { vol_keys: shiftValueKeys(seg.vol_keys, local) } : {}),
    ...(seg.speed_keys ? { speed_keys: shiftValueKeys(seg.speed_keys, local) } : {}) };
  const out = clone(c);
  out.segments.splice(hit.index, 1, a, b);
  return out;
}

/** Velocidad media del tramo (con rampa, la que resulta de toda ella): segundos del original por segundo de timeline. */
function rate(s: Segment): number {
  return (s.src_out - s.src_in) / Math.max(movingLength(s), 1e-6);
}

/** Rodillo: mueve el corte entre el tramo b-1 y el b `delta` segundos de timeline; uno crece lo que el otro
 *  encoge y lo de detrás no se mueve. `srcDur`: duración de cada archivo (Infinity si no se sabe). */
export function rollEdit(c: Composition, b: number, delta: number, srcDur: (src: string) => number): Composition {
  const A = c.segments[b - 1];
  const B = c.segments[b];
  if (!A || !B) return c;
  const ra = rate(A);
  const rb = rate(B);
  const lo = Math.max(-(movingLength(A) - 0.3), -B.src_in / rb);
  const hi = Math.min(movingLength(B) - 0.3, (srcDur(A.src) - A.src_out) / ra);
  const d = Math.min(hi, Math.max(lo, delta));
  if (!d || lo > hi) return c;
  const out = trimSegment(c, b - 1, "out", A.src_out + d * ra, srcDur(A.src));
  return trimSegment(out, b, "in", B.src_in + d * rb, srcDur(B.src));
}

/** Slip: el tramo se queda en su sitio y con su duración, pero enseña otra parte del original. Arrastrar a la
 *  derecha enseña lo de antes (como en Premiere). Los encuadres siguen en el mismo sitio del tramo. */
export function slipSegment(c: Composition, i: number, delta: number, srcDur: (src: string) => number): Composition {
  const s = c.segments[i];
  if (!s) return c;
  const d = Math.min(s.src_in, Math.max(-(srcDur(s.src) - s.src_out), delta * rate(s)));
  if (!d) return c;
  const out = clone(c);
  out.segments[i] = { ...out.segments[i], src_in: +(s.src_in - d).toFixed(3), src_out: +(s.src_out - d).toFixed(3) };
  return out;
}

/** Slide: el tramo conserva lo que enseña y se mueve entre sus vecinos: el anterior crece lo que el siguiente
 *  encoge. No vale con el primero ni el último. */
export function slideSegment(c: Composition, i: number, delta: number, srcDur: (src: string) => number): Composition {
  const P = c.segments[i - 1];
  const N = c.segments[i + 1];
  if (!P || !N) return c;
  const rp = rate(P);
  const rn = rate(N);
  const lo = Math.max(-(movingLength(P) - 0.3), -N.src_in / rn);
  const hi = Math.min(movingLength(N) - 0.3, (srcDur(P.src) - P.src_out) / rp);
  const d = Math.min(hi, Math.max(lo, delta));
  if (!d || lo > hi) return c;
  const out = trimSegment(c, i - 1, "out", P.src_out + d * rp, srcDur(P.src));
  return trimSegment(out, i + 1, "in", N.src_in + d * rn, srcDur(N.src));
}

export function removeSegment(c: Composition, index: number): Composition {
  if (c.segments.length <= 1) return c;
  const out = clone(c);
  out.segments.splice(index, 1);
  return out;
}

/** Recorta un extremo del tramo (en tiempo del vídeo original). Mover el inicio desplaza los puntos clave. */
export function trimSegment(c: Composition, index: number, edge: "in" | "out", value: number, sourceDuration: number): Composition {
  const out = clone(c);
  const seg = out.segments[index];
  if (edge === "in") {
    const v = Math.min(Math.max(0, value), seg.src_out - 0.3);
    const delta = v - seg.src_in;
    seg.src_in = +v.toFixed(3);
    const shift = (keys: CropKey[]) => keys.map((k) => ({ ...k, t: Math.max(0, +(k.t - delta).toFixed(3)) }));
    seg.keys = shift(seg.keys);
    if (seg.panels) seg.panels = seg.panels.map((p) => ({ ...p, keys: shift(p.keys) }));
    const shiftV = (keys: ValueKey[]) => (delta >= 0 ? shiftValueKeys(keys, delta) : keys.map((k) => ({ ...k, t: +(k.t - delta).toFixed(3) })));
    if (seg.vol_keys) seg.vol_keys = shiftV(seg.vol_keys);
    if (seg.speed_keys) seg.speed_keys = shiftV(seg.speed_keys);
  } else {
    seg.src_out = +Math.max(seg.src_in + 0.3, Math.min(value, sourceDuration)).toFixed(3);
  }
  return out;
}

export function updateSegment(c: Composition, index: number, patch: Partial<Segment>): Composition {
  const out = clone(c);
  out.segments[index] = { ...out.segments[index], ...patch };
  return out;
}

/** Inserta o actualiza el punto clave del instante t (relativo al tramo) en una lista de puntos. */
export function upsertKeyIn(source: CropKey[], t: number, patch: Partial<CropKey>): CropKey[] {
  const keys = [...source];
  const i = keys.findIndex((k) => Math.abs(k.t - t) < 0.15);
  const base = cropAt(source, t);
  // Un punto nuevo entra como "corte" (salto de plano), que es lo habitual al reencuadrar clips.
  const existing = i >= 0 ? keys[i] : null;
  const key: CropKey = { ...(existing ?? { ...base, t: +t.toFixed(3) }), ease: existing?.ease ?? "hold", ...patch };
  if (i >= 0) keys[i] = key;
  else keys.push(key);
  keys.sort((a, b) => a.t - b.t);
  if (keys[0].t > 0) keys.unshift({ ...keys[0], t: 0, ease: "hold" });
  return keys;
}

export function upsertKey(seg: Segment, t: number, patch: Partial<CropKey>): Segment {
  return { ...seg, keys: upsertKeyIn(seg.keys, t, patch) };
}

/** Paneles por defecto al pasar un tramo a pantalla dividida a mano: mitad izquierda arriba, derecha abajo. */
export function defaultPanels(): NonNullable<Segment["panels"]> {
  return [
    { y: 0, h: 0.5, label: "Panel superior", keys: [{ t: 0, x: 0.3, y: 0.5, zoom: 1.2, ease: "hold" }] },
    { y: 0.5, h: 0.5, label: "Panel inferior", keys: [{ t: 0, x: 0.7, y: 0.5, zoom: 1.2, ease: "hold" }] },
  ];
}

export function styleFromTemplate(t: Template): CaptionStyle {
  const { id: _id, name: _name, ...rest } = t;
  return rest as CaptionStyle;
}

export function captionWordsTimeline(c: Composition) {
  if (c.captions.time_base !== "timeline") return sourceWordsOnTimeline(c);
  return c.captions.words.map((w, idx) => ({ idx, ...w })).sort((a, b) => a.s - b.s);
}

export function newText(at: number, duration: number): TextOverlay {
  return {
    id: uid(), kind: "text", text: "Nuevo texto", start: +at.toFixed(2), end: +Math.min(at + 3, duration).toFixed(2),
    x: 0.5, y: 0.2, w: 0.8, anim: "pop", size: 80, color: "#FFFFFF", bg: "", font: "Montserrat", weight: 900,
  };
}

/** Capa de ajuste de color en el cursor, hasta el final del vídeo o 5 s. */
export function newAdjust(at: number, duration: number): AdjustOverlay {
  return { id: uid(), kind: "adjust", start: at, end: Math.min(duration, at + 5), x: 0.5, y: 0.5, w: 1, anim: "fade", grade: { look: "teal_orange", amount: 0.8 } };
}

export function newImage(src: string, at: number, duration: number): ImageOverlay {
  return {
    id: uid(), kind: "image", src, start: +at.toFixed(2), end: +Math.min(at + 3, duration).toFixed(2),
    x: 0.5, y: 0.3, w: 0.4, anim: "pop", opacity: 1,
  };
}

/** Clip en una pista de vídeo superior: imagen en imagen en la esquina, encima de la pista más alta. */
export function newVideo(src: string, size: [number, number], at: number, duration: number, c: Composition): VideoOverlay {
  const top = Math.max(1, ...c.overlays.map((o) => (o.kind === "video" ? o.track : 1)));
  return {
    id: uid(), kind: "video", src, src_in: 0, src_w: size[0] || 1920, src_h: size[1] || 1080, start: +at.toFixed(2),
    end: +Math.min(at + 4, duration).toFixed(2), x: 0.5, y: 0.3, w: 0.8, anim: "pop", volume: 0, opacity: 1,
    track: top + 1, radius: 28, border: "#ffffff",
  };
}

/** Escribe valores en el fotograma clave del segundo t (relativo a la capa); si no hay uno ahí, lo crea con el estado
 *  que tiene la capa en ese momento. */
export function setKeyAt(o: Overlay, t: number, patch: Partial<OverlayKey>, fps = 30): Overlay {
  const keys = o.keys ?? [];
  const at = +Math.max(0, Math.min(o.end - o.start, t)).toFixed(3);
  const i = keys.findIndex((k) => Math.abs(k.t - at) < 0.5 / fps);
  const next = i >= 0
    ? keys.map((k, j) => (j === i ? { ...k, ...patch } : k))
    : [...keys, { ...keyedAt(o, at), ease: "ease" as const, ...patch, t: at }].sort((a, b) => a.t - b.t);
  return { ...o, keys: next } as Overlay;
}

/** Arrastrar la capa en la vista previa: con fotogramas clave mueve el del cursor; sin ellos, la capa. */
export function moveOverlay(o: Overlay, playhead: number, x: number, y: number): Overlay {
  return o.keys?.length ? setKeyAt(o, playhead - o.start, { x, y }) : ({ ...o, x, y } as Overlay);
}

/** Nuevo inicio de una capa sin que se muevan sus claves, su recorrido ni (en vídeo) el fotograma que se ve. */
export function retime<T extends { start: number }>(o: T, start: number): T {
  const dt = start - o.start;
  const ov = o as unknown as Overlay;
  const shift = <P extends { t: number }>(list?: P[]) => list?.map((p) => ({ ...p, t: +(p.t - dt).toFixed(3) }));
  return {
    ...o, start, keys: shift(ov.keys), follow: shift(ov.follow),
    ...(ov.kind === "shape" && ov.path ? { path: shift(ov.path) } : {}),
    ...(ov.kind === "video" ? { src_in: +Math.max(0, ov.src_in + dt).toFixed(3) } : {}),
  };
}

export function newAudio(src: string): AudioTrack {
  return { id: uid(), src, start: 0, src_in: 0, duration: 0, volume: 0.15, fade_in: 0.5, fade_out: 1, kind: "music", duck: 0.35 };
}

/** Efecto de sonido de la librería en el cursor; dura lo que el sonido (0 = sin saberlo, hasta el final). */
export function newSfx(src: string, label: string, at: number, length = 0): AudioTrack {
  return { id: uid(), src, start: +at.toFixed(2), src_in: 0, duration: length > 0 ? +length.toFixed(2) : 0, volume: 0.8, fade_in: 0, fade_out: 0, kind: "sfx", label };
}

const CUTOUT_NAME = { behind: "Sujeto delante", screen: "Fondo nuevo", paper: "Papel", escape: "Sale del marco",
  portal: "Portal", orbit: "Órbita 2,5D" } as const;

export const SHAPE_LABEL: Record<ShapeOverlay["shape"], string> = {
  circle: "Círculo", box: "Recuadro", arrow: "Flecha", underline: "Subrayado",
};

export function newShape(shape: ShapeOverlay["shape"], at: number, duration: number): ShapeOverlay {
  const size = shape === "arrow" ? { w: 0.25, h: 0, rotation: 45 } : shape === "underline" ? { w: 0.5, h: 0, rotation: 0 }
    : { w: 0.4, h: 0.16, rotation: 0 };
  return {
    id: uid(), kind: "shape", shape, start: +at.toFixed(2), end: +Math.min(at + 2, duration).toFixed(2),
    x: 0.5, y: 0.45, anim: "draw", color: "#FF2D2D", stroke: 12, ...size,
  };
}

export function newProgress(at: number, duration: number): ProgressOverlay {
  return {
    id: uid(), kind: "progress", text: "WAIT FOR IT...", start: +at.toFixed(2), end: +Math.min(at + 2.5, duration).toFixed(2),
    x: 0.5, y: 0.22, w: 0.7, anim: "pop", color: "#FFD400",
  };
}

export const FX_LABEL: Record<FxKind, string> = {
  punch: "Punch-in", zoom: "Zoom lento", pan: "Paneo", drift: "Cámara en mano", shake: "Temblor",
  whip: "Barrido (whip)", slide: "Empuje", zoom_cut: "Zoom de transición", zoom_through: "Zoom Through Cut", flash: "Destello",
  glitch: "Glitch", blur: "Desenfoque", blur_zoom: "Desenfoque + zoom", leak: "Fuga de luz",
  bw: "Blanco y negro",
};

/** Efectos agrupados para los menús. Las transiciones se centran en el corte más cercano. */
export const FX_GROUPS: [string, FxKind[]][] = [
  ["Cámara", ["punch", "zoom", "pan", "drift", "shake"]],
  ["Transiciones", ["whip", "slide", "zoom_cut", "zoom_through", "blur", "blur_zoom", "flash", "leak", "glitch"]],
  ["Color", ["bw"]],
];

const FX_DEFAULTS: Record<FxKind, { len: number; amount: number; dir?: FxDir }> = {
  punch: { len: 1.2, amount: 0.25 }, zoom: { len: 3, amount: 0.2 }, pan: { len: 3, amount: 0.15, dir: "right" },
  drift: { len: 4, amount: 0.5 }, shake: { len: 0.5, amount: 0.6 },
  whip: { len: 0.4, amount: 1, dir: "left" }, slide: { len: 0.5, amount: 1, dir: "left" }, zoom_cut: { len: 0.5, amount: 1 },
  zoom_through: { len: 0.7, amount: 1 },
  flash: { len: 0.3, amount: 0.9 }, glitch: { len: 0.4, amount: 0.6 }, bw: { len: 2, amount: 1 },
  blur: { len: 0.6, amount: 1 }, blur_zoom: { len: 0.6, amount: 1 }, leak: { len: 0.9, amount: 0.9 },
};

/** Whoosh de la biblioteca para una transición. Se elige el de duración más parecida (entre los de transición
 *  que se llaman whoosh, swoosh o swish; si no hay, cualquiera de transición), se centra en el corte y se recorta con
 *  un fundido si es más largo que la transición. */
export function whooshFor(f: Fx, sounds: SoundEffect[]): AudioTrack | null {
  const isWhoosh = (s: SoundEffect) => /wh?oo?sh|swish|swoosh|woosh|zas/i.test(s.name);
  const trans = sounds.filter((s) => s.intents?.includes("transicion") || /transici/i.test(s.category));
  const pool = trans.filter(isWhoosh).length ? trans.filter(isWhoosh) : sounds.filter(isWhoosh).length ? sounds.filter(isWhoosh) : trans;
  if (!pool.length) return null;
  const len = f.end - f.start;
  const want = len + 0.25;
  const best = pool.reduce((a, b) => (Math.abs((b.duration || 1) - want) < Math.abs((a.duration || 1) - want) ? b : a));
  const dur = Math.min(best.duration || want, want + 0.3);
  const cut = f.kind === "flash" || f.kind === "glitch" ? f.start : (f.start + f.end) / 2;
  const a = newSfx(best.url, `${best.name} · ${FX_LABEL[f.kind]}`, Math.max(0, cut - dur / 2), dur);
  return { ...a, volume: 0.6, fade_in: 0.05, fade_out: best.duration && best.duration > dur + 0.02 ? Math.min(0.2, dur / 3) : 0 };
}

/** Añade la transición y, si toca, su whoosh enlazado. */
export function addFxWithWhoosh(c: Composition, f: Fx, sounds: SoundEffect[]): Composition {
  const a = TRANSITION_FX.includes(f.kind) && c.auto_whoosh !== false ? whooshFor(f, sounds) : null;
  return { ...c, fx: [...(c.fx ?? []), a ? { ...f, whoosh: a.id } : f], audio: a ? [...c.audio, a] : c.audio };
}

/** Cambia una transición y arrastra su whoosh: se mueve con ella (sin cambiar de sonido) y se borra si deja de serlo. */
export function patchFx(c: Composition, id: string, patch: Partial<Fx>): Composition {
  const old = (c.fx ?? []).find((f) => f.id === id);
  if (!old) return c;
  let f: Fx = { ...old, ...patch };
  let audio = c.audio;
  if (old.whoosh) {
    if (!TRANSITION_FX.includes(f.kind)) {
      audio = audio.filter((a) => a.id !== old.whoosh);
      f = { ...f, whoosh: undefined };
    } else {
      const cutOf = (x: Fx) => (x.kind === "flash" || x.kind === "glitch" ? x.start : (x.start + x.end) / 2);
      const d = cutOf(f) - cutOf(old);
      if (Math.abs(d) > 1e-4) audio = audio.map((a) => (a.id === old.whoosh ? { ...a, start: +Math.max(0, a.start + d).toFixed(3) } : a));
    }
  }
  return { ...c, fx: (c.fx ?? []).map((x) => (x.id === id ? f : x)), audio };
}

/** Quita efectos y, con ellos, sus whoosh enlazados. */
export function removeFx(c: Composition, ids: string[]): Composition {
  const gone = new Set((c.fx ?? []).filter((f) => ids.includes(f.id) && f.whoosh).map((f) => f.whoosh as string));
  return { ...c, fx: (c.fx ?? []).filter((f) => !ids.includes(f.id)), audio: gone.size ? c.audio.filter((a) => !gone.has(a.id)) : c.audio };
}

export function newFx(kind: FxKind, at: number, duration: number): Fx {
  const d = FX_DEFAULTS[kind];
  const start = TRANSITION_FX.includes(kind) && kind !== "flash" && kind !== "glitch" ? Math.max(0, at - d.len / 2) : at;
  return {
    id: uid(), kind, start: +start.toFixed(2), end: +Math.min(start + d.len, duration).toFixed(2), x: 0.5, y: 0.5,
    amount: d.amount, ...(d.dir ? { dir: d.dir } : {}),
  };
}

/** Corte (cambio de escena o de tramo) más cercano a `t`, si hay uno a menos de `within` segundos. */
export function nearestCut(c: Composition, t: number, within = 1.2): number | null {
  const cuts = [...c.scenes.map((s) => s.start), ...segmentOffsets(c.segments)].filter((x) => x > 0.05);
  let best: number | null = null;
  for (const x of cuts) if (Math.abs(x - t) <= within && (best === null || Math.abs(x - t) < Math.abs(best - t))) best = x;
  return best;
}

export const ANIM_LABEL: Record<Exclude<OverlayAnim, "draw">, string> = {
  pop: "Pop", bounce: "Rebote (cae)", drop: "Golpe (entra grande)", zoom: "Zoom", spin: "Giro",
  slide: "Sube", slide_left: "Desde la derecha", slide_right: "Desde la izquierda", fade: "Fundido",
  count: "Números que cuentan", type: "Máquina de escribir", none: "Ninguna",
};

export const LOOP_LABEL: Record<OverlayLoop, string> = {
  none: "Quieta", float: "Flota", pulse: "Late", wiggle: "Se balancea", spin: "Gira",
};

export const STICKERS = ["🔥", "😱", "🤯", "💰", "💀", "🚀", "⚠️", "❓", "✅", "❌", "👀", "😂", "🏆", "💡", "⚽", "📈", "📉", "❤️"];

/** Emoji como sticker: entra con pop y se queda flotando. */
export function newSticker(emoji: string, at: number, duration: number): TextOverlay {
  return {
    id: uid(), kind: "text", text: emoji, start: +at.toFixed(2), end: +Math.min(at + 2.5, duration).toFixed(2),
    x: 0.78, y: 0.3, w: 0.3, anim: "pop", loop: "float", rot: 8, size: 170, color: "#FFFFFF", bg: "", font: "Montserrat",
    weight: 400,
  };
}

export function overlayLabel(o: Composition["overlays"][number]): string {
  if (o.kind === "text") return o.text;
  if (o.kind === "image") return "Imagen";
  if (o.kind === "progress") return `Barra · ${o.text}`;
  if (o.kind === "block") return o.title;
  if (o.kind === "graphic") return String(o.props.title ?? o.props.headline ?? o.props.name ?? o.component);
  if (o.kind === "cutout") return CUTOUT_NAME[o.mode];
  if (o.kind === "video") return `V${o.track} · ${decodeURIComponent(o.src.split("/").pop() ?? "Vídeo")}`;
  if (o.kind === "adjust") return `Ajuste · ${o.grade.look === "lut" ? o.grade.lut?.name ?? "LUT" : LOOKS[o.grade.look ?? ""]?.label ?? "color"}${o.mask ? " · máscara" : ""}`;
  return SHAPE_LABEL[o.shape];
}

/** Desplaza todo lo que empieza a partir de `at` (capas, efectos, sonidos y subtítulos con tiempos finales):
 *  al recortar o borrar un tramo, lo que venía detrás sigue pegado a su imagen. */
export function shiftAfter(c: Composition, at: number, delta: number): Composition {
  if (Math.abs(delta) < 1e-4) return c;
  const out = clone(c);
  const after = (t: number) => t >= at - 1e-3;
  const mv = (t: number) => +Math.max(0, t + delta).toFixed(3);
  out.overlays = out.overlays.map((o) => (after(o.start) ? { ...o, start: mv(o.start), end: mv(o.end) } : o));
  out.fx = (out.fx ?? []).map((f) => (after(f.start) ? { ...f, start: mv(f.start), end: mv(f.end) } : f));
  out.audio = out.audio.map((a) => (a.kind === "sfx" && after(a.start) ? { ...a, start: mv(a.start) } : a));
  if (out.captions.time_base === "timeline") {
    out.captions.words = out.captions.words.map((w) => (after(w.s) ? { ...w, s: mv(w.s), e: mv(w.e) } : w));
  }
  return out;
}

/** Borra un tramo y junta el resto (ripple): lo que estaba encima del tramo se va con él y lo de detrás se adelanta. */
export function rippleRemoveSegment(c: Composition, index: number): Composition {
  if (c.segments.length <= 1) return c;
  const t0 = segmentOffsets(c.segments)[index];
  const len = segmentLength(c.segments[index]);
  const inside = (s: number, e: number) => s >= t0 - 1e-3 && e <= t0 + len + 1e-3;
  const out = removeSegment(c, index);
  out.overlays = out.overlays.filter((o) => !inside(o.start, o.end));
  out.fx = (out.fx ?? []).filter((f) => !inside(f.start, f.end));
  out.audio = out.audio.filter((a) => !(a.kind === "sfx" && a.start >= t0 && a.start < t0 + len));
  if (out.captions.time_base === "timeline") out.captions.words = out.captions.words.filter((w) => !inside(w.s, w.e));
  return shiftAfter(out, t0 + len, -len);
}

/** Quita el trozo [a, b) de la timeline (editar borrando palabras): parte los tramos en los bordes, borra lo de
 *  dentro y junta el resto; lo que estaba encima del trozo se va y lo de detrás se adelanta. */
export function cutRange(c: Composition, a: number, b: number): Composition {
  if (b - a < 0.02) return c;
  const split = splitAt(splitAt(c, b, 0.02), a, 0.02);
  const offsets = segmentOffsets(split.segments);
  const gone = (i: number) => offsets[i] >= a - 0.01 && offsets[i] + segmentLength(split.segments[i]) <= b + 0.01;
  const segments = split.segments.filter((_, i) => !gone(i));
  if (!segments.length || segments.length === split.segments.length) return c;
  const removed = segmentsDuration(split.segments) - segmentsDuration(segments);
  const inside = (s: number, e: number) => s >= a - 1e-3 && e <= a + removed + 1e-3;
  const out: Composition = {
    ...split, segments,
    overlays: split.overlays.filter((o) => !inside(o.start, o.end)),
    fx: (split.fx ?? []).filter((f) => !inside(f.start, f.end)),
    audio: split.audio.filter((x) => !(x.kind === "sfx" && x.start >= a && x.start < a + removed)),
  };
  return shiftAfter(out, a + removed, -removed);
}

/** Trozos de timeline que se quitan al borrar estas palabras (posiciones en `sourceWordsOnTimeline`): cada racha de
 *  palabras seguidas va desde justo antes de la primera hasta 0,1 s antes de la siguiente que se queda (así se va
 *  también la pausa de detrás), sin salirse de su tramo. */
export function wordCutRanges(c: Composition, picked: number[]): [number, number][] {
  const words = sourceWordsOnTimeline(c);
  const offsets = segmentOffsets(c.segments);
  const segOf = (t: number) => {
    const i = offsets.findIndex((o, k) => t >= o - 1e-3 && t < o + segmentLength(c.segments[k]));
    return i < 0 ? [0, Infinity] : [offsets[i], offsets[i] + segmentLength(c.segments[i])];
  };
  const sel = [...new Set(picked)].filter((i) => i >= 0 && i < words.length).sort((x, y) => x - y);
  const ranges: [number, number][] = [];
  for (let k = 0; k < sel.length;) {
    let j = k;
    while (j + 1 < sel.length && sel[j + 1] === sel[j] + 1) j++;
    const first = words[sel[k]];
    const last = words[sel[j]];
    const prev = words[sel[k] - 1];
    const next = words[sel[j] + 1];
    const [s0] = segOf(first.s);
    const [, e1] = segOf(last.s);
    const a = Math.max(s0, prev ? Math.max(prev.e, first.s - 0.05) : first.s - 0.05);
    const b = Math.min(e1, next ? Math.max(last.e, next.s - Math.min(0.1, next.s - last.e)) : last.e + 0.15);
    if (b > a) ranges.push([+a.toFixed(3), +b.toFixed(3)]);
    k = j + 1;
  }
  return ranges;
}

/** Borra esas palabras del vídeo (de atrás hacia delante, así los tiempos de las anteriores no cambian). */
export function cutWords(c: Composition, picked: number[]): Composition {
  return wordCutRanges(c, picked).reverse().reduce((acc, [a, b]) => cutRange(acc, a, b), c);
}

/** Pausas más largas que `min` s entre palabras: se dejan en `keep` s. */
export function longPauses(c: Composition, min: number, keep = 0.25): [number, number][] {
  const words = sourceWordsOnTimeline(c);
  const out: [number, number][] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].s - words[i - 1].e;
    if (gap > min) out.push([+(words[i - 1].e + keep / 2).toFixed(3), +(words[i].s - keep / 2).toFixed(3)]);
  }
  return out;
}

export function cutPauses(c: Composition, min: number): Composition {
  return longPauses(c, min).reverse().reduce((acc, [a, b]) => cutRange(acc, a, b), c);
}

/** Muletillas y titubeos (en, es) que se pueden seleccionar de golpe para revisarlos y borrarlos. */
export const FILLERS = new Set(["eh", "ehh", "em", "emm", "mm", "mmm", "um", "umm", "uh", "uhh", "ah", "ahh", "er", "erm", "hmm"]);
export const isFiller = (w: string) => FILLERS.has(w.toLowerCase().replace(/[^\p{L} ]/gu, "").trim());

/** Cambia un tramo de sitio. Los subtítulos con tiempos del original le siguen solos; los de tiempos finales se
 *  recolocan aquí con su tramo. Las capas, efectos y sonidos que caen enteros dentro de un tramo se mueven con él
 *  (antes se quedaban en su segundo y acababan encima de otra imagen); los que cruzan un corte se quedan donde están. */
export function moveSegment(c: Composition, from: number, to: number): Composition {
  if (from === to || to < 0 || to >= c.segments.length) return c;
  const out = clone(c);
  const [seg] = out.segments.splice(from, 1);
  out.segments.splice(to, 0, seg);
  const before = segmentOffsets(c.segments);
  const after = segmentOffsets(out.segments);
  const pos = new Map(out.segments.map((s, i) => [s.id, i]));
  /** Desplazamiento del tramo que contiene entero [s, e] (0 si cruza un corte o no hay tramo). */
  const shiftOf = (s: number, e: number) => {
    const k = c.segments.findIndex((sg, i) => s >= before[i] - 1e-3 && e <= before[i] + segmentLength(sg) + 1e-3);
    return k < 0 ? 0 : after[pos.get(c.segments[k].id)!] - before[k];
  };
  const mv = <T extends { start: number; end: number }>(o: T): T => {
    const d = shiftOf(o.start, o.end);
    return d ? { ...o, start: +(o.start + d).toFixed(3), end: +(o.end + d).toFixed(3) } : o;
  };
  out.overlays = out.overlays.map(mv);
  out.fx = (out.fx ?? []).map(mv);
  out.audio = out.audio.map((a) => {
    if (a.kind !== "sfx") return a;
    const d = shiftOf(a.start, a.start + 0.01);
    return d ? { ...a, start: +(a.start + d).toFixed(3) } : a;
  });
  if (out.captions.time_base === "timeline") {
    out.captions.words = out.captions.words.map((w) => {
      const k = c.segments.findIndex((s, i) => w.s >= before[i] - 1e-3 && w.s < before[i] + segmentLength(s) - 1e-3);
      if (k < 0) return w;
      const d = after[pos.get(c.segments[k].id)!] - before[k];
      return { ...w, s: +(w.s + d).toFixed(3), e: +(w.e + d).toFixed(3) };
    }).sort((a, b) => a.s - b.s);
  }
  return out;
}

/** Duplica un tramo justo detrás de sí mismo y empuja el resto. Con subtítulos de tiempos finales, la copia se lleva
 *  también sus palabras (con tiempos del original salen solas en las dos copias). */
export function duplicateSegment(c: Composition, index: number): Composition {
  const start = segmentOffsets(c.segments)[index];
  const len = segmentLength(c.segments[index]);
  const shifted = shiftAfter(c, start + len, len);
  const out = clone(shifted);
  out.segments.splice(index + 1, 0, { ...clone(c.segments[index]), id: uid() });
  if (out.captions.time_base === "timeline") {
    const copy = c.captions.words.filter((w) => w.s >= start - 1e-3 && w.s < start + len - 1e-3)
      .map((w) => ({ ...w, s: +(w.s + len).toFixed(3), e: +(w.e + len).toFixed(3) }));
    out.captions.words = [...out.captions.words, ...copy].sort((a, b) => a.s - b.s);
  }
  return out;
}

export type ItemKind = "overlay" | "fx" | "audio";

/** Corta una capa o un efecto en dos en el instante t. */
export function splitItem(c: Composition, kind: "overlay" | "fx", id: string, t: number): Composition {
  const cut = <T extends { id: string; start: number; end: number }>(list: T[]): T[] =>
    list.flatMap((o) => (o.id === id && t > o.start + 0.1 && t < o.end - 0.1
      ? [{ ...o, end: +t.toFixed(3) }, { ...retime(clone(o), +t.toFixed(3)), id: uid() }] : [o]));
  return kind === "overlay" ? { ...c, overlays: cut(c.overlays) } : { ...c, fx: cut(c.fx ?? []) };
}

export function duplicateItem(c: Composition, kind: ItemKind, id: string): { comp: Composition; id: string } {
  const nid = uid();
  const total = compositionDuration(c);
  if (kind === "audio") {
    const a = c.audio.find((x) => x.id === id);
    return a ? { comp: { ...c, audio: [...c.audio, { ...clone(a), id: nid, start: +(a.start + 0.5).toFixed(2) }] }, id: nid } : { comp: c, id };
  }
  const list: { id: string; start: number; end: number }[] = kind === "overlay" ? c.overlays : c.fx ?? [];
  const o = list.find((x) => x.id === id);
  if (!o) return { comp: c, id };
  const len = o.end - o.start;
  const start = Math.min(o.end, Math.max(0, total - len));
  const copy = { ...clone(o), id: nid, start: +start.toFixed(2), end: +(start + len).toFixed(2) };
  return kind === "overlay"
    ? { comp: { ...c, overlays: [...c.overlays, copy as Composition["overlays"][number]] }, id: nid }
    : { comp: { ...c, fx: [...(c.fx ?? []), copy as Fx] }, id: nid };
}

/** Puntos de edición (inicios y finales de tramos, escenas y capas) para saltar entre ellos y para el imán. */
export function editPoints(c: Composition): number[] {
  const offsets = segmentOffsets(c.segments);
  const pts = [0, compositionDuration(c), ...offsets, ...c.segments.map((s, i) => offsets[i] + segmentLength(s)),
    ...c.scenes.map((s) => s.start), ...(c.markers ?? []).map((m) => m.t)];
  return [...new Set(pts.map((t) => +t.toFixed(3)))].sort((a, b) => a - b);
}

// ---------- Planos (cortes de cámara) ----------
// Cada punto clave de encuadre abre un plano. panel = -1 son los del tramo; 0, 1… los de cada panel en pantalla dividida.

export function keysOf(seg: Segment, panel: number): CropKey[] {
  return panel >= 0 && seg.panels?.[panel] ? seg.panels[panel].keys : seg.keys;
}

export function withKeys(c: Composition, index: number, panel: number, keys: CropKey[]): Composition {
  const out = clone(c);
  const seg = out.segments[index];
  if (panel >= 0 && seg.panels?.[panel]) seg.panels[panel].keys = keys;
  else seg.keys = keys;
  return out;
}

/** Corte nuevo en el instante local (segundos del original desde el inicio del tramo): mismo encuadre que ahí, para
 *  luego cambiarlo. Devuelve también la posición del plano nuevo. */
export function addCut(c: Composition, index: number, panel: number, local: number): { comp: Composition; key: number } {
  const seg = c.segments[index];
  const keys = keysOf(seg, panel);
  const srcLen = seg.src_out - seg.src_in;
  if (local < 0.1 || local > srcLen - 0.1 || keys.some((k) => Math.abs(k.t - local) < 0.1)) {
    return { comp: c, key: Math.max(0, keys.findIndex((k) => Math.abs(k.t - local) < 0.1)) };
  }
  const next = upsertKeyIn(keys, local, { ease: "hold" });
  return { comp: withKeys(c, index, panel, next), key: next.findIndex((k) => Math.abs(k.t - local) < 1e-3) };
}

/** Quita el corte que abre el plano `key` (se une con el anterior). El primero no se puede quitar. */
export function removeCut(c: Composition, index: number, panel: number, key: number): Composition {
  const keys = keysOf(c.segments[index], panel);
  if (key <= 0 || key >= keys.length) return c;
  return withKeys(c, index, panel, keys.filter((_, i) => i !== key));
}

/** Mueve un corte a otro instante, sin pasar de los cortes vecinos. */
export function moveCut(c: Composition, index: number, panel: number, key: number, local: number): Composition {
  const seg = c.segments[index];
  const keys = keysOf(seg, panel);
  if (key <= 0 || key >= keys.length) return c;
  const lo = keys[key - 1].t + 0.1;
  const hi = (keys[key + 1]?.t ?? seg.src_out - seg.src_in) - 0.1;
  const t = +Math.min(hi, Math.max(lo, local)).toFixed(3);
  return withKeys(c, index, panel, keys.map((k, i) => (i === key ? { ...k, t } : k)));
}

export function setCutEase(c: Composition, index: number, panel: number, key: number, ease: "hold" | "smooth"): Composition {
  const keys = keysOf(c.segments[index], panel);
  if (key <= 0 || key >= keys.length) return c;
  return withKeys(c, index, panel, keys.map((k, i) => (i === key ? { ...k, ease, bezier: undefined } : k)));
}

/** Capa con un bloque de HyperFrames en el cursor. Un bloque de pantalla completa entra entero en el lienzo con su
 *  proporción; un componente (rótulo, contador, título…) ocupa una franja centrada que llena. */
export function newBlock(b: BlockItem, at: number, duration: number, canvas: [number, number]): BlockOverlay {
  const [cw, ch] = canvas;
  const len = Math.min(b.duration || 4, Math.max(0.5, duration - at));
  let w = 0.9;
  let h = 0.3;
  if (b.width && b.height) {
    w = 1;
    h = Math.min(1, (cw / ch) * (b.height / b.width));
    if (h === 1) w = Math.min(1, (ch / cw) * (b.width / b.height));
  }
  return {
    id: uid(), kind: "block", block: b.name, title: b.title, src: `/api/blocks/${b.name}/doc`,
    start: +at.toFixed(2), end: +(at + len).toFixed(2), x: 0.5, y: 0.5, w: +w.toFixed(4), h: +h.toFixed(4), anim: "none",
    base_w: b.width, base_h: b.height,
    vars: Object.fromEntries(b.variables.map((v) => [v.id, v.default])),
    texts: {}, colors: {}, images: {}, transparent: false,
  };
}
