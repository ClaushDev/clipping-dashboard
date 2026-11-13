import {
  ArrowsInLineVertical, ArrowsOutLineHorizontal, ArrowsOutLineVertical, CaretDown, CaretRight, Cursor, MagnetStraight, MagnifyingGlassMinus, MagnifyingGlassPlus, Pause, Play,
  Scissors, SkipBack, SkipForward, Trash,
} from "@phosphor-icons/react";
import React, { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ShortcutAction } from "./shortcuts";
import CurveLane from "./CurveLane";
import { audioOffset, easeAt, type Composition, type FxKind, type Overlay, segmentLength, segmentOffsets, SOURCE_CUT_LABEL, sourceCutsLocal, MARKER_COLORS, valueAt, type ValueKey, segmentLocalOf, segmentSourceLocal } from "../remotion/schema";
import { fmtTime as tc } from "../hooks";
import type { Filmstrip } from "../types";
import FxMenu from "./FxMenu";
import { captionWordsTimeline, editPoints, FX_LABEL, keysOf, overlayLabel, withKeys } from "./ops";

export type Selection =
  | { kind: "segment"; index: number }
  | { kind: "word"; index: number; end?: number } // End: último índice de un rango (Mayús+clic)
  | { kind: "overlay"; id: string }
  | { kind: "audio"; id: string }
  | { kind: "fx"; id: string }
  /** Gancho en pantalla: una capa más, con sus propiedades en Texto. */
  | { kind: "hook" }
  /** Plano de cámara: el que abre el punto clave `key` del tramo `index` (panel -1 = sin pantalla dividida). */
  | { kind: "shot"; index: number; panel: number; key: number }
  /** Marcador de la timeline. */
  | { kind: "marker"; id: string }
  | null;

/** Rolling = mover el corte entre dos tramos · slip = otra parte del original · slide = mover el tramo entre sus vecinos. */
export type Tool = "select" | "blade" | "rolling" | "slip" | "slide";

export type TimelineAction =
  | { type: "split"; t: number; target: Selection }
  | { type: "delete"; target: Selection }
  | { type: "duplicate"; target: Selection }
  | { type: "fx"; t: number; kind: FxKind }
  | { type: "cut"; index: number; panel: number; local: number }
  | { type: "uncut"; index: number; panel: number; key: number }
  | { type: "ease"; index: number; panel: number; key: number; ease: "hold" | "smooth" }
  /** Copiar y pegar atributos de tramos y capas. */
  | { type: "copy_attrs"; target: Selection }
  | { type: "paste_attrs"; target: Selection };

export interface TimelineHandle {
  zoomBy: (factor: number) => void;
  fit: () => void;
}

interface Props {
  comp: Composition;
  duration: number;
  playhead: number;
  playing: boolean;
  pxPerSec: number;
  onZoom: (px: number) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onSeek: (t: number) => void;
  tool: Tool;
  onTool: (t: Tool) => void;
  snap: boolean;
  onSnap: (v: boolean) => void;
  onTogglePlay: () => void;
  onJump: (dir: -1 | 1) => void;
  filmstrip: Filmstrip | null;
  peaks: { step: number; peaks: number[] } | null;
  /** Arrastre de un borde de tramo: delta en segundos de la línea de tiempo desde que empezó. */
  onTrim: (index: number, edge: "in" | "out", delta: number, done: boolean) => void;
  /** Rodillo (index = tramo de la derecha del corte), slip y slide; delta en segundos de timeline. */
  onEdit?: (kind: "roll" | "slip" | "slide", index: number, delta: number, done: boolean) => void;
  /** Texto del atajo de una acción (los atajos se pueden cambiar). */
  keyHint?: (a: ShortcutAction) => string;
  /** `span`: inicio y fin del elemento al empezar a arrastrar (los sonidos sin duración fija la sacan de aquí). */
  onMoveItem: (kind: "overlay" | "audio" | "fx", id: string, part: "move" | "start" | "end", delta: number, done: boolean, span?: [number, number]) => void;
  onReorder: (from: number, to: number) => void;
  /** Arrastre de un corte de cámara a otro instante (segundos del original desde el inicio del tramo). */
  onMoveCut: (index: number, panel: number, key: number, local: number, done: boolean) => void;
  onAction: (a: TimelineAction) => void;
  handleRef?: React.Ref<TimelineHandle>;
  /** Cambio directo de la composición desde un carril ampliado (curvas, rampas, multicámara). merge = mismo arrastre. */
  onCompose?: (fn: (c: Composition) => Composition, merge: boolean) => void;
}

const LABEL_W = 112;
const MIN_PX = 2;
const MAX_PX = 600;
const SNAP_PX = 8;
const FILM_H = 46;
/** Alto normal de cada tipo de pista y lo que crece al ampliarla (solo las que tienen algo que editar dentro). */
const BASE_H: Record<string, number> = { video: 72, cam: 30, audio: 30, fx: 30, overlay: 30, words: 26, angle: 30 };
const TALL_EXTRA: Record<string, number> = { video: 64, cam: 44, audio: 56 };
const MAX_ROW_H = 320;
function loadHeights(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem("fs-tl-h") || "{}");
  } catch {
    return {};
  }
}

const TRACK_LABEL: Record<Composition["overlays"][number]["kind"], string> = {
  text: "Texto", image: "Imagen", shape: "Señal", progress: "Espera", block: "Bloque", graphic: "Plantilla", cutout: "Recorte", video: "Vídeo", adjust: "Ajuste",
};

/** Reparte elementos en carriles sin solaparse (como hace cualquier editor con varias capas a la vez). */
function pack<T extends { start: number; end: number }>(items: T[]): T[][] {
  const lanes: { end: number; items: T[] }[] = [];
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    const lane = lanes.find((l) => l.end <= it.start + 1e-3);
    if (lane) {
      lane.items.push(it);
      lane.end = it.end;
    } else lanes.push({ end: it.end, items: [it] });
  }
  return lanes.map((l) => l.items);
}

// Duración real de cada sonido (los efectos de sonido se guardan con duración 0 = el archivo entero).
const audioLengths = new Map<string, number>();
function useAudioLengths(srcs: string[]): number {
  const [version, setVersion] = useState(0);
  const key = srcs.join("|");
  useEffect(() => {
    for (const src of srcs) {
      if (audioLengths.has(src)) continue;
      audioLengths.set(src, 0);
      const a = new Audio();
      a.preload = "metadata";
      a.onloadedmetadata = () => {
        audioLengths.set(src, Number.isFinite(a.duration) ? a.duration : 0);
        setVersion((v) => v + 1);
      };
      a.src = src;
    }
  }, [key]); // Eslint-disable-line react-hooks/exhaustive-deps
  return version;
}

/** Arrastre con umbral: hasta moverse 3 px es un clic. */
function drag(e: React.PointerEvent, move: (dx: number) => void, end: (dx: number, moved: boolean) => void) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const x0 = e.clientX;
  let moved = false;
  const mv = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    if (Math.abs(dx) > 3) moved = true;
    if (moved) move(dx);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", mv);
    window.removeEventListener("pointerup", up);
    end(ev.clientX - x0, moved);
  };
  window.addEventListener("pointermove", mv);
  window.addEventListener("pointerup", up);
}

