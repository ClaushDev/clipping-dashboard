import { ArrowClockwise, ArrowCounterClockwise, ArrowLeft, ChatCircleDots, CheckCircle, ListChecks, Plus, SidebarSimple, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { Player, type PlayerRef } from "@remotion/player";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import QualityPanel from "../components/QualityPanel";
import CommandBar from "../editor/CommandBar";
import CaptionsPanel from "../editor/CaptionsPanel";
import FramingPanel, { SegmentAudio } from "../editor/FramingPanel";
import AnglesPanel from "../editor/AnglesPanel";
import LayersPanel from "../editor/LayersPanel";
import MaskHandles from "../editor/MaskHandles";
import MixPanel from "../editor/MixPanel";
import TranscriptPanel from "../editor/TranscriptPanel";
import ScenePanel from "../editor/ScenePanel";
import HookPanel from "../editor/HookPanel";
import LayerList from "../editor/LayerList";
import { useScrub } from "../editor/scrub";
import { hookProps } from "../remotion/Captions";
import {
  addCut, duplicateItem, duplicateSegment, editPoints, keysOf, moveCut, moveSegment, nearestCut, newFx, removeCut, rippleRemoveSegment,
  moveOverlay, retime, segmentAt, setCutEase, shiftAfter, splitAt, splitItem, trimSegment,
  addMarker, newAdjust, rollEdit, slideSegment, slipSegment,
  addFxWithWhoosh, patchFx, removeFx,
} from "../editor/ops";
import VolumeKeys from "../editor/VolumeKeys";
import ShortcutsDialog from "../editor/ShortcutsDialog";
import ColorScopes from "../editor/ColorScopes";
import PasteAttrsDialog from "../editor/PasteAttrsDialog";
import { type AttrClip, type AttrGroup, copyAttrs, pasteAttrs, pasteGroups } from "../editor/attributes";
import { actionFor, type KeyMap, keyHint, loadKeyMap, type ShortcutAction } from "../editor/shortcuts";
import Timeline, { type Selection, type TimelineAction, type TimelineHandle, type Tool } from "../editor/Timeline";
import { useHistory } from "../editor/useHistory";
import { fmtTime, usePoll } from "../hooks";
import { useAsk } from "../project/StepKit";
import { EMPTY_COMPOSITION } from "../remotion/defaults";
import { Main } from "../remotion/Main";
import {
  type Aspect, type AudioTrack, type Segment, canvasSize, type Composition, compositionDuration, cropAt, type CropKey, type FxKind, keyedAt, type Overlay, segmentLength, segmentLocalOf, segmentOffsets, segmentSourceLocal,
  movingLength, TRANSITION_FX, isRemapped, MARKER_COLORS, SPEED_MIN, type ValueKey,
} from "../remotion/schema";

/** Efectos con un punto de destino que se arrastra sobre la vista previa. */
const ZOOM_FX: FxKind[] = ["punch", "zoom", "zoom_cut", "zoom_through", "blur_zoom"];
import type { ClipDetail, Filmstrip } from "../types";

// El panel derecho solo tiene propiedades, agrupadas por tarea. Lo que se añade está en la Biblioteca (izquierda).
// Una pestaña por tarea de una edición típica; la IA pasa a la barra de comandos (Ctrl+K).
type Tab = "shot" | "camera" | "text" | "audio" | "color" | "fx";

const TABS: { value: Tab; label: string; title: string }[] = [
  { value: "shot", label: "Plano", title: "El tramo elegido: velocidad, congelado, rampas y cortes J/L" },
  { value: "camera", label: "Cámara", title: "Encuadre y planos del tramo; seguir cara o a quien habla" },
  { value: "text", label: "Texto", title: "Gancho en pantalla, subtítulos y transcripción" },
  { value: "audio", label: "Audio", title: "Voz y volumen del tramo, pista elegida y mezcla" },
  { value: "color", label: "Color", title: "Scopes y capas de ajuste de color" },
  { value: "fx", label: "Efectos", title: "La capa o el efecto elegido (textos, imágenes, zooms, transiciones…)" },
];

function savedLib(): boolean {
  try {
    return localStorage.getItem("fs-lib") !== "0";
  } catch {
    return true;
  }
}

function savedDock(): number {
  try {
    return Number(localStorage.getItem("fs-dock")) || 300;
  } catch {
    return 300;
  }
}

/** Al cerrarlo se vuelve a la ficha del vídeo del que sale el clip (o a la lista de vídeos). */
export default function Editor({ clipId, volver = "" }: { clipId: number; volver?: string }) {
  const [detail, setDetail] = useState<ClipDetail | null>(null);
  const toVideo = !!detail?.source_id;
  const backHref = toVideo ? `#/video?id=${detail?.source_id}` : volver ? `#/${volver}` : "#/videos";
  const backLabel = toVideo ? "Volver al vídeo" : "Volver a Vídeos";
  const [loadError, setLoadError] = useState("");
  const hist = useHistory<Composition>(EMPTY_COMPOSITION);
  const comp = hist.value;
  const [saved, setSaved] = useState("");
  const [title, setTitle] = useState("");
  const [selection, setSelection] = useState<Selection>({ kind: "segment", index: 0 });
  // Capa cuya máscara se dibuja a mano en la vista previa; se cancela al cambiar de selección.
  const [maskDraw, setMaskDraw] = useState<string | null>(null);
  useEffect(() => setMaskDraw(null), [selection]);
  const [tab, setTab] = useState<Tab>("shot");
  // Barra de comandos de la IA (Ctrl+K) y biblioteca plegable (visor más grande)
  const [cmdOpen, setCmdOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [libOpen, setLibOpen] = useState(savedLib);
  const toggleLib = () => setLibOpen((v) => {
    try { localStorage.setItem("fs-lib", v ? "0" : "1"); } catch { /* Sin almacenamiento: vale hasta cerrar */ }
    return !v;
  });
  const [side, setSide] = useState<"library" | "layers">("library"); // Sidebar izquierdo
  useScrub(".ed-inspector");
  const [playhead, setPlayhead] = useState(0);
  const [checking, setChecking] = useState(false);
  const [fxNote, setFxNote] = useState("");
  const [fxBusy, setFxBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(40);
  const [tool, setTool] = useState<Tool>("select");
  // Atajos configurables, portapapeles de atributos y su diálogo
  const [keymap, setKeymap] = useState<KeyMap>(loadKeyMap);
  const [showKeys, setShowKeys] = useState(false);
  const [attrClip, setAttrClip] = useState<AttrClip | null>(null);
  const [pasting, setPasting] = useState<{ target: Selection; groups: AttrGroup[] } | null>(null);
  const [notice, setNotice] = useState("");
  const [scopesOpen, setScopesOpen] = useState(false);
  const [snap, setSnap] = useState(true);
  const [framePanel, setFramePanel] = useState(0);
  const [dockH, setDockH] = useState(savedDock);
  const [filmstrip, setFilmstrip] = useState<Filmstrip | null>(null);
  const [peaks, setPeaks] = useState<{ step: number; peaks: number[] } | null>(null);
  const [render, setRender] = useState<{ status: string; progress: number; error: string } | null>(null);
  const [saveError, setSaveError] = useState("");
  const templates = usePoll(api.templates, 0);
  const assets = usePoll(api.assets, 0);
  const sfxLib = usePoll(api.sfx, 30000); // Cada 30 s: los sonidos nuevos de tu carpeta aparecen solos
  const playerRef = useRef<PlayerRef>(null);
  const timelineRef = useRef<TimelineHandle>(null);
  const dragBase = useRef<Composition | null>(null);
  const q = useAsk();

  useEffect(() => {
    api.clip(clipId).then((d) => {
      setDetail(d);
      setTitle(d.title);
      if (d.composition) {
        hist.reset(d.composition);
        setSaved(JSON.stringify(d.composition) + d.title);
        // Miniaturas y forma de onda del original para la línea de tiempo (se calculan una vez y quedan guardadas).
        if (d.source && d.composition.segments.length) {
          const segs = d.composition.segments;
          const a = Math.min(...segs.map((s) => s.src_in)) - 20;
          const b = Math.max(...segs.map((s) => s.src_out)) + 20;
          api.filmstrip(d.source.id, Math.max(0, a), b).then(setFilmstrip).catch(() => setFilmstrip(null));
          api.peaks(d.source.id).then(setPeaks).catch(() => setPeaks(null));
        }
        window.setTimeout(() => timelineRef.current?.fit(), 50);
      }
      if (d.status === "queued" || d.status === "rendering") setRender({ status: d.status, progress: d.progress, error: "" });
    }).catch((e) => setLoadError(String(e)));
  }, [clipId]); // Eslint-disable-line react-hooks/exhaustive-deps

  const duration = compositionDuration(comp);
  const [w, h] = canvasSize(comp);
  const fps = comp.fps;
  // Memorizado; antes se serializaba la composición entera en cada fotograma de reproducción
  const dirty = useMemo(() => !!detail?.composition && JSON.stringify(comp) + title !== saved, [detail?.composition, comp, title, saved]);
  const sourceDuration = detail?.source?.duration || Infinity;
  const renderBusy = render?.status === "queued" || render?.status === "rendering";

  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [dirty]);

  // Cursor y estado de reproducción sincronizados con el reproductor.
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => setPlayhead(e.detail.frame / fps);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener("frameupdate", onFrame);
    p.addEventListener("seeked", onFrame);
    p.addEventListener("play", onPlay);
    p.addEventListener("pause", onPause);
    p.addEventListener("ended", onPause);
    return () => {
      p.removeEventListener("frameupdate", onFrame);
      p.removeEventListener("seeked", onFrame);
      p.removeEventListener("play", onPlay);
      p.removeEventListener("pause", onPause);
      p.removeEventListener("ended", onPause);
    };
  }, [fps, detail]);

  const seek = useCallback((t: number) => {
    const clamped = Math.max(0, Math.min(t, duration - 1 / fps));
    playerRef.current?.seekTo(Math.round(clamped * fps));
    setPlayhead(clamped);
  }, [duration, fps]);

  useEffect(() => {
    if (!render || (render.status !== "queued" && render.status !== "rendering")) return;
    const id = window.setInterval(async () => {
      const d = await api.clip(clipId);
      setRender({ status: d.status, progress: d.progress, error: d.error });
      if (d.status !== "queued" && d.status !== "rendering") setDetail((old) => (old ? { ...old, ...d } : d));
    }, 2000);
    return () => window.clearInterval(id);
  }, [render, clipId]);

  const segHit = segmentAt(comp, playhead);
  const selSeg = selection?.kind === "segment" || selection?.kind === "shot"
    ? Math.min(selection.index, comp.segments.length - 1) : segHit?.index ?? 0;
  const offsets = segmentOffsets(comp.segments);
  const localInSel = comp.segments[selSeg]
    ? Math.min(segmentSourceLocal(comp.segments[selSeg], playhead - offsets[selSeg]), comp.segments[selSeg].src_out - comp.segments[selSeg].src_in - 0.01)
    : 0;
  // ¿el cursor está dentro del tramo elegido? Si no, las claves de volumen y velocidad no se editan (antes se
  // Escribían en el segundo 0 del tramo aunque el cursor estuviera en otro).
  const cursorInSel = !!comp.segments[selSeg] && playhead >= offsets[selSeg] - 1e-3 && playhead <= offsets[selSeg] + segmentLength(comp.segments[selSeg]) + 1e-3;

  /** Pone el cursor al principio de un plano (en un fotograma que ya muestra su encuadre, no el del anterior). */
  function seekShot(c: Composition, index: number, panel: number, key: number) {
    const seg = c.segments[index];
    const k = seg && keysOf(seg, panel)[key];
    if (!k) return;
    const t = segmentOffsets(c.segments)[index] + segmentLocalOf(seg, key === 0 ? 0 : k.t);
    seek(Math.ceil(t * fps - 1e-6) / fps);
  }

  function select(s: Selection) {
    setSelection(s);
    if (s?.kind === "shot") {
      setTab("camera");
      setFramePanel(Math.max(0, s.panel));
      seekShot(comp, s.index, s.panel, s.key);
    }
    // Al elegir un tramo se queda en la pestaña de tramo que estaba abierta (Plano, Cámara, Audio o Color)
    if (s?.kind === "segment") setTab((t) => (t === "shot" || t === "camera" || t === "audio" || t === "color" ? t : "shot"));
    if (s?.kind === "word" || s?.kind === "hook") setTab("text");
    if (s?.kind === "overlay") setTab(comp.overlays.find((o) => o.id === s.id)?.kind === "adjust" ? "color" : "fx");
    if (s?.kind === "fx") setTab("fx");
    if (s?.kind === "audio") setTab("audio");
  }

  function remove(target: Selection) {
    if (!target) return;
    if (target.kind === "marker") {
      hist.set({ ...comp, markers: (comp.markers ?? []).filter((m) => m.id !== target.id) });
      setSelection(null);
      return;
    }
    if (target.kind === "overlay") hist.set({ ...comp, overlays: comp.overlays.filter((o) => o.id !== target.id) });
    else if (target.kind === "audio") hist.set({ ...comp, audio: comp.audio.filter((a) => a.id !== target.id) });
    else if (target.kind === "fx") hist.set(removeFx(comp, [target.id]));
    else if (target.kind === "hook") hist.set({ ...comp, hook: { ...comp.hook, text: "" } });
    else if (target.kind === "word") {
      const words = [...comp.captions.words];
      const lo = Math.min(target.index, target.end ?? target.index);
      words.splice(lo, Math.abs((target.end ?? target.index) - target.index) + 1); // Una palabra o el rango
      hist.set({ ...comp, captions: { ...comp.captions, words } });
    } else if (target.kind === "shot") {
      if (target.key === 0) return;
      hist.set(removeCut(comp, target.index, target.panel, target.key));
      setSelection({ ...target, key: target.key - 1 });
      return;
    } else if (target.kind === "segment") {
      if (comp.segments.length < 2) return;
      hist.set(rippleRemoveSegment(comp, target.index));
      setSelection({ kind: "segment", index: Math.max(0, target.index - 1) });
      return;
    }
    setSelection(null);
  }

  function cutAt(index: number, panel: number, local: number) {
    const r = addCut(comp, index, panel, local);
    hist.set(r.comp);
    const s = { kind: "shot" as const, index, panel, key: r.key };
    setSelection(s);
    setTab("camera");
    setFramePanel(Math.max(0, panel));
    seekShot(r.comp, index, panel, r.key);
  }

  /** Rodillo, slip y slide (mientras se arrastra parten siempre de la composición de antes). */
  function onEdit(kind: "roll" | "slip" | "slide", index: number, delta: number, done: boolean) {
    const first = !dragBase.current;
    const base = dragBase.current ?? comp;
    dragBase.current = done ? null : base;
    const dur = () => sourceDuration;
    const f = kind === "roll" ? rollEdit : kind === "slip" ? slipSegment : slideSegment;
    hist.set(f(base, index, delta, dur), !first);
  }

  function copyAttributes(target: Selection) {
    const clip = copyAttrs(comp, target);
    setAttrClip(clip);
    setNotice(clip ? `Atributos copiados (${clip.kind === "segment" ? "tramo" : "capa"}). Elige otro y pega con ${keyHint(keymap, "paste_attrs")}.` : "Elige un tramo o una capa para copiar sus atributos.");
  }

  function pasteAttributes(target: Selection) {
    if (!attrClip) return setNotice(`Primero copia los atributos de un tramo o una capa (${keyHint(keymap, "copy_attrs")}).`);
    const groups = pasteGroups(comp, attrClip, target);
    if (!groups.length) return setNotice(attrClip.kind === "segment" ? "Lo copiado es de un tramo: elige un tramo para pegarlo." : "Lo copiado es de una capa: elige una capa para pegarlo.");
    setPasting({ target, groups });
  }

  function doPaste(groups: AttrGroup[]) {
    if (!pasting || !attrClip) return;
    const t = pasting.target;
    let next = pasteAttrs(comp, attrClip, t, groups);
    if (t && (t.kind === "segment" || t.kind === "shot")) {
      // La velocidad pegada cambia la duración del tramo: lo de detrás se mueve con él.
      const old = segmentLength(comp.segments[t.index]);
      next = shiftAfter(next, offsets[t.index] + old, segmentLength(next.segments[t.index]) - old);
    }
    hist.set(next);
    setPasting(null);
    setNotice("");
  }

  function addMarkerHere() {
    const r = addMarker(comp, playhead);
    if (r.comp !== comp) hist.set(r.comp);
    setSelection({ kind: "marker", id: r.id });
  }

  function act(a: TimelineAction) {
    if (a.type === "copy_attrs") return copyAttributes(a.target);
    if (a.type === "paste_attrs") return pasteAttributes(a.target);
    if (a.type === "cut") cutAt(a.index, a.panel, a.local);
    else if (a.type === "uncut") remove({ kind: "shot", index: a.index, panel: a.panel, key: a.key });
    else if (a.type === "ease") hist.set(setCutEase(comp, a.index, a.panel, a.key, a.ease));
    else if (a.type === "split" && a.target?.kind === "shot") {
      // Con un plano elegido, S corta la cámara de esa pista en el cursor (no el tramo).
      const tg = a.target;
      const seg = comp.segments[tg.index];
      const local = seg ? segmentSourceLocal(seg, a.t - segmentOffsets(comp.segments)[tg.index]) : 0;
      if (seg && local > 0 && local < seg.src_out - seg.src_in) cutAt(tg.index, tg.panel, local);
    } else if (a.type === "split") {
      const tg = a.target;
      const item = tg?.kind === "overlay" ? comp.overlays.find((o) => o.id === tg.id)
        : tg?.kind === "fx" ? (comp.fx ?? []).find((f) => f.id === tg.id) : undefined;
      if (item && (tg?.kind === "overlay" || tg?.kind === "fx") && a.t > item.start && a.t < item.end) hist.set(splitItem(comp, tg.kind, tg.id, a.t));
      else if (comp.segments.length) {
        const next = splitAt(comp, a.t);
        if (next !== comp) {
          hist.set(next);
          const hit = segmentAt(next, a.t + 0.01);
          if (hit) setSelection({ kind: "segment", index: hit.index });
        }
      }
    } else if (a.type === "delete") {
      remove(a.target);
    } else if (a.type === "duplicate") {
      const tg = a.target;
      if (tg?.kind === "segment") hist.set(duplicateSegment(comp, tg.index));
      else if (tg?.kind === "overlay" || tg?.kind === "fx" || tg?.kind === "audio") {
        const r = duplicateItem(comp, tg.kind, tg.id);
        hist.set(r.comp);
        select({ kind: tg.kind, id: r.id });
      }
    } else if (a.type === "fx") {
      // Las transiciones se centran en el corte más cercano (si hay uno a mano).
      const at = TRANSITION_FX.includes(a.kind) ? nearestCut(comp, a.t) ?? a.t : a.t;
      const f = newFx(a.kind, Math.min(at, Math.max(0, duration - 0.3)), duration);
      hist.set(addFxWithWhoosh(comp, f, sfxLib.data?.items ?? []));
      select({ kind: "fx", id: f.id });
    }
  }

  /** Vuelve a colocar los efectos automáticos (solo sustituye los «auto_…»; lo tuyo se queda). Un paso de deshacer. */
  async function autoFx() {
    setFxBusy(true);
    try {
      const r = await api.autoFx(comp);
      hist.set(r.composition);
      const n = r.summary;
      const parts = [
        n.zooms && `${n.zooms} zoom${n.zooms > 1 ? "s" : ""}`, n.transitions && (n.transitions > 1 ? `${n.transitions} transiciones` : "1 transición"),
        n.numbers && `${n.numbers} cifra${n.numbers > 1 ? "s" : ""}`, n.stickers && `${n.stickers} sticker${n.stickers > 1 ? "s" : ""}`,
      ].filter(Boolean);
      setFxNote(parts.length ? `Efectos: ${parts.join(", ")}` : "Ningún efecto automático encaja (revisa Ajustes)");
      window.setTimeout(() => setFxNote(""), 6000);
    } catch (e) {
      setFxNote(e instanceof Error ? e.message : String(e));
    } finally {
      setFxBusy(false);
    }
  }

  function jump(dir: -1 | 1) {
    const pts = editPoints(comp);
    const next = dir > 0 ? pts.find((t) => t > playhead + 0.02) : [...pts].reverse().find((t) => t < playhead - 0.02);
    if (next !== undefined) seek(next);
  }

  // Atajos de teclado (fuera de los campos de texto).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showKeys || pasting) return; // El diálogo de atajos escucha las teclas
      // Cada tecla hace lo que diga el mapa de atajos (configurable).
      const a = actionFor(keymap, e);
      if (!a) return;
      const el = e.target as HTMLElement;
      // En un campo de texto las teclas son del campo; solo Guardar sigue valiendo (antes Ctrl+S abría «Guardar
      // Página» del navegador)
      if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) && a !== "save" && a !== "command") return;
      e.preventDefault();
      const run: Record<ShortcutAction, () => void> = {
        play: () => playerRef.current?.toggle(),
        undo: () => hist.undo(),
        redo: () => hist.redo(),
        save: () => { if (dirty && !renderBusy) void save(); }, // Antes Ctrl+S relanzaba el render en marcha
        duplicate: () => act({ type: "duplicate", target: selection }),
        copy_attrs: () => copyAttributes(selection),
        paste_attrs: () => pasteAttributes(selection),
        select_tool: () => setTool("select"),
        blade_tool: () => setTool("blade"),
        rolling_tool: () => setTool("rolling"),
        slip_tool: () => setTool("slip"),
        slide_tool: () => setTool("slide"),
        split: () => act({ type: "split", t: playhead, target: selection }),
        punch: () => act({ type: "fx", t: playhead, kind: "punch" }),
        snap: () => setSnap((v) => !v),
        marker: addMarkerHere,
        deselect: () => { setTool("select"); setSelection(null); },
        delete: () => remove(selection),
        frame_back: () => seek(playhead - 1 / fps),
        frame_fwd: () => seek(playhead + 1 / fps),
        sec_back: () => seek(playhead - 1),
        sec_fwd: () => seek(playhead + 1),
        prev_edit: () => jump(-1),
        next_edit: () => jump(1),
        home: () => seek(0),
        end: () => seek(duration),
        zoom_in: () => timelineRef.current?.zoomBy(1.5),
        zoom_out: () => timelineRef.current?.zoomBy(1 / 1.5),
        fit: () => timelineRef.current?.fit(),
        command: () => { playerRef.current?.pause(); setCmdOpen((v) => !v); },
        angle: () => {
          // A → B → C → A en el tramo elegido
          const ids = [undefined, ...(comp.angles ?? []).map((a) => a.id)];
          if (ids.length < 2 || !comp.segments[selSeg]) return;
          hist.set((c) => ({ ...c, segments: c.segments.map((s, j) => (j === selSeg ? { ...s, angle: ids[(ids.indexOf(s.angle) + 1) % ids.length] } : s)) }));
        },
      };
      run[a]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Recortar un tramo mueve con él todo lo que viene detrás (capas, efectos, sonidos).
  function onTrim(index: number, edge: "in" | "out", delta: number, done: boolean) {
    const first = !dragBase.current;
    const base = dragBase.current ?? comp;
    dragBase.current = done ? null : base;
    const seg = base.segments[index];
    // Con rampa, la velocidad media del tramo
    const speed = (seg.src_out - seg.src_in) / Math.max(movingLength(seg), 1e-6);
    const oldEnd = segmentOffsets(base.segments)[index] + segmentLength(seg);
    const trimmed = trimSegment(base, index, edge, (edge === "in" ? seg.src_in : seg.src_out) + delta * speed, sourceDuration);
    hist.set(shiftAfter(trimmed, oldEnd, segmentLength(trimmed.segments[index]) - segmentLength(seg)), !first);
  }

  function onMoveItem(kind: "overlay" | "audio" | "fx", id: string, part: "move" | "start" | "end", delta: number, done: boolean, span?: [number, number]) {
    const first = !dragBase.current;
    const base = dragBase.current ?? comp;
    dragBase.current = done ? null : base;
    const total = compositionDuration(base);
    const shift = <T extends { id: string; start: number; end: number }>(o: T): T => {
      if (o.id !== id) return o;
      const len = o.end - o.start;
      if (part === "move") {
        const start = Math.max(0, Math.min(total - len, o.start + delta));
        return { ...o, start: +start.toFixed(3), end: +(start + len).toFixed(3) };
      }
      if (part === "start") return retime(o, +Math.max(0, Math.min(o.end - 0.1, o.start + delta)).toFixed(3));
      return { ...o, end: +Math.min(total, Math.max(o.start + 0.1, o.end + delta)).toFixed(3) };
    };
    if (kind === "overlay") hist.set({ ...base, overlays: base.overlays.map(shift) }, !first);
    else if (kind === "fx") {
      const f = (base.fx ?? []).find((x) => x.id === id);
      hist.set(f ? patchFx(base, id, shift(f)) : base, !first);
    }
    else hist.set({ ...base, audio: base.audio.map((a) => (a.id === id ? trimAudio(a, part, delta, total, span) : a)) }, !first);
  }

  /** Mover un sonido o una música, o recortarlo por cualquiera de sus dos extremos (por delante avanza su punto de
   *  entrada en el archivo, así que se oye lo mismo en el mismo sitio). */
  function trimAudio(a: AudioTrack, part: "move" | "start" | "end", delta: number, total: number, span?: [number, number]): AudioTrack {
    if (part === "move") return { ...a, start: +Math.max(0, Math.min(total - 0.1, a.start + delta)).toFixed(3) };
    const [s0, e0] = span ?? [a.start, a.duration > 0 ? a.start + a.duration : total];
    if (part === "end") {
      const end = Math.min(total, Math.max(s0 + 0.1, e0 + delta));
      return { ...a, duration: +(end - s0).toFixed(3) };
    }
    // Por delante: no antes del principio del archivo (src_in 0) ni pasado el final
    const start = Math.max(0, s0 - a.src_in, Math.min(e0 - 0.1, s0 + delta));
    return { ...a, start: +start.toFixed(3), src_in: +Math.max(0, a.src_in + start - s0).toFixed(3), duration: +(e0 - start).toFixed(3) };
  }

  function onMoveCut(index: number, panel: number, key: number, local: number, done: boolean) {
    const first = !dragBase.current;
    const base = dragBase.current ?? comp;
    dragBase.current = done ? null : base;
    hist.set(moveCut(base, index, panel, key, local), !first);
  }

  function onReorder(from: number, to: number) {
    hist.set(moveSegment(comp, from, to));
    setSelection({ kind: "segment", index: to });
  }

  async function save() {
    setSaveError("");
    try {
      playerRef.current?.pause();
      await api.saveComposition(clipId, { composition: comp, title, hook: comp.hook.text });
      setSaved(JSON.stringify(comp) + title);
      setRender({ status: "queued", progress: 0, error: "" });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  function resetAuto() {
    q.ask("top", [{ text: "¿Descartar todas las ediciones y volver a la versión automática? Se vuelve a renderizar desde cero.", yes: "Descartar y restaurar" }], async () => {
      try {
        await api.renderClip(clipId, true);
        window.location.hash = backHref;
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  /** Arrastre de un punto (0–1) sobre la vista previa: capas y foco de los zooms. */
  const dragPoint = (e: React.PointerEvent, x0: number, y0: number, apply: (base: Composition, x: number, y: number) => Composition) => {
    e.preventDefault();
    e.stopPropagation();
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const base = comp;
    let first = true;
    const move = (ev: PointerEvent) => {
      const nx = Math.min(1, Math.max(0, x0 + (ev.clientX - sx) / box.width));
      const ny = Math.min(1, Math.max(0, y0 + (ev.clientY - sy) / box.height));
      hist.set(apply(base, +nx.toFixed(3), +ny.toFixed(3)), !first);
      first = false;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const resizeDock = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = dockH;
    let last = h0;
    const move = (ev: PointerEvent) => {
      last = Math.max(180, Math.min(window.innerHeight * 0.7, h0 + (y0 - ev.clientY)));
      setDockH(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try { localStorage.setItem("fs-dock", String(Math.round(last))); } catch { /* Sin almacenamiento */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const selectedOverlay = selection?.kind === "overlay" ? comp.overlays.find((o) => o.id === selection.id) : undefined;
  // Con fotogramas clave, el asa va donde está la capa en el cursor.
  const shownOverlay = selectedOverlay?.keys?.length
    ? ({ ...selectedOverlay, x: keyedAt(selectedOverlay, playhead - selectedOverlay.start).x, y: keyedAt(selectedOverlay, playhead - selectedOverlay.start).y } as Overlay) : selectedOverlay;
  const selectedFx = selection?.kind === "fx" ? (comp.fx ?? []).find((f) => f.id === selection.id) : undefined;
  const inputProps = useMemo(() => ({ composition: comp }), [comp]);

  if (loadError) return <div className="ed-message"><div className="notice error">{loadError}</div></div>;
  if (!detail) return <div className="ed-message muted">Cargando editor…</div>;
  if (!detail.composition) {
    return (
      <div className="ed-message">
        <div className="card stack" style={{ maxWidth: 520 }}>
          <h2>Este clip aún no tiene composición</h2>
          <p className="muted" style={{ margin: 0 }}>Se crea en el primer render con el motor nuevo. Renderízalo y vuelve a abrir el editor.</p>
          <div className="row">
            <button className="btn primary" onClick={() => api.renderClip(clipId).then(() => { window.location.hash = backHref; })}>Renderizar ahora</button>
            <a className="btn" href={backHref}>Volver</a>
          </div>
        </div>
      </div>
    );
  }

  const rendering = render && (render.status === "queued" || render.status === "rendering");
  const ratio = w / h;
  const seg0 = comp.segments[selSeg];
  // Cabecera común de las pestañas de tramo
  const segHead = seg0 && (
    <>
      <div className="ed-section-title">
        Tramo {selSeg + 1} de {comp.segments.length}
        <span className="faint small"> · {fmtTime(seg0.src_in)}–{fmtTime(seg0.src_out)} del original</span>
      </div>
      {seg0.label && <div className="small muted" style={{ marginBottom: 8 }}>«{seg0.label}»</div>}
    </>
  );
  const adjusts = comp.overlays.filter((o) => o.kind === "adjust");
  const agentSel = !selection ? "" : selection.kind === "segment" ? `segment ${selection.index}`
    : selection.kind === "word" ? (selection.end !== undefined && selection.end !== selection.index
      ? `caption words ${Math.min(selection.index, selection.end)}-${Math.max(selection.index, selection.end)}` : `caption word ${selection.index}`)
    : selection.kind === "hook" ? "on-screen hook"
    : selection.kind === "shot" ? `camera shot ${selection.key} of segment ${selection.index}${selection.panel >= 0 ? ` panel ${selection.panel}` : ""}`
      : `${selection.kind} ${selection.id}`;

  return (
    <div className="ed" style={{ gridTemplateRows: `auto minmax(0, 1fr) ${dockH}px` }}>
      <header className="ed-top">
        <a className="btn icon ghost" href={backHref} title={backLabel} aria-label={backLabel}
          onClick={(e) => {
            if (!dirty) return;
            e.preventDefault();
            q.ask("top", [{ text: "Hay cambios sin guardar. ¿Salir igualmente? Se pierden.", yes: "Salir sin guardar" }], () => { window.location.hash = backHref; });
          }}>
          <ArrowLeft size={18} />
        </a>
        <button className={`btn icon ghost ed-libtoggle ${libOpen ? "on" : ""}`} onClick={toggleLib} aria-pressed={libOpen}
          title={libOpen ? "Ocultar la biblioteca (visor más grande)" : "Mostrar la biblioteca"} aria-label="Biblioteca"><SidebarSimple size={17} /></button>
        <input className="ed-title" type="text" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} aria-label="Título" />
        <select className="small-select" value={comp.aspect} onChange={(e) => hist.set({ ...comp, aspect: e.target.value as Aspect })} aria-label="Formato">
          <option value="9:16">9:16 vertical</option>
          <option value="1:1">1:1 cuadrado</option>
          <option value="4:5">4:5</option>
          <option value="16:9">16:9 horizontal</option>
        </select>
        <div className="row" style={{ gap: 2 }}>
          <button className="btn icon ghost" disabled={!hist.canUndo} onClick={hist.undo} title="Deshacer (Ctrl+Z)" aria-label="Deshacer"><ArrowCounterClockwise size={17} /></button>
          <button className="btn icon ghost" disabled={!hist.canRedo} onClick={hist.redo} title="Rehacer (Ctrl+Y)" aria-label="Rehacer"><ArrowClockwise size={17} /></button>
        </div>
        <span className="spacer" />
        {rendering && <span className="ed-status"><span className="spin-dot" /> Renderizando {Math.round((render?.progress ?? 0) * 100)} %</span>}
        {render?.status === "review" && !dirty && <span className="ed-status ok"><CheckCircle size={15} weight="fill" /> Render listo</span>}
        {render?.status === "error" && <span className="ed-status danger" title={render.error}><WarningCircle size={15} weight="fill" /> El render falló</span>}
        {dirty && !rendering && !fxNote && <span className="ed-status">Cambios sin guardar</span>}
        {fxNote && <span className="ed-status">{fxNote}</span>}
        {agentBusy && !cmdOpen && <span className="ed-status"><span className="spin-dot" /> La IA está editando…</span>}
        <button className={`btn small ghost ${cmdOpen ? "on" : ""}`} onClick={() => { playerRef.current?.pause(); setCmdOpen((v) => !v); }} aria-pressed={cmdOpen}
          title={`Pide cambios con tus palabras: la IA los aplica en la línea de tiempo y se deshacen con Ctrl+Z (${keyHint(keymap, "command")})`}>
          <ChatCircleDots size={15} /> <span className="ed-lbl">Pedir a la IA</span> <kbd className="ed-lbl">{keyHint(keymap, "command")}</kbd></button>
        <button className="btn small ghost" disabled={fxBusy} onClick={autoFx} aria-label="Efectos automáticos"
          title="Efectos automáticos: zoom al hablar, punch-in en los momentos fuertes, cifras que cuentan, stickers y transiciones, según Ajustes → Efectos automáticos. Sustituye solo los automáticos; se deshace con Ctrl+Z.">
          <Sparkle size={15} /> <span className="ed-lbl">Efectos automáticos</span></button>
        <button className="btn small ghost" onClick={() => { playerRef.current?.pause(); setChecking(true); }} aria-label="Comprobar"
          title="Comprobar: filtros de calidad (imágenes fijas, ritmo, silencios, gancho y subtítulos), con los cambios sin guardar">
          <ListChecks size={15} /> <span className="ed-lbl">Comprobar</span></button>
        <button className="btn small ghost ed-lbl" onClick={resetAuto} title="Vuelve a la edición automática (se pierde lo editado a mano)">Restaurar automático</button>
        <button className="btn primary" disabled={!dirty || !!rendering} onClick={save} title="Ctrl+S">Guardar y renderizar</button>
      </header>
      {q.open && <div className="ed-ask">{q.view("top")}</div>}
      {saveError && <div className="notice error ed-error">{saveError}</div>}
      {/* Los avisos (voz mejorada, sin caras, atributos copiados…) salen arriba a la derecha; antes iban en la
          Biblioteca, que se oculta en pantallas estrechas */}
      {notice && !saveError && !q.open && (
        <div className="notice ed-error row" role="status">
          <span className="grow">{notice}</span>
          <button className="btn small icon ghost" aria-label="Cerrar aviso" onClick={() => setNotice("")}>×</button>
        </div>
      )}
      {checking && (
        <QualityPanel title={title} load={() => api.planQuality(comp)} onSeek={seek} onClose={() => setChecking(false)} />
      )}

      <div className={`ed-body ${libOpen ? "" : "nolib"}`}>
        <aside className="ed-library" aria-label="Biblioteca y capas" hidden={!libOpen}>
          <div className="ed-tabs" role="tablist">
            <button role="tab" aria-selected={side === "library"} className={side === "library" ? "on" : ""} onClick={() => setSide("library")}>Biblioteca</button>
            <button role="tab" aria-selected={side === "layers"} className={side === "layers" ? "on" : ""} onClick={() => setSide("layers")}>Capas</button>
          </div>
          <div className="ed-panel">
            {selection?.kind === "marker" && (() => {
              const m = (comp.markers ?? []).find((x) => x.id === selection.id);
              if (!m) return null;
              const set = (p: Partial<typeof m>) => hist.set({ ...comp, markers: (comp.markers ?? []).map((x) => (x.id === m.id ? { ...x, ...p } : x)).sort((a, b) => a.t - b.t) });
              return (
                <div className="card inset stack" style={{ marginBottom: 12 }}>
                  <div className="ed-section-title">Marcador · {fmtTime(m.t)}</div>
                  <label className="field">Nombre<input value={m.label} onChange={(e) => set({ label: e.target.value })} /></label>
                  <div className="row" role="radiogroup" aria-label="Color">
                    {MARKER_COLORS.map((c) => (
                      <button key={c} className={`marker-swatch ${m.color === c ? "on" : ""}`} style={{ background: c }} role="radio" aria-checked={m.color === c}
                        aria-label={`Color ${c}`} onClick={() => set({ color: c })} />
                    ))}
                  </div>
                  <label className="field">Nota<textarea rows={2} value={m.note ?? ""} onChange={(e) => set({ note: e.target.value || undefined })} /></label>
                  <div className="row">
                    <button className="btn small" onClick={() => set({ t: +playhead.toFixed(3) })}>Mover al cursor</button>
                    <span className="grow" />
                    <button className="btn small" onClick={() => remove(selection)}>Borrar marcador</button>
                  </div>
                </div>
              );
            })()}
            {side === "library" ? (
              <LayersPanel mode="library" clipId={clipId} comp={comp} duration={duration} playhead={playhead} assets={assets.data ?? []} sounds={sfxLib.data?.items ?? []}
                selection={selection} onSelect={select} onChange={hist.set} onAssetsChanged={assets.reload} onSeek={seek} />
            ) : (
              <LayerList comp={comp} duration={duration} selection={selection} onSelect={select} onSeek={seek} />
            )}
          </div>
        </aside>

        <section className="ed-stage" onPointerDown={(e) => { if (e.target === e.currentTarget) setSelection(null); }}>
          <div className="preview-wrap" style={{ aspectRatio: `${w} / ${h}`, width: `min(100cqw - 48px, (100cqh - 48px) * ${ratio})` }}>
            <Player
              ref={playerRef}
              numberOfSharedAudioTags={0} // Sin tope: con el de 5, el sexto sonido a la vez rompía la vista previa
              component={Main}
              inputProps={inputProps}
              durationInFrames={Math.max(1, Math.round(duration * fps))}
              fps={fps}
              compositionWidth={w}
              compositionHeight={h}
              style={{ width: "100%", height: "100%" }}
              clickToPlay={false}
              acknowledgeRemotionLicense
            />
            {shownOverlay && shownOverlay.kind !== "adjust" && !maskDraw && (
              <div className="overlay-handle-layer">
                {(shownOverlay.kind === "shape" && (shownOverlay.shape === "circle" || shownOverlay.shape === "box")) || shownOverlay.kind === "block" ? (
                  <div className="overlay-handle" onPointerDown={(e) => dragPoint(e, shownOverlay.x, shownOverlay.y, (b, x, y) => ({ ...b, overlays: b.overlays.map((o) => (o.id === shownOverlay.id ? moveOverlay(o, playhead, x, y) : o)) }))}
                    style={{ left: `${(shownOverlay.x - shownOverlay.w / 2) * 100}%`, top: `${shownOverlay.y * 100}%`,
                      width: `${shownOverlay.w * 100}%`, height: `${shownOverlay.h * 100}%` }} />
                ) : shownOverlay.kind === "shape" && shownOverlay.shape === "arrow" ? (
                  <div className="overlay-handle point" title="Punta de la flecha"
                    onPointerDown={(e) => dragPoint(e, shownOverlay.x, shownOverlay.y, (b, x, y) => ({ ...b, overlays: b.overlays.map((o) => (o.id === shownOverlay.id ? moveOverlay(o, playhead, x, y) : o)) }))}
                    style={{ left: `calc(${shownOverlay.x * 100}% - 14px)`, top: `${shownOverlay.y * 100}%` }} />
                ) : (
                  <div className="overlay-handle" onPointerDown={(e) => dragPoint(e, shownOverlay.x, shownOverlay.y, (b, x, y) => ({ ...b, overlays: b.overlays.map((o) => (o.id === shownOverlay.id ? moveOverlay(o, playhead, x, y) : o)) }))}
                    style={{ left: `${(shownOverlay.x - shownOverlay.w / 2) * 100}%`, top: `${shownOverlay.y * 100}%`, width: `${shownOverlay.w * 100}%` }} />
                )}
              </div>
            )}
            {selectedOverlay?.mask && (
              <MaskHandles o={selectedOverlay} playhead={playhead} drawing={maskDraw === selectedOverlay.id}
                onChange={(mask) => hist.set({ ...comp, overlays: comp.overlays.map((o) => (o.id === selectedOverlay.id ? { ...o, mask } : o)) })} />
            )}
            {selection?.kind === "hook" && comp.hook.text.trim() && (() => {
              const hp = hookProps(comp.hook, comp.captions.style);
              // Alto aproximado del bloque (líneas según el ancho máximo del 84 %) para que el asa lo cubra entero.
              const lines = Math.max(1, Math.ceil((comp.hook.text.length * hp.size * (h / 1920) * 0.62) / (0.84 * w))); // Con el lienzo real (antes 1080×1920 fijo)
              const hPct = ((lines * hp.size * 1.15 + (hp.bg ? 28 : 0)) / 1920) * 100;
              return (
                <div className="overlay-handle-layer">
                  <div className="overlay-handle" title="Arrastra para mover el gancho"
                    onPointerDown={(e) => dragPoint(e, hp.x, hp.y, (b, x, y) => ({ ...b, hook: { ...b.hook, x, y: Math.min(0.95, y) } }))}
                    style={{ left: `${(hp.x - 0.3) * 100}%`, top: `${hp.y * 100 + hPct / 2}%`, width: "60%", height: `${hPct}%` }} />
                </div>
              );
            })()}
            {selectedFx && ZOOM_FX.includes(selectedFx.kind) && (
              <div className="overlay-handle-layer">
                <div className="focus-handle" title="Hacia dónde hace zoom: arrástralo"
                  style={{ left: `${selectedFx.x * 100}%`, top: `${selectedFx.y * 100}%` }}
                  onPointerDown={(e) => dragPoint(e, selectedFx.x, selectedFx.y, (b, x, y) => ({ ...b, fx: (b.fx ?? []).map((f) => (f.id === selectedFx.id ? { ...f, x, y } : f)) }))} />
              </div>
            )}
          </div>
          {selectedFx && ZOOM_FX.includes(selectedFx.kind) && (
            <div className="stage-hint">Arrastra el punto para elegir hacia dónde hace zoom</div>
          )}
        </section>

        <aside className="ed-inspector" aria-label="Inspector">
          <div className="ed-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.value} role="tab" aria-selected={tab === t.value} className={tab === t.value ? "on" : ""} title={t.title} onClick={() => setTab(t.value)}>{t.label}</button>
            ))}
          </div>
          <div className="ed-panel">
            {(tab === "shot" || tab === "camera") && !comp.segments.length && (
              <div className="stack">
                <div className="small muted">
                  Este vídeo no tiene vídeo original que encuadrar: está hecho de escenas. Aquí eliges cómo se mueve la cámara en cada una.
                </div>
                <ScenePanel comp={comp} playhead={playhead} onChange={hist.set} />
              </div>
            )}
            {tab === "shot" && seg0 && (
              <>
                {segHead}
                <div className="grid-2" style={{ marginBottom: 12 }}>
                  <label className="field">
                    Velocidad
                    <select value={comp.segments[selSeg].speed ?? 1} disabled={!!comp.segments[selSeg].speed_keys?.length}
                      title={comp.segments[selSeg].speed_keys?.length ? "Este tramo lleva una rampa de velocidad (abajo)" : undefined}
                      onChange={(e) => {
                        const i = selSeg;
                        const seg = comp.segments[i];
                        const next = { ...comp, segments: comp.segments.map((s, j) => (j === i ? { ...s, speed: Number(e.target.value) } : s)) };
                        const end = offsets[i] + segmentLength(seg);
                        hist.set(shiftAfter(next, end, segmentLength(next.segments[i]) - segmentLength(seg)));
                      }}>
                      {[...new Set([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, comp.segments[selSeg].speed ?? 1])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v === 1 ? "Normal" : `×${v}`}{v < 1 ? " (cámara lenta)" : ""}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    Congelar al final (s)
                    <input type="number" min={0} max={5} step={0.1} value={comp.segments[selSeg].freeze ?? 0}
                      onChange={(e) => {
                        // El congelado alarga el tramo; lo de detrás se mueve con él (antes se quedaba quieto)
                        const seg = comp.segments[selSeg];
                        const next = { ...comp, segments: comp.segments.map((s, i) => (i === selSeg ? { ...s, freeze: Math.max(0, Math.min(5, Number(e.target.value) || 0)) } : s)) };
                        hist.set(shiftAfter(next, offsets[selSeg] + segmentLength(seg), segmentLength(next.segments[selSeg]) - segmentLength(seg)));
                      }} />
                  </label>
                </div>
                {(() => {
                  // Rampa de velocidad (remapeo de tiempo) y marcha atrás
                  const seg = comp.segments[selSeg];
                  const L = seg.src_out - seg.src_in;
                  const patch = (p: Partial<typeof seg>) => {
                    const next = { ...comp, segments: comp.segments.map((s, j) => (j === selSeg ? { ...s, ...p } : s)) };
                    hist.set(shiftAfter(next, offsets[selSeg] + segmentLength(seg), segmentLength(next.segments[selSeg]) - segmentLength(seg)));
                  };
                  const r = (v: number) => +v.toFixed(3);
                  const presets: [string, ValueKey[]][] = [
                    ["Rápido → lento → rápido", [{ t: 0, v: 2 }, { t: r(L * 0.35), v: 0.3, ease: "ease" }, { t: r(L * 0.65), v: 0.3 }, { t: r(L), v: 2, ease: "ease" }]],
                    ["Acelerar", [{ t: 0, v: 0.5 }, { t: r(L), v: 3, ease: "ease_in" }]],
                    ["Frenar", [{ t: 0, v: 3 }, { t: r(L), v: 0.4, ease: "ease_out" }]],
                  ];
                  return (
                    <details className="sound-picker" open={!!seg.speed_keys?.length || !!seg.reverse} style={{ marginBottom: 12 }}>
                      <summary>Rampa de velocidad y marcha atrás{seg.speed_keys?.length ? ` · ${seg.speed_keys.length} claves` : ""}{seg.reverse ? " · ◀" : ""}</summary>
                      <div className="stack">
                        <label className="row small">
                          <input type="checkbox" checked={!!seg.reverse} onChange={(e) => patch({ reverse: e.target.checked || undefined })} />
                          Marcha atrás
                        </label>
                        <VolumeKeys label="Velocidad" volume={seg.speed ?? 1} keys={seg.speed_keys} t={cursorInSel ? localInSel : null} length={L} fps={comp.fps}
                          min={SPEED_MIN} max={4} step={0.05} fmt={(v) => `×${v.toFixed(2)}`} addLabel="◆ Clave de velocidad en el cursor"
                          hint="Pon una clave, mueve el cursor y cambia la velocidad: el tramo acelera o frena con la curva que elijas."
                          onChange={(p) => patch({ ...(p.volume !== undefined ? { speed: p.volume } : {}), ...("vol_keys" in p ? { speed_keys: p.vol_keys } : {}) })}
                          onSeek={(t) => seek(offsets[selSeg] + segmentLocalOf(seg, t))} />
                        {!seg.speed_keys?.length && (
                          <div className="row">
                            {presets.map(([name, keys]) => <button key={name} className="btn small" onClick={() => patch({ speed_keys: keys })}>{name}</button>)}
                          </div>
                        )}
                        {isRemapped(seg) && (
                          <div className="small muted">
                            Con rampa o marcha atrás el sonido original de este tramo se quita (se dibuja fotograma a fotograma). Pon música o
                            sonidos encima. En la vista previa puede ir a saltos; el vídeo final sale fluido.
                          </div>
                        )}
                      </div>
                    </details>
                  );
                })()}
                {selSeg > 0 && (() => {
                  const v = comp.segments[selSeg].audio_offset ?? 0;
                  const lim = +(Math.min(segmentLength(comp.segments[selSeg - 1]), segmentLength(comp.segments[selSeg])) / 2).toFixed(1);
                  return (
                    <label className="field" style={{ marginBottom: 12 }}
                      title="Corte J: se oye este tramo antes de verlo. Corte L: sigue oyéndose el anterior encima de esta imagen. Los subtítulos van con el audio.">
                      Corte de audio al entrar: {v === 0 ? "a la vez que la imagen" : v < 0 ? `J · se oye ${(-v).toFixed(1)} s antes` : `L · el anterior sigue ${v.toFixed(1)} s`}
                      <input type="range" min={-Math.min(2, lim)} max={Math.min(2, lim)} step={0.1} value={Math.max(-lim, Math.min(lim, v))}
                        onChange={(e) => hist.set({ ...comp, segments: comp.segments.map((s, i) => (i === selSeg ? { ...s, audio_offset: Number(e.target.value) || undefined } : s)) })} />
                    </label>
                  );
                })()}
              </>
            )}
            {tab === "camera" && seg0 && (
              <>
                {segHead}
                <FramingPanel comp={comp} index={selSeg} local={localInSel} panel={framePanel} onPanel={setFramePanel}
                  onPickShot={(panel, key) => select({ kind: "shot", index: selSeg, panel, key })}
                  sourceUrl={detail.source?.video_url ?? comp.segments[selSeg].src}
                  onChange={(seg) => hist.set({ ...comp, segments: comp.segments.map((s, i) => (i === selSeg ? seg : s)) })}
                  onTrack={async (p) => {
                    const seg0 = comp.segments[selSeg];
                    const id = seg0.id;
                    let r: Awaited<ReturnType<typeof api.trackPoint>>;
                    try {
                      r = await api.trackPoint(clipId, { src_in: seg0.src_in, src_out: seg0.src_out, aspect: comp.aspect, src: detail.source ? "" : seg0.src, ...p });
                    } catch (err) {
                      setNotice(`No se pudo seguir el punto: ${(err as Error).message}`);
                      return;
                    }
                    if (!r.keys.length) {
                      setNotice("No se ha encontrado nada que seguir en ese punto. Prueba a hacer clic justo encima del objeto.");
                      return;
                    }
                    // Los planos de antes del cursor y los de después de donde se perdió el objeto se quedan
                    hist.set((c) => ({
                      ...c, segments: c.segments.map((s) => (s.id !== id ? s : {
                        ...s, layout: "crop",
                        keys: [...s.keys.filter((k) => k.t < p.t - 0.02), ...r.keys, ...s.keys.filter((k) => k.t > r.until + 0.05)],
                      })),
                    }));
                    const left = seg0.src_out - seg0.src_in - r.until;
                    setNotice(left > 0.5 || r.lost > 0.2
                      ? `Seguido de ${p.t.toFixed(1)} s a ${r.until.toFixed(1)} s${r.lost > 0.05 ? ` (se perdió de vista un ${Math.round(r.lost * 100)} % del tiempo)` : ""}. Para seguir después, pon el cursor allí y vuelve a marcarlo.`
                      : `Seguido hasta el final del tramo: ${r.keys.length} puntos clave en la pista «Cámara».`);
                  }}
                  onAutoframe={async (mode) => {
                    const seg0 = comp.segments[selSeg];
                    const id = seg0.id;
                    let r: Awaited<ReturnType<typeof api.autoframe>>;
                    try {
                      r = await api.autoframe(clipId, seg0.src_in, seg0.src_out, mode, comp.aspect, detail.source ? "" : seg0.src);
                    } catch (err) {
                      setNotice(`No se pudo analizar el tramo: ${(err as Error).message}`);
                      return;
                    }
                    // El análisis tarda (seguir a quien habla, ~1 s por segundo): el resultado se aplica sobre la
                    // Composición de ahora y sobre el tramo por su id, no sobre la de cuando se pulsó.
                    const patchSeg = (fn: (s: Segment) => Segment | Segment[]) =>
                      hist.set((c) => ({ ...c, segments: c.segments.flatMap((s) => (s.id === id ? fn(s) : [s])) }));
                    // Los cortes, transiciones y zooms del original quedan guardados en el tramo (pista «Cámara»)
                    const withCuts = (s: Segment): Segment => (r.source_cuts ? { ...s, source_cuts: r.source_cuts } : s);
                    let miss = "";
                    if (mode === "cuts") {
                      // Un corte de cámara en cada corte del original, con el encuadre que había (se reencuadra aparte)
                      patchSeg((s0) => {
                        const seg = withCuts(s0);
                        const cutKeys = (keys: CropKey[]) => {
                          const out = [...keys];
                          for (const c of r.source_cuts ?? []) {
                            const t = +(c.t - seg.src_in).toFixed(3);
                            if (out.some((k) => Math.abs(k.t - t) < 0.06)) continue;
                            const k = cropAt(out, t);
                            out.push({ t, x: k.x, y: k.y, zoom: k.zoom, ease: "hold" });
                          }
                          return out.sort((a, b) => a.t - b.t);
                        };
                        return seg.layout === "split" && seg.panels ? { ...seg, panels: seg.panels.map((p) => ({ ...p, keys: cutKeys(p.keys) })) }
                          : seg.layout === "crop" ? { ...seg, keys: cutKeys(seg.keys.length ? seg.keys : [{ t: 0, x: 0.5, y: 0.5, zoom: 1, ease: "hold" }]) } : seg;
                      });
                      if (!r.source_cuts?.length) miss = "El vídeo original no trae cortes, transiciones ni zooms en este tramo.";
                    } else if (mode === "speaker" && r.mode === "speaker" && r.keys.length) {
                      patchSeg((s) => ({ ...withCuts(s), layout: "crop", keys: r.keys, note: r.note }));
                    } else if (mode === "speaker") {
                      patchSeg(withCuts);
                      miss = "No se han encontrado caras en este tramo.";
                    } else if (r.mode === "parts" && r.parts) {
                      // El tramo se trocea: doble vista donde dos personas se hablan, seguir cara en el resto.
                      patchSeg((s0) => {
                        const seg = withCuts(s0);
                        return r.parts!.map((p) => {
                          const a = +(seg.src_in + p.t0).toFixed(3);
                          const b = +Math.min(seg.src_out, seg.src_in + p.t1).toFixed(3);
                          return { ...seg, id: Math.random().toString(36).slice(2, 10), src_in: a, src_out: b, layout: p.layout,
                            keys: p.keys.length ? p.keys : seg.keys, panels: p.panels, note: p.note,
                            source_cuts: seg.source_cuts?.filter((c) => c.t > a && c.t < b) };
                        });
                      });
                    } else if (r.mode === "split" && r.panels) {
                      patchSeg((s) => ({ ...withCuts(s), layout: "split", panels: r.panels!, note: r.note }));
                    } else if (mode === "face" && r.keys.length) {
                      patchSeg((s) => ({ ...withCuts(s), layout: "crop", keys: r.keys, note: undefined }));
                    } else {
                      miss = mode === "gaming" ? "No se ha encontrado una webcam fija en este tramo."
                        : mode === "duo" ? "No hay dos personas separadas en este tramo: dividir la pantalla no aporta. Usa «Seguir cara»."
                          : "No se han encontrado caras suficientes en este tramo.";
                    }
                    if (miss) setNotice(miss); // Antes, alert()
                  }} />
                <details className="ed-group" open={!!comp.angles?.length} style={{ marginTop: 12 }}>
                  <summary>Multicámara{comp.angles?.length ? ` · ${comp.angles.length + 1} ángulos` : ""}</summary>
                  <AnglesPanel comp={comp} index={selSeg} assets={assets.data ?? []} onChange={hist.set} hint={keyHint(keymap, "angle")} />
                </details>
              </>
            )}
            {tab === "color" && (
              <>
                {selectedOverlay?.kind === "adjust" ? (
                  <details className="ed-group" open>
                    <summary>Ajuste de color elegido</summary>
                    <LayersPanel mode="props" clipId={clipId} comp={comp} duration={duration} playhead={playhead} assets={assets.data ?? []} sounds={sfxLib.data?.items ?? []}
                      selection={selection} onSelect={setSelection} onChange={hist.set} onAssetsChanged={assets.reload} onSeek={seek}
                      maskDraw={maskDraw} onMaskDraw={setMaskDraw} />
                  </details>
                ) : (
                  <details className="ed-group" open>
                    <summary>Capas de ajuste de color</summary>
                    <div className="stack">
                      <div className="small muted">Un look (contraste, tono, viñeta…) sobre todo lo que hay debajo mientras dura la capa. Se alarga o se mueve en la pista de capas.</div>
                      {adjusts.map((o) => (
                        <button key={o.id} className="btn small" style={{ justifyContent: "flex-start" }} onClick={() => { select({ kind: "overlay", id: o.id }); seek(o.start); }}>
                          Ajuste · {fmtTime(o.start)}–{fmtTime(o.end)}</button>
                      ))}
                      <div><button className="btn small" onClick={() => { const o = newAdjust(+playhead.toFixed(2), duration); hist.set((c) => ({ ...c, overlays: [...c.overlays, o] })); setSelection({ kind: "overlay", id: o.id }); }}>
                        <Plus size={13} /> Ajuste de color en el cursor</button></div>
                    </div>
                  </details>
                )}
                {seg0 && (
                  <details className="ed-group" open={scopesOpen} onToggle={(e) => setScopesOpen((e.target as HTMLDetailsElement).open)}>
                    <summary>Scopes · tramo {selSeg + 1}</summary>
                    <div className="small muted" style={{ marginBottom: 8 }}>Forma de onda, desfile RGB, histograma y vectorscopio del fotograma del cursor.</div>
                    {scopesOpen && <ColorScopes comp={comp} seg={seg0} local={localInSel} playhead={playhead}
                      src={detail.source?.video_url ?? seg0.src} />}
                  </details>
                )}
              </>
            )}
            {tab === "text" && (
              <>
                <details className="ed-group" open>
                  <summary onClick={() => setSelection({ kind: "hook" })}>Gancho en pantalla</summary>
                  <HookPanel comp={comp} duration={duration} onChange={hist.set} />
                </details>
                <details className="ed-group" open>
                  <summary>Subtítulos</summary>
                  <CaptionsPanel comp={comp} templates={templates.data ?? []}
                    selectedWord={selection?.kind === "word" ? selection.index : null}
                    selectedEnd={selection?.kind === "word" ? selection.end ?? null : null}
                    onSelectWord={(i, extend) => setSelection(extend && selection?.kind === "word" ? { kind: "word", index: selection.index, end: i } : { kind: "word", index: i })}
                    onPunctuate={() => api.punctuateCaptions(clipId, comp)}
                    onChange={hist.set} onSeek={seek}
                    onRegenerate={async () => (await api.regenerateCaptions(clipId, comp)).words} />
                </details>
                <details className="ed-group">
                  <summary>Transcripción · cortar por palabras</summary>
                  <TranscriptPanel comp={comp} playhead={playhead} onChange={hist.set} onSeek={seek} />
                </details>
              </>
            )}
            {tab === "fx" && (
              <LayersPanel mode="props" clipId={clipId} comp={comp} duration={duration} playhead={playhead} assets={assets.data ?? []} sounds={sfxLib.data?.items ?? []}
                selection={selection} onSelect={setSelection} onChange={hist.set} onAssetsChanged={assets.reload} onSeek={seek}
                maskDraw={maskDraw} onMaskDraw={setMaskDraw} />
            )}
            {tab === "audio" && (
              <>
                {seg0 && selection?.kind !== "audio" && (
                  <details className="ed-group" open>
                    <summary>Sonido del tramo {selSeg + 1}</summary>
                    <SegmentAudio comp={comp} seg={seg0} local={localInSel} cursorIn={cursorInSel}
                      onChange={(seg) => hist.set({ ...comp, segments: comp.segments.map((s, i) => (i === selSeg ? seg : s)) })}
                      onSeekLocal={(t) => seek(offsets[selSeg] + segmentLocalOf(seg0, t))}
                      onEnhanceVoice={async (level) => {
                        const src = comp.segments[selSeg].src;
                        try {
                          const r = await api.enhanceVoice(clipId, src, level);
                          // Todos los tramos del mismo archivo: así la voz suena igual en todo el vídeo. Sobre la composición
                          // De ahora (lo editado mientras se limpiaba la voz no se pierde).
                          hist.set((c) => ({ ...c, segments: c.segments.map((s) => (s.src === src ? { ...s, voice: { src: r.src, level } } : s)) }));
                          setNotice("Voz mejorada en todos los tramos de este vídeo.");
                        } catch (err) {
                          setNotice(`No se pudo mejorar la voz: ${(err as Error).message}`);
                        }
                      }}
                    />
                  </details>
                )}
                {selection?.kind === "audio" && (
                  <details className="ed-group" open>
                    <summary>Pista elegida</summary>
                    <LayersPanel mode="props" clipId={clipId} comp={comp} duration={duration} playhead={playhead} assets={assets.data ?? []} sounds={sfxLib.data?.items ?? []}
                      selection={selection} onSelect={setSelection} onChange={hist.set} onAssetsChanged={assets.reload} onSeek={seek} />
                  </details>
                )}
                <details className="ed-group" open>
                  <summary>Mezcla</summary>
                  <MixPanel comp={comp} duration={duration} playhead={playhead} onChange={hist.set} />
                </details>
              </>
            )}
          </div>
        </aside>
      </div>

      <section className="ed-dock">
        <div className="ed-resize" onPointerDown={resizeDock} title="Arrastra para cambiar la altura" />
        <Timeline handleRef={timelineRef} comp={comp} duration={duration} playhead={playhead} playing={playing}
          pxPerSec={pxPerSec} onZoom={setPxPerSec} selection={selection} onSelect={select} onSeek={seek}
          tool={tool} onTool={setTool} snap={snap} onSnap={setSnap}
          onTogglePlay={() => playerRef.current?.toggle()} onJump={jump}
          filmstrip={filmstrip} peaks={peaks}
          onTrim={onTrim} onMoveItem={onMoveItem} onReorder={onReorder} onMoveCut={onMoveCut} onAction={act}
          onEdit={onEdit} keyHint={(a) => keyHint(keymap, a)} onCompose={(fn, merge) => hist.set(fn, merge)} />
        <div className="ed-keys">
          <span><kbd>{keyHint(keymap, "play")}</kbd> reproducir</span>
          <span><kbd>{keyHint(keymap, "select_tool")}</kbd> mover</span>
          <span><kbd>{keyHint(keymap, "blade_tool")}</kbd> cuchilla</span>
          <span><kbd>{keyHint(keymap, "split")}</kbd> dividir</span>
          <span><kbd>{keyHint(keymap, "punch")}</kbd> zoom</span>
          <span><kbd>{keyHint(keymap, "marker")}</kbd> marcador</span>
          <span><kbd>{keyHint(keymap, "delete")}</kbd> borrar y juntar</span>
          <span><kbd>{keyHint(keymap, "prev_edit")}</kbd><kbd>{keyHint(keymap, "next_edit")}</kbd> saltar entre cortes y marcadores</span>
          <span><kbd>Ctrl</kbd>+rueda acercar</span>
          <span><kbd>{keyHint(keymap, "snap")}</kbd> imán</span>
          <button className="btn small ghost" onClick={() => setShowKeys(true)}>Atajos…</button>
          <span>Arrastra un tramo para cambiarlo de orden · clic derecho para más opciones</span>
        </div>
      </section>
      <CommandBar open={cmdOpen} onClose={() => setCmdOpen(false)} hint={keyHint(keymap, "command")}
        clipId={clipId} comp={comp} playhead={playhead} selection={agentSel} canUndo={hist.canUndo} onUndo={hist.undo} onApply={hist.set} onBusy={setAgentBusy} />
      {showKeys && <ShortcutsDialog map={keymap} onChange={setKeymap} onClose={() => setShowKeys(false)} />}
      {pasting && attrClip && (
        <PasteAttrsDialog groups={pasting.groups} from={attrClip.kind === "segment" ? "un tramo" : "una capa"}
          onPaste={doPaste} onClose={() => setPasting(null)} />
      )}
    </div>
  );
}