const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export default function Timeline(p: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const R = useRef(p);
  R.current = p;
  const [view, setView] = useState({ left: 0, width: 800 });
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [reorder, setReorder] = useState<{ from: number; boundary: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; t: number; target: Selection } | null>(null);
  const [fxMenu, setFxMenu] = useState(false);
  // Alto de cada pista (las ampliadas enseñan y editan curvas de volumen y rampas); se recuerda en este navegador
  const [heights, setHeights] = useState<Record<string, number>>(loadHeights);
  useEffect(() => {
    try { localStorage.setItem("fs-tl-h", JSON.stringify(heights)); } catch { /* Sin almacenamiento: vale hasta cerrar */ }
  }, [heights]);
  const hOf = (key: string, cls: string) => heights[key] ?? BASE_H[cls] ?? 30;
  const tallOf = (key: string, cls: string) => cls in TALL_EXTRA && hOf(key, cls) >= (BASE_H[cls] ?? 30) + 20;
  const scrubbing = useRef(false);
  const pendingScroll = useRef<number | null>(null);

  const px = p.pxPerSec;
  const width = Math.max(p.duration * px + 160, 400);
  const x = (t: number) => t * px;
  const offsets = useMemo(() => segmentOffsets(p.comp.segments), [p.comp.segments]);
  const audioVersion = useAudioLengths(p.comp.audio.filter((a) => a.kind === "sfx").map((a) => a.src));

  // ---------- Zoom y desplazamiento ----------
  const zoomTo = (next: number, anchorClientX?: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const npx = Math.min(MAX_PX, Math.max(MIN_PX, next));
    const rect = el.getBoundingClientRect();
    const viewW = el.clientWidth - LABEL_W;
    const phX = R.current.playhead * R.current.pxPerSec - el.scrollLeft;
    const ax = anchorClientX !== undefined ? anchorClientX - rect.left - LABEL_W : phX >= 0 && phX <= viewW ? phX : viewW / 2;
    const t = (el.scrollLeft + ax) / R.current.pxPerSec;
    pendingScroll.current = Math.max(0, t * npx - ax);
    R.current.onZoom(npx);
  };
  const fit = () => {
    const el = scrollRef.current;
    if (!el) return;
    pendingScroll.current = 0;
    R.current.onZoom(Math.min(MAX_PX, Math.max(MIN_PX, (el.clientWidth - LABEL_W - 40) / Math.max(0.5, R.current.duration))));
  };
  useImperativeHandle(p.handleRef, () => ({ zoomBy: (f: number) => zoomTo(R.current.pxPerSec * f), fit }));

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingScroll.current !== null) {
      el.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [px]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setView({ left: el.scrollLeft, width: el.clientWidth - LABEL_W }));
    };
    // Rueda: Ctrl = zoom anclado al ratón; sin Ctrl = desplazar en horizontal; Mayús = en vertical.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(R.current.pxPerSec * Math.exp(-e.deltaY * 0.0022), e.clientX);
      } else if (e.shiftKey) {
        // Mayús+rueda baja por las pistas (antes el navegador lo convertía en desplazamiento horizontal y no había
        // Forma de llegar con la rueda a las pistas de abajo)
        e.preventDefault();
        el.scrollTop += e.deltaY || e.deltaX;
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    sync();
    el.addEventListener("scroll", sync);
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []); // Eslint-disable-line react-hooks/exhaustive-deps

  // El cursor de reproducción nunca se sale de la vista.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrubbing.current) return;
    const xp = p.playhead * px;
    const viewW = el.clientWidth - LABEL_W;
    if (xp < el.scrollLeft || xp > el.scrollLeft + viewW - 24) el.scrollLeft = Math.max(0, xp - (p.playing ? 48 : viewW / 2));
  }, [p.playhead]); // Eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menu && !fxMenu) return;
    const close = () => { setMenu(null); setFxMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, fxMenu]);

  // ---------- Imán ----------
  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(R.current.duration, (clientX - rect.left - LABEL_W + el.scrollLeft) / R.current.pxPerSec));
  };
  const snapTargets = (skipId?: string) => {
    const c = R.current.comp;
    const items = [...c.overlays, ...(c.fx ?? [])].filter((o) => o.id !== skipId).flatMap((o) => [o.start, o.end]);
    const sfx = c.audio.filter((a) => a.kind === "sfx" && a.id !== skipId).map((a) => a.start);
    return [...editPoints(c), R.current.playhead, ...items, ...sfx];
  };
  const makeSnap = (skipId?: string, extra: number[] = []) => {
    const targets = [...snapTargets(skipId), ...extra];
    return (t: number): { t: number; hit: boolean } => {
      if (!R.current.snap) return { t, hit: false };
      let best = t;
      let dist = SNAP_PX / R.current.pxPerSec;
      for (const g of targets) {
        if (Math.abs(g - t) < dist) {
          dist = Math.abs(g - t);
          best = g;
        }
      }
      return { t: best, hit: best !== t };
    };
  };

  // ---------- Gestos ----------
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    scrubbing.current = true;
    const snap = makeSnap();
    const go = (cx: number) => R.current.onSeek(snap(timeAt(cx)).t);
    go(e.clientX);
    const mv = (ev: PointerEvent) => go(ev.clientX);
    const up = () => {
      scrubbing.current = false;
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const onTrackDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = timeAt(e.clientX);
    if (R.current.tool === "blade") R.current.onAction({ type: "split", t: makeSnap()(t).t, target: null });
    else scrub(e);
  };

  const trimSeg = (e: React.PointerEvent, i: number, edge: "in" | "out") => {
    const c = R.current.comp;
    const pps = R.current.pxPerSec;
    const edgeT = segmentOffsets(c.segments)[i] + (edge === "out" ? segmentLength(c.segments[i]) : 0);
    const snap = makeSnap();
    if (R.current.tool === "rolling") {
      // Rodillo: el borde derecho mueve el corte con el siguiente; el izquierdo, con el anterior.
      const b = edge === "out" ? i + 1 : i;
      if (b <= 0 || b >= c.segments.length) return;
      const at = segmentOffsets(c.segments)[b];
      const d = (dx: number) => {
        const s = snap(at + dx / pps);
        setSnapLine(s.hit ? s.t : null);
        return s.t - at;
      };
      drag(e, (dx) => R.current.onEdit?.("roll", b, d(dx), false), (dx, moved) => {
        setSnapLine(null);
        if (moved) R.current.onEdit?.("roll", b, d(dx), true);
      });
      return;
    }
    const delta = (dx: number) => {
      if (edge === "in") return dx / pps;
      const s = snap(edgeT + dx / pps);
      setSnapLine(s.hit ? s.t : null);
      return s.t - edgeT;
    };
    drag(e, (dx) => R.current.onTrim(i, edge, delta(dx), false), (dx, moved) => {
      setSnapLine(null);
      if (moved) R.current.onTrim(i, edge, delta(dx), true);
    });
  };

  const moveItem = (e: React.PointerEvent, kind: "overlay" | "audio" | "fx", id: string, part: "move" | "start" | "end",
    s0: number, e0: number) => {
    const pps = R.current.pxPerSec;
    const snap = makeSnap(id);
    const delta = (dx: number) => {
      const d = dx / pps;
      if (part === "start" || part === "end") {
        const base = part === "start" ? s0 : e0;
        const s = snap(base + d);
        setSnapLine(s.hit ? s.t : null);
        return s.t - base;
      }
      const a = snap(s0 + d);
      const b = snap(e0 + d);
      const pick = a.hit && (!b.hit || Math.abs(a.t - s0 - d) <= Math.abs(b.t - e0 - d)) ? { d: a.t - s0, at: a.t }
        : b.hit ? { d: b.t - e0, at: b.t } : { d, at: null };
      setSnapLine(pick.at);
      return pick.d;
    };
    drag(e, (dx) => R.current.onMoveItem(kind, id, part, delta(dx), false, [s0, e0]), (dx, moved) => {
      setSnapLine(null);
      if (moved) R.current.onMoveItem(kind, id, part, delta(dx), true, [s0, e0]);
    });
  };

  const itemDown = (e: React.PointerEvent, sel: Selection, kind: "overlay" | "audio" | "fx", id: string, s0: number, e0: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (R.current.tool === "blade") {
      const t = makeSnap()(timeAt(e.clientX)).t;
      R.current.onAction({ type: "split", t, target: kind === "audio" ? null : sel });
      return;
    }
    R.current.onSelect(sel);
    moveItem(e, kind, id, "move", s0, e0);
  };

  const segDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (R.current.tool === "blade") {
      R.current.onAction({ type: "split", t: makeSnap()(timeAt(e.clientX)).t, target: null });
      return;
    }
    R.current.onSelect({ kind: "segment", index: i });
    const tool = R.current.tool;
    if (tool === "rolling") return; // El rodillo va por los bordes
    if (tool === "slip" || tool === "slide") {
      const pps = R.current.pxPerSec;
      drag(e, (dx) => R.current.onEdit?.(tool, i, dx / pps, false), (dx, moved) => { if (moved) R.current.onEdit?.(tool, i, dx / pps, true); });
      return;
    }
    if (R.current.comp.segments.length < 2) return;
    // Arrastrar el tramo lo cambia de sitio: se suelta en el corte más cercano.
    const bounds = () => {
      const c = R.current.comp;
      const offs = segmentOffsets(c.segments);
      return [...offs, offs[offs.length - 1] + segmentLength(c.segments[c.segments.length - 1])];
    };
    const nearest = (cx: number) => {
      const t = timeAt(cx);
      const b = bounds();
      let k = 0;
      b.forEach((v, j) => { if (Math.abs(v - t) < Math.abs(b[k] - t)) k = j; });
      return k;
    };
    const x0 = e.clientX;
    let moved = false;
    let last = i;
    const mv = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 4) moved = true;
      if (!moved) return;
      last = nearest(ev.clientX);
      setReorder({ from: i, boundary: last });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setReorder(null);
      if (moved) {
        const to = last > i ? last - 1 : last;
        if (to !== i) R.current.onReorder(i, to);
      }
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const shotDown = (e: React.PointerEvent, i: number, panel: number, key: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const c = R.current.comp;
    const seg = c.segments[i];
    if (R.current.tool === "blade") {
      const off = segmentOffsets(c.segments)[i];
      const t = makeSnap()(timeAt(e.clientX)).t;
      R.current.onAction({ type: "cut", index: i, panel, local: segmentSourceLocal(seg, t - off) });
      return;
    }
    R.current.onSelect({ kind: "shot", index: i, panel, key });
  };

  // Mover un corte: se pega a cortes, cursor y al inicio de cada palabra (cortar entre frases queda natural).
  const cutDrag = (e: React.PointerEvent, i: number, panel: number, key: number) => {
    const c = R.current.comp;
    const seg = c.segments[i];
    const off = segmentOffsets(c.segments)[i];
    const edge0 = off + segmentLocalOf(seg, keysOf(seg, panel)[key].t);
    const words = captionWordsTimeline(c).map((w) => w.s);
    const snap = makeSnap(undefined, words);
    const pps = R.current.pxPerSec;
    const local = (dx: number) => {
      const s = snap(edge0 + dx / pps);
      setSnapLine(s.hit ? s.t : null);
      return segmentSourceLocal(seg, s.t - off);
    };
    R.current.onSelect({ kind: "shot", index: i, panel, key });
    drag(e, (dx) => R.current.onMoveCut(i, panel, key, local(dx), false), (dx, moved) => {
      setSnapLine(null);
      if (moved) R.current.onMoveCut(i, panel, key, local(dx), true);
    });
  };

  const openMenu = (e: React.MouseEvent, target: Selection) => {
    e.preventDefault();
    e.stopPropagation();
    if (target) R.current.onSelect(target);
    setMenu({ x: e.clientX, y: e.clientY, t: timeAt(e.clientX), target });
  };

  // ---------- Pistas (memorizadas: no se recalculan con cada fotograma de reproducción) ----------
  const fs = p.filmstrip;
  const pk = p.peaks;
  const tracks = useMemo(() => {
    const c = p.comp;
    const sel = p.selection;
    const rows: { key: string; label: string; cls: string; body: React.ReactNode }[] = [];
    const compose = (fn: (c: Composition) => Composition, merge: boolean) => R.current.onCompose?.(fn, merge);
    const angles = c.angles ?? [];
    const isSel = (k: string, id: string | number) =>
      !!sel && sel.kind === k && ((sel as { id?: string }).id === id || (sel as { index?: number }).index === id
        || (sel.kind === "word" && sel.end !== undefined && typeof id === "number" && id >= Math.min(sel.index, sel.end) && id <= Math.max(sel.index, sel.end)));

    /** Bloque de una capa en la timeline, con un rombo por fotograma clave. */
    const overlayItem = (o: Overlay) => (
      <div key={o.id} className={`tl-item overlay ${o.kind === "video" ? "vclip" : ""} ${isSel("overlay", o.id) ? "sel" : ""}`}
        style={{ left: x(o.start), width: Math.max(8, x(o.end - o.start)) }} title={`${TRACK_LABEL[o.kind]} · ${overlayLabel(o)}`}
        onPointerDown={(e) => itemDown(e, { kind: "overlay", id: o.id }, "overlay", o.id, o.start, o.end)}
        onContextMenu={(e) => openMenu(e, { kind: "overlay", id: o.id })}>
        <span className="tl-text">{overlayLabel(o)}</span>
        {o.keys?.map((k, j) => <span key={j} className="tl-key" style={{ left: x(k.t) }} title={`Clave ${j + 1} · ${k.t.toFixed(2)} s`} />)}
        <span className="tl-handle l" onPointerDown={(e) => { e.stopPropagation(); R.current.onSelect({ kind: "overlay", id: o.id }); moveItem(e, "overlay", o.id, "start", o.start, o.end); }} />
        <span className="tl-handle r" onPointerDown={(e) => { e.stopPropagation(); R.current.onSelect({ kind: "overlay", id: o.id }); moveItem(e, "overlay", o.id, "end", o.start, o.end); }} />
      </div>
    );

    // Pistas de vídeo superiores: la más alta arriba, como en Premiere.
    const vclips = c.overlays.filter((o) => o.kind === "video");
    [...new Set(vclips.map((o) => o.track))].sort((a, b) => b - a).forEach((n) => {
      pack(vclips.filter((o) => o.track === n)).forEach((lane, li) => rows.push({
        key: `v${n}-${li}`, label: li === 0 ? `V${n}` : "", cls: "overlay", body: lane.map(overlayItem),
      }));
    });

    // Vídeo: tramos con miniaturas, forma de onda y puntos de encuadre.
    if (c.segments.length) {
      rows.push({
        key: "video", label: angles.length ? "Vídeo · A" : "Vídeo", cls: "video", body: c.segments.map((s, i) => {
          const len = segmentLength(s);
          const vt = tallOf("video", "video");
          const ang = s.angle ? angles.find((a) => a.id === s.angle) : undefined;
          const w = Math.max(6, x(len));
          const speed = s.speed || 1;
          const srcLen = s.src_out - s.src_in;
          let film: React.ReactNode = null;
          if (fs) {
            const scale = FILM_H / fs.tile_h;
            const tw = fs.tile_w * scale;
            const n = Math.min(600, Math.ceil(w / tw));
            film = Array.from({ length: n }, (_, k) => {
              const local = segmentSourceLocal(s, (k + 0.5) * tw / px);
              const idx = Math.max(0, Math.min(fs.count - 1, Math.round((s.src_in + local - fs.start) / fs.step)));
              return (
                <span key={k} className="tl-tile" style={{
                  left: k * tw, width: tw, backgroundImage: `url(${fs.url})`,
                  backgroundSize: `${fs.cols * tw}px auto`,
                  backgroundPosition: `${-(idx % fs.cols) * tw}px ${-Math.floor(idx / fs.cols) * FILM_H}px`,
                }} />
              );
            });
          }
          let wave: React.ReactNode = null;
          if (pk && pk.peaks.length) {
            let d = "";
            for (let xx = 1; xx < w; xx += 3) {
              const local = segmentSourceLocal(s, xx / px);
              if (local > srcLen) break;
              const v = pk.peaks[Math.floor((s.src_in + local) / pk.step)] ?? 0;
              const a = Math.max(0.6, (v / 255) * 8);
              d += `M${xx} ${9 - a}V${9 + a}`;
            }
            wave = <svg className="tl-wave" width={w} height={18} aria-hidden><path d={d} /></svg>;
          }
          return (
            <div key={s.id} className={`tl-item seg ${s.cold_open ? "cold" : ""} ${isSel("segment", i) ? "sel" : ""} ${reorder?.from === i ? "dragging" : ""} ${ang ? "off" : ""}`}
              style={{ left: x(offsets[i]), width: w }} title={s.label || `Tramo ${i + 1}`}
              onPointerDown={(e) => segDown(e, i)} onContextMenu={(e) => openMenu(e, { kind: "segment", index: i })}>
              <div className="tl-film">{film}</div>
              {wave}
              {vt ? (
                <CurveLane keys={s.vol_keys} base={s.volume} len={srcLen} w={w} h={Math.max(24, hOf("video", "video") - 8 - FILM_H - 18)}
                  toPx={(t) => segmentLocalOf(s, t) * px} fromPx={(xx) => segmentSourceLocal(s, xx / px)}
                  onChange={(keys, merge) => compose((cc) => ({ ...cc, segments: cc.segments.map((z) => (z.id === s.id ? { ...z, vol_keys: keys } : z)) }), merge)} />
              ) : s.vol_keys?.length ? <VolLine keys={s.vol_keys} len={srcLen} w={w} toPx={(t) => segmentLocalOf(s, t) * px} /> : null}
              {/* Cortes J/L: tramo en el que se oye el plano vecino */}
              {audioOffset(c.segments, i) > 0 && <span className="tl-jl" style={{ left: 0, width: x(audioOffset(c.segments, i)) }}
                title={`Corte L: aquí sigue oyéndose el tramo ${i}`} />}
              {audioOffset(c.segments, i + 1) < 0 && <span className="tl-jl" style={{ right: 0, width: x(-audioOffset(c.segments, i + 1)) }}
                title={`Corte J: aquí ya se oye el tramo ${i + 2}`} />}
              <span className="tl-chip">
                {s.cold_open ? "Gancho · " : ""}{i + 1} · {len.toFixed(1)} s{s.speed_keys?.length ? " · rampa" : speed !== 1 ? ` · ×${speed}` : ""}{s.reverse ? " · ◀ marcha atrás" : ""}{s.freeze ? ` · +${s.freeze} s fijo` : ""}
                {s.layout === "split" ? " · dividida" : ""}{ang ? ` · se ve ${ang.label}` : ""}
              </span>
              <span className="tl-handle l" onPointerDown={(e) => trimSeg(e, i, "in")} title="Recortar el inicio" />
              <span className="tl-handle r" onPointerDown={(e) => trimSeg(e, i, "out")} title="Recortar el final" />
            </div>
          );
        }),
      });
      // Multicámara. Una pista por ángulo; clic en un tramo = ese tramo se ve desde ahí (otro clic, vuelve a A).
      angles.forEach((ang) => rows.push({
        key: `ang-${ang.id}`, label: ang.label, cls: "angle", body: c.segments.map((s, i) => {
          const on = s.angle === ang.id;
          const w = Math.max(6, x(segmentLength(s)) - 1);
          return (
            <div key={s.id} className={`tl-item angle ${on ? "on" : ""} ${isSel("segment", i) ? "sel" : ""}`} style={{ left: x(offsets[i]), width: w }}
              title={on ? `Tramo ${i + 1}: se ve ${ang.label}. Clic para volver a la pista A` : `Clic: el tramo ${i + 1} se ve desde ${ang.label}`}
              onPointerDown={(e) => {
                if (e.button) return;
                e.stopPropagation();
                R.current.onSelect({ kind: "segment", index: i });
                compose((cc) => ({ ...cc, segments: cc.segments.map((z, zi) => (zi === i ? { ...z, angle: on ? undefined : ang.id } : z)) }), false);
              }}>
              {w > 46 && <span className="tl-text">{on ? `● ${ang.label}` : `${i + 1}`}</span>}
            </div>
          );
        }),
      }));
    } else if (c.scenes.length) {
      rows.push({
        key: "video", label: "Escenas", cls: "video", body: c.scenes.map((sc) => {
          const img = sc.kind === "image" ? sc.src : sc.poster;
          return (
            <div key={sc.id} className={`tl-item scene ${sc.kind}`} title={sc.graphic?.component ?? sc.id}
              style={{ left: x(sc.start), width: Math.max(3, x(sc.duration) - 1), backgroundImage: img ? `url(${img})` : undefined }}
              onPointerDown={(e) => { e.stopPropagation(); R.current.onSeek(sc.start); }}>
              {x(sc.duration) > 50 && <span className="tl-chip">{sc.kind === "graphic" ? sc.graphic?.component : sc.id}</span>}
            </div>
          );
        }),
      });
    }

    // Cámara: un bloque por plano (cada corte de la IA o tuyo). En pantalla dividida, una pista por panel.
    // Los cortes, transiciones y zooms del vídeo original van marcados aparte (rombo de color en la pista), y el
    // Plano que empieza justo en uno lleva su borde de ese color: así se distinguen de los cortes de la herramienta.
    if (c.segments.length) {
      const lanes = Math.min(3, Math.max(1, ...c.segments.map((s) => (s.layout === "split" ? s.panels?.length ?? 1 : 1))));
      for (let lane = 0; lane < lanes; lane++) {
        rows.push({
          key: `cam${lane}`, label: lane === 0 ? "Cámara" : `Cámara ${lane + 1}`, cls: "cam", body: c.segments.map((s, i) => {
            const split = s.layout === "split" && !!s.panels?.length;
            if (lane > 0 && !(split && s.panels![lane])) return null;
            const len = segmentLength(s);
            const off = offsets[i];
            const src = sourceCutsLocal(s);
            const marks = lane === 0 ? src.map((c) => (
              <span key={`src${c.t}`} className={`tl-srccut ${c.kind}`} style={{ left: x(off + c.at) }}
                title={`${SOURCE_CUT_LABEL[c.kind]} (${c.t.toFixed(2)} s del original)`} />
            )) : null;
            if (!split && s.layout !== "crop") {
              return lane === 0 ? (
                <React.Fragment key={s.id}>
                  <div className="tl-item shot fit" style={{ left: x(off), width: Math.max(4, x(len) - 1) }}
                    title="Vídeo completo, sin recorte" onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); R.current.onSelect({ kind: "segment", index: i }); }}>
                    <span className="tl-text">Completo</span>
                  </div>
                  {marks}
                </React.Fragment>
              ) : null;
            }
            const panel = split ? lane : -1;
            const name = split ? s.panels![lane].label || `Panel ${lane + 1}` : "";
            const keys = keysOf(s, panel);
            const ct = tallOf(`cam${lane}`, "cam");
            const rampH = Math.max(12, hOf(`cam${lane}`, "cam") - 32);
            return (
              <React.Fragment key={s.id}>
                {ct && !s.reverse && keys.map((k, j) => {
                  // Rampa del corte (movimiento suave): cuánto dura y con qué curva llega al plano siguiente
                  if (j === 0 || (k.ease ?? "hold") === "hold") return null;
                  const span = k.t - keys[j - 1].t;
                  const dur = Math.min(k.dur ?? span, span);
                  const a = off + segmentLocalOf(s, k.t - dur);
                  const b = off + segmentLocalOf(s, k.t);
                  const rw = Math.max(4, x(b - a));
                  let d = "";
                  for (let q = 0; q <= 24; q++) {
                    const e = easeAt(k.ease ?? "smooth", k.bezier, q / 24) ?? 0;
                    d += `${q ? "L" : "M"}${((q / 24) * rw).toFixed(1)} ${(rampH - 2 - e * (rampH - 4)).toFixed(1)}`;
                  }
                  return (
                    <div key={`ramp${j}`} className="tl-ramp" style={{ left: x(a), width: rw, height: rampH }}
                      title={`Rampa hasta el plano ${j + 1}: ${dur.toFixed(2)} s${k.dur ? "" : " (todo el plano anterior)"}. Arrastra el borde izquierdo para cambiarla; la curva se elige en Cámara.`}>
                      <svg width={rw} height={rampH} aria-hidden><path d={d} /></svg>
                      <span className="tl-ramp-h" onPointerDown={(e) => {
                        let merge = false;
                        drag(e, (dx) => {
                          const local = segmentSourceLocal(s, timeAt(e.clientX + dx) - off);
                          const nd = Math.min(span, Math.max(0.05, k.t - local));
                          const value = nd >= span - 0.02 ? undefined : +nd.toFixed(3);
                          compose((cc) => {
                            const sg = cc.segments[i];
                            return sg ? withKeys(cc, i, panel, keysOf(sg, panel).map((kk, kj) => (kj === j ? { ...kk, dur: value } : kk))) : cc;
                          }, merge);
                          merge = true;
                        }, () => {});
                      }} />
                    </div>
                  );
                })}
                {keys.map((k, j) => {
                  const lo = j === 0 ? (s.reverse ? len : 0) : segmentLocalOf(s, k.t);
                  const hi = j + 1 < keys.length ? segmentLocalOf(s, keys[j + 1].t) : s.reverse ? 0 : len;
                  const t0 = off + Math.min(lo, hi);
                  const t1 = off + Math.max(lo, hi);
                  if (t1 <= t0) return null;
                  const on = !!sel && sel.kind === "shot" && sel.index === i && sel.panel === panel && sel.key === j;
                  const orig = j > 0 ? src.find((c) => Math.abs(c.at - segmentLocalOf(s, k.t)) < 0.06) : undefined;
                  return (
                    <div key={j} className={`tl-item shot ${j % 2 ? "alt" : ""} ${j > 0 && (k.ease ?? "hold") !== "hold" ? "smooth" : ""} ${orig ? `src ${orig.kind}` : ""} ${on ? "sel" : ""}`}
                      style={{ left: x(t0), width: Math.max(3, x(t1 - t0) - 1) }}
                      title={`${name ? `${name} · ` : ""}Plano ${j + 1}${k.label ? ` · ${k.label}` : ""} · zoom ×${k.zoom.toFixed(2)}${j > 0 ? ((k.ease ?? "hold") !== "hold" ? " · entra con movimiento suave" : " · entra con corte") : ""}${orig ? ` · ${SOURCE_CUT_LABEL[orig.kind].toLowerCase()}` : ""}`}
                      onPointerDown={(e) => shotDown(e, i, panel, j)}
                      onContextMenu={(e) => openMenu(e, { kind: "shot", index: i, panel, key: j })}>
                      {x(t1 - t0) > 40 && <span className="tl-text">{name && j === 0 ? `${name} · ` : ""}{k.label ? `${k.label} · ` : `${j + 1} · `}×{k.zoom.toFixed(1)}</span>}
                      {j > 0 && <span className="tl-cut" title="Arrastra para mover el corte" onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); cutDrag(e, i, panel, j); }} />}
                    </div>
                  );
                })}
                {marks}
              </React.Fragment>
            );
          }),
        });
      }
    }

    // Zoom y efectos: siempre visible para que se vea dónde van. Doble clic en un hueco = punch-in ahí.
    const fxLanes = pack(c.fx ?? []);
    (fxLanes.length ? fxLanes : [[]]).forEach((lane, li) => rows.push({
      key: `fx${li}`, label: li === 0 ? "Zoom y efectos" : "", cls: "fx", body: lane.map((f) => (
        <div key={f.id} className={`tl-item fx ${f.kind} ${isSel("fx", f.id) ? "sel" : ""}`}
          style={{ left: x(f.start), width: Math.max(8, x(f.end - f.start)) }} title={FX_LABEL[f.kind]}
          onPointerDown={(e) => itemDown(e, { kind: "fx", id: f.id }, "fx", f.id, f.start, f.end)}
          onContextMenu={(e) => openMenu(e, { kind: "fx", id: f.id })}>
          <span className="tl-text">{FX_LABEL[f.kind]}{f.kind === "punch" || f.kind === "zoom" || f.kind === "pan" ? ` +${Math.round(f.amount * 100)} %` : ""}</span>
          <span className="tl-handle l" onPointerDown={(e) => { e.stopPropagation(); R.current.onSelect({ kind: "fx", id: f.id }); moveItem(e, "fx", f.id, "start", f.start, f.end); }} />
          <span className="tl-handle r" onPointerDown={(e) => { e.stopPropagation(); R.current.onSelect({ kind: "fx", id: f.id }); moveItem(e, "fx", f.id, "end", f.start, f.end); }} />
        </div>
      )),
    }));

    if (c.hook.text.trim() && c.captions.style.hook_enabled) {
      const hs = c.hook.start ?? 0;
      const he = Math.min(p.duration, hs + (c.hook.duration ?? c.captions.style.hook_duration));
      rows.push({
        key: "hook", label: "Gancho", cls: "overlay", body: [(
          <div key="hook" className={`tl-item overlay ${sel?.kind === "hook" ? "sel" : ""}`} title={c.hook.text}
            style={{ left: x(hs), width: Math.max(8, x(he - hs)) }}
            onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); R.current.onSelect({ kind: "hook" }); R.current.onSeek(hs); }}>
            <span className="tl-text">{c.hook.text}</span>
          </div>
        )],
      });
    }

    const words = captionWordsTimeline(c);
    rows.push({
      key: "words", label: "Subtítulos", cls: "words", body: words.map((w) => (
        <div key={w.idx} className={`tl-item word ${isSel("word", w.idx) ? "sel" : ""} ${w.hl ? "hl" : ""}`} title={w.w}
          style={{ left: x(w.s), width: Math.max(2, x(w.e - w.s) - 1) }}
          onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); const cur = R.current.selection;
            R.current.onSelect(e.shiftKey && cur?.kind === "word" ? { kind: "word", index: cur.index, end: w.idx } : { kind: "word", index: w.idx });
            if (!e.shiftKey) R.current.onSeek(w.s); }}
          onContextMenu={(e) => openMenu(e, { kind: "word", index: w.idx })}>
          {px >= 45 && <span className="tl-text">{w.w}</span>}
        </div>
      )),
    });

    pack(c.overlays.filter((o) => o.kind !== "video")).forEach((lane, li) => rows.push({
      key: `ov${li}`, label: li === 0 ? "Capas" : "", cls: "overlay", body: lane.map(overlayItem),
    }));

    const total = p.duration;
    const setAudioKeys = (id: string, keys: ValueKey[] | undefined, merge: boolean) =>
      compose((cc) => ({ ...cc, audio: cc.audio.map((z) => (z.id === id ? { ...z, vol_keys: keys } : z)) }), merge);
    const sfx = c.audio.filter((a) => a.kind === "sfx").map((a) => {
      const len = a.duration > 0 ? a.duration : Math.max(0.3, (audioLengths.get(a.src) ?? 0) - a.src_in) || 1;
      return { a, start: a.start, end: a.start + len };
    });
    pack(sfx).forEach((lane, li) => rows.push({
      key: `sfx${li}`, label: li === 0 ? "Sonidos" : "", cls: "audio", body: lane.map(({ a, start, end }) => (
        <div key={a.id} className={`tl-item audio sfx ${isSel("audio", a.id) ? "sel" : ""}`}
          style={{ left: x(start), width: Math.max(8, x(end - start)) }} title={a.label || a.src.split("/").pop()}
          onPointerDown={(e) => itemDown(e, { kind: "audio", id: a.id }, "audio", a.id, start, end)}
          onContextMenu={(e) => openMenu(e, { kind: "audio", id: a.id })}>
          <span className="tl-handle l" title="Recortar el inicio" onPointerDown={(e) => { e.stopPropagation(); R.current.onSelect({ kind: "audio", id: a.id }); moveItem(e, "audio", a.id, "start", start, end); }} />
          <span className="tl-text">{a.label || a.src.split("/").pop()}</span>
          {tallOf(`sfx${li}`, "audio")
            ? <CurveLane className="abs" keys={a.vol_keys} base={a.volume} len={end - start} w={Math.max(8, x(end - start))} h={hOf(`sfx${li}`, "audio") - 24}
                toPx={(t) => t * px} fromPx={(xx) => xx / px} onChange={(keys, merge) => setAudioKeys(a.id, keys, merge)} />
            : a.vol_keys?.length ? <VolLine keys={a.vol_keys} len={end - start} w={Math.max(8, x(end - start))} toPx={(t) => t * px} /> : null}
          <span className="tl-handle r" title="Recortar el final" onPointerDown={(e) => { e.stopPropagation(); R.current.onSelect({ kind: "audio", id: a.id }); moveItem(e, "audio", a.id, "end", start, end); }} />
        </div>
      )),
    }));
    c.audio.filter((a) => a.kind !== "sfx").forEach((a) => {
      const voice = a.kind === "voice" || a.id === "narration";
      const end = a.duration > 0 ? a.start + a.duration : total;
      rows.push({
        key: a.id, label: voice ? "Voz" : "Música", cls: "audio", body: (
          <div className={`tl-item audio ${voice ? "voice" : "music"} ${isSel("audio", a.id) ? "sel" : ""}`}
            style={{ left: x(a.start), width: Math.max(8, x(end - a.start)) }}
            onPointerDown={(e) => itemDown(e, { kind: "audio", id: a.id }, "audio", a.id, a.start, end)}
            onContextMenu={(e) => openMenu(e, { kind: "audio", id: a.id })}>
            <span className="tl-handle l" title="Recortar el inicio" onPointerDown={(e) => { e.stopPropagation(); R.current.onSelect({ kind: "audio", id: a.id }); moveItem(e, "audio", a.id, "start", a.start, end); }} />
            <span className="tl-text">{a.label || a.src.split("/").pop()}</span>
            {tallOf(a.id, "audio")
              ? <CurveLane className="abs" keys={a.vol_keys} base={a.volume} len={end - a.start} w={Math.max(8, x(end - a.start))} h={hOf(a.id, "audio") - 24}
                  toPx={(t) => t * px} fromPx={(xx) => xx / px} onChange={(keys, merge) => setAudioKeys(a.id, keys, merge)} />
              : a.vol_keys?.length ? <VolLine keys={a.vol_keys} len={end - a.start} w={Math.max(8, x(end - a.start))} toPx={(t) => t * px} /> : null}
            <span className="tl-handle r" title="Recortar el final" onPointerDown={(e) => { e.stopPropagation(); R.current.onSelect({ kind: "audio", id: a.id }); moveItem(e, "audio", a.id, "end", a.start, end); }} />
          </div>
        ),
      });
    });
    return rows;
  }, [p.comp, p.selection, px, fs, pk, offsets, reorder, audioVersion, p.duration, heights]); // Eslint-disable-line react-hooks/exhaustive-deps

  // Ampliar, plegar y cambiar la altura de las pistas
  const expandable = tracks.filter((r) => r.label && r.cls in TALL_EXTRA);
  const anyTall = tracks.some((r) => tallOf(r.key, r.cls));
  const toggleTall = (key: string, cls: string) => setHeights((h) => {
    const n = { ...h };
    if (tallOf(key, cls)) delete n[key];
    else n[key] = (BASE_H[cls] ?? 30) + TALL_EXTRA[cls];
    return n;
  });
  const allTall = () => setHeights(anyTall ? {} : Object.fromEntries(expandable.map((r) => [r.key, (BASE_H[r.cls] ?? 30) + TALL_EXTRA[r.cls]])));
  const resizeRow = (e: React.PointerEvent, key: string, cls: string) => {
    if (e.button) return;
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY;
    const h0 = hOf(key, cls);
    const base = BASE_H[cls] ?? 30;
    const mv = (ev: PointerEvent) => setHeights((h) => ({ ...h, [key]: Math.round(Math.min(MAX_ROW_H, Math.max(base, h0 + ev.clientY - y0))) }));
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  // ---------- Regla con marcas adaptadas al zoom; solo se dibuja lo visible ----------
  const major = RULER_STEPS.find((s) => s * px >= 84) ?? 600;
  const minor = major / (String(major)[0] === "2" ? 4 : 5);
  const t0 = Math.max(0, Math.floor(view.left / px / major) * major);
  const t1 = Math.min(p.duration + 1, (view.left + view.width + 80) / px);
  const ticks: { t: number; big: boolean }[] = [];
  for (let t = t0; t <= t1 && ticks.length < 2000; t += minor) {
    const r = Math.round(t / minor) * minor;
    ticks.push({ t: r, big: Math.abs(r / major - Math.round(r / major)) < 1e-6 });
  }

  const canSplit = p.comp.segments.length > 0;
  const blade = p.tool === "blade";
  const hint = (a: ShortcutAction) => p.keyHint?.(a) ?? "";

  return (
    <div className="tl">
      <div className="tl-toolbar">
        <div className="tl-group">
          <button className="btn icon tl-play" onClick={p.onTogglePlay} title={`Reproducir / pausa (${hint("play")})`} aria-label="Reproducir">
            {p.playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
          </button>
          <button className="btn icon ghost" onClick={() => p.onJump(-1)} title={`Corte anterior (${hint("prev_edit")})`} aria-label="Corte anterior"><SkipBack size={15} /></button>
          <button className="btn icon ghost" onClick={() => p.onJump(1)} title={`Corte siguiente (${hint("next_edit")})`} aria-label="Corte siguiente"><SkipForward size={15} /></button>
          <span className="tl-time"><strong>{tc(p.playhead)}</strong> / {tc(p.duration)}</span>
        </div>

        <div className="tl-group">
          <div className="seg-toggle" role="radiogroup" aria-label="Herramienta">
            <button className={p.tool === "select" ? "on" : ""} onClick={() => p.onTool("select")} title={`Seleccionar y mover (${hint("select_tool")})`} role="radio" aria-checked={p.tool === "select"}>
              <Cursor size={15} /> Mover
            </button>
            <button className={blade ? "on" : ""} onClick={() => p.onTool("blade")} title={`Cuchilla: clic donde quieras cortar (${hint("blade_tool")})`} role="radio" aria-checked={blade}>
              <Scissors size={15} /> Cortar
            </button>
            <button className={p.tool === "rolling" ? "on" : ""} onClick={() => p.onTool("rolling")} role="radio" aria-checked={p.tool === "rolling"}
              title={`Rodillo (${hint("rolling_tool")}): arrastra el borde entre dos tramos; uno crece lo que el otro encoge y la duración total no cambia`}>Rodillo</button>
            <button className={p.tool === "slip" ? "on" : ""} onClick={() => p.onTool("slip")} role="radio" aria-checked={p.tool === "slip"}
              title={`Slip (${hint("slip_tool")}): arrastra un tramo para enseñar otra parte del original sin moverlo ni cambiar su duración`}>Slip</button>
            <button className={p.tool === "slide" ? "on" : ""} onClick={() => p.onTool("slide")} role="radio" aria-checked={p.tool === "slide"}
              title={`Slide (${hint("slide_tool")}): arrastra un tramo entre sus vecinos; el anterior crece lo que el siguiente encoge`}>Slide</button>
          </div>
          <button className="btn small" disabled={!canSplit && !(p.selection?.kind === "overlay" || p.selection?.kind === "fx")}
            onClick={() => p.onAction({ type: "split", t: p.playhead, target: p.selection })} title={`Dividir en el cursor (${hint("split")})`}>
            Dividir <kbd>{hint("split") || "S"}</kbd>
          </button>
          <div className="split-btn">
            <button className="btn small" onClick={() => p.onAction({ type: "fx", t: p.playhead, kind: "punch" })} title={`Zoom (punch-in) en el cursor (${hint("punch")})`}>
              <MagnifyingGlassPlus size={14} /> Zoom <kbd>{hint("punch")}</kbd>
            </button>
            <button className="btn small" onPointerDown={(e) => e.stopPropagation()} onClick={() => setFxMenu((v) => !v)} aria-label="Más efectos" title="Más efectos">
              <CaretDown size={12} />
            </button>
            {fxMenu && (
              <FxMenu style={{ top: "calc(100% + 4px)", left: 0 }} groupNote={(g) => (g === "Transiciones" ? " · en el corte más cercano" : "")}
                onPick={(k) => { setFxMenu(false); p.onAction({ type: "fx", t: p.playhead, kind: k }); }} />
            )}
          </div>
          <button className="btn small icon" disabled={!p.selection} onClick={() => p.onAction({ type: "delete", target: p.selection })}
            title={`Borrar la selección (${hint("delete")}). Si es un tramo, el resto se junta.`} aria-label="Borrar"><Trash size={15} /></button>
        </div>

        <div className="tl-group">
          <button className={`btn small icon ${p.snap ? "on" : ""}`} onClick={() => p.onSnap(!p.snap)}
            title={`Imán ${p.snap ? "activado" : "desactivado"}: pega bordes a cortes, cursor y capas (${hint("snap")})`} aria-pressed={p.snap} aria-label="Imán">
            <MagnetStraight size={15} weight={p.snap ? "fill" : "regular"} />
          </button>
          <button className="btn small icon ghost" onClick={() => zoomTo(px / 1.5)} title={`Alejar (${hint("zoom_out")})`} aria-label="Alejar"><MagnifyingGlassMinus size={15} /></button>
          <input className="tl-zoom" type="range" min={0} max={1000} aria-label="Zoom de la línea de tiempo"
            value={Math.round((Math.log(px / MIN_PX) / Math.log(MAX_PX / MIN_PX)) * 1000)}
            onChange={(e) => zoomTo(MIN_PX * Math.pow(MAX_PX / MIN_PX, Number(e.target.value) / 1000))} />
          <button className="btn small icon ghost" onClick={() => zoomTo(px * 1.5)} title={`Acercar (${hint("zoom_in")})`} aria-label="Acercar"><MagnifyingGlassPlus size={15} /></button>
          <button className="btn small icon ghost" onClick={fit} title={`Ver todo (${hint("fit")})`} aria-label="Ver todo"><ArrowsOutLineHorizontal size={15} /></button>
          <button className="btn small icon ghost" onClick={allTall} disabled={!anyTall && !expandable.length}
            title={anyTall ? "Plegar todas las pistas" : "Ampliar las pistas de vídeo, cámara y audio (curvas de volumen y rampas)"}
            aria-label={anyTall ? "Plegar todas las pistas" : "Ampliar todas las pistas"}>
            {anyTall ? <ArrowsInLineVertical size={15} /> : <ArrowsOutLineVertical size={15} />}</button>
        </div>
      </div>

      <div className={`tl-scroll ${blade ? "blade" : ""} tool-${p.tool}`} ref={scrollRef}
        onPointerMove={(e) => setHoverT(e.clientX - e.currentTarget.getBoundingClientRect().left > LABEL_W ? timeAt(e.clientX) : null)}
        onPointerLeave={() => setHoverT(null)}>
        <div className="tl-inner" style={{ width: LABEL_W + width }}>
          <div className="tl-row ruler">
            <div className="tl-label corner" />
            <div className="tl-ruler" style={{ width }} onPointerDown={scrub}>
              {ticks.map(({ t, big }) => (
                <span key={t} className={`tl-tick ${big ? "big" : ""}`} style={{ left: x(t) }}>{big && <em>{tc(t).replace(/\.0$/, "")}</em>}</span>
              ))}
              {(p.comp.markers ?? []).map((m) => (
                <span key={m.id} className={`tl-marker ${p.selection?.kind === "marker" && p.selection.id === m.id ? "sel" : ""}`}
                  style={{ left: x(m.t), ["--mk" as string]: m.color ?? MARKER_COLORS[0] }} title={`${m.label}${m.note ? ` · ${m.note}` : ""} (${tc(m.t)})`}
                  onPointerDown={(e) => { e.stopPropagation(); R.current.onSelect({ kind: "marker", id: m.id }); R.current.onSeek(m.t); }}>
                  {x(1) > 24 && <em>{m.label}</em>}
                </span>
              ))}
              <span className="tl-head" style={{ left: x(p.playhead) }} />
              {hoverT !== null && <span className="tl-hover-time" style={{ left: x(hoverT) }}>{tc(hoverT)}</span>}
            </div>
          </div>

          {tracks.map((r) => (
            <div key={r.key} className={`tl-row ${r.cls} ${tallOf(r.key, r.cls) ? "tall" : ""}`} style={heights[r.key] ? { height: heights[r.key] } : undefined}>
              <div className="tl-label">
                {r.label && r.cls in TALL_EXTRA && (
                  <button className="tl-fold" onClick={() => toggleTall(r.key, r.cls)} aria-expanded={tallOf(r.key, r.cls)}
                    title={tallOf(r.key, r.cls) ? "Plegar la pista" : r.cls === "cam" ? "Ampliar: rampas de los cortes" : "Ampliar: curva de volumen"}>
                    {tallOf(r.key, r.cls) ? <CaretDown size={11} /> : <CaretRight size={11} />}
                  </button>
                )}
                <span className="tl-label-text">{r.label}</span>
                <span className="tl-rowsize" onPointerDown={(e) => resizeRow(e, r.key, r.cls)} title="Arrastra para cambiar la altura de la pista" />
              </div>
              <div className="tl-track" style={{ width }} onPointerDown={onTrackDown}
                onDoubleClick={r.cls === "fx" ? (e) => p.onAction({ type: "fx", t: timeAt(e.clientX), kind: "punch" }) : undefined}
                onContextMenu={(e) => openMenu(e, null)}>
                {r.body}
              </div>
            </div>
          ))}

          <div className="tl-lines" style={{ left: LABEL_W }}>
            {hoverT !== null && <span className={`tl-hover ${blade ? "blade" : ""}`} style={{ left: x(hoverT) }} />}
            {snapLine !== null && <span className="tl-snap" style={{ left: x(snapLine) }} />}
            {reorder && (() => {
              const b = [...offsets, offsets.length ? offsets[offsets.length - 1] + segmentLength(p.comp.segments[p.comp.segments.length - 1]) : 0];
              return <span className="tl-insert" style={{ left: x(b[reorder.boundary]) }} />;
            })()}
            {(p.comp.markers ?? []).map((m) => <span key={m.id} className="tl-marker-line" style={{ left: x(m.t), ["--mk" as string]: m.color ?? MARKER_COLORS[0] }} />)}
            <span className="tl-playhead" style={{ left: x(p.playhead) }} />
          </div>
        </div>
      </div>

      {menu && (
        <div className="menu" style={{ position: "fixed", left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {(() => {
            const go = (a: TimelineAction) => { setMenu(null); p.onAction(a); };
            const tg = menu.target;
            const items: [string, () => void, string?][] = [];
            if (tg?.kind === "shot") {
              const seg = p.comp.segments[tg.index];
              const local = seg ? segmentSourceLocal(seg, menu.t - offsets[tg.index]) : 0;
              const k = seg ? keysOf(seg, tg.panel)[tg.key] : undefined;
              items.push(["Cortar aquí (plano nuevo)", () => go({ type: "cut", index: tg.index, panel: tg.panel, local }), hint("split")]);
              if (tg.key > 0) {
                items.push([(k?.ease ?? "hold") !== "hold" ? "Entrar con corte seco" : "Entrar con movimiento suave",
                  () => go({ type: "ease", index: tg.index, panel: tg.panel, key: tg.key, ease: (k?.ease ?? "hold") !== "hold" ? "hold" : "smooth" })]);
                items.push(["Quitar este corte", () => go({ type: "uncut", index: tg.index, panel: tg.panel, key: tg.key }), hint("delete")]);
              }
              return items.map(([label, fn, key]) => (
                <button key={label} onClick={fn}>{label}{key && <kbd>{key}</kbd>}</button>
              ));
            }
            if (!tg || tg.kind === "segment") {
              if (canSplit) items.push(["Dividir aquí", () => go({ type: "split", t: menu.t, target: null }), hint("split")]);
              items.push(["Zoom aquí", () => go({ type: "fx", t: menu.t, kind: "punch" }), hint("punch")]);
            }
            if (tg && (tg.kind === "overlay" || tg.kind === "fx")) items.push(["Cortar aquí", () => go({ type: "split", t: menu.t, target: tg })]);
            if (tg && tg.kind !== "word" && tg.kind !== "hook" && tg.kind !== "marker") items.push(["Duplicar", () => go({ type: "duplicate", target: tg }), hint("duplicate")]);
            if (tg && (tg.kind === "segment" || tg.kind === "overlay")) {
              items.push(["Copiar atributos", () => go({ type: "copy_attrs", target: tg }), hint("copy_attrs")]);
              items.push(["Pegar atributos…", () => go({ type: "paste_attrs", target: tg }), hint("paste_attrs")]);
            }
            if (tg) items.push([tg.kind === "segment" ? "Borrar y juntar" : "Borrar", () => go({ type: "delete", target: tg }), hint("delete")]);
            return items.map(([label, fn, key]) => (
              <button key={label} onClick={fn}>{label}{key && <kbd>{key}</kbd>}</button>
            ));
          })()}
        </div>
      )}
    </div>
  );
}

/** Línea de volumen con sus claves (como la «goma» de Premiere): arriba = 150 %, abajo = mudo. */
function VolLine({ keys, len, w, toPx }: { keys: ValueKey[]; len: number; w: number; toPx: (t: number) => number }) {
  const H = 18;
  const y = (v: number) => (H - 2 - (Math.min(1.5, Math.max(0, v)) / 1.5) * (H - 4)).toFixed(1);
  const step = Math.max(len / Math.max(8, w / 3), 0.01);
  let d = "";
  for (let t = 0; t <= len + 1e-6; t += step) d += `${d ? "L" : "M"}${toPx(t).toFixed(1)} ${y(valueAt(keys, t, 1))}`;
  return (
    <svg className="tl-vol" width={w} height={H} aria-hidden>
      <path d={d} />
      {keys.map((k, i) => <rect key={i} x={toPx(k.t) - 3} y={+y(k.v) - 3} width={6} height={6} transform={`rotate(45 ${toPx(k.t)} ${y(k.v)})`} />)}
    </svg>
  );
}
