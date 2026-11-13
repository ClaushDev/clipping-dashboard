import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { GOOGLE_FONTS, SYSTEM_FONTS } from "../remotion/fonts";
import {
  type AudioTrack, canvasSize, type Composition, type CutoutMode, type Fx, type FxDir, type FxKind, type Overlay, type OverlayAnim, type OverlayLoop,
  type ShapeOverlay, TRANSITION_FX,
} from "../remotion/schema";
import type { Asset, SoundEffect } from "../types";
import BlockPanel from "./BlockPanel";
import BlockPicker from "./BlockPicker";
import CutoutPanel, { CUTOUT_LABEL, newCutout, placeAroundCutout } from "./CutoutPanel";
import GradePanel from "./GradePanel";
import KeyframesPanel from "./KeyframesPanel";
import VolumeKeys from "./VolumeKeys";
import MaskPanel from "./MaskPanel";
import TemplatePanel from "./TemplatePanel";
import FxMenu from "./FxMenu";
import { FX_PRESETS, newGraphic, TEMPLATES } from "./templates";
import type { Selection } from "./Timeline";
import {
  type CompUpdate, ANIM_LABEL, FX_GROUPS, FX_LABEL, LOOP_LABEL, nearestCut, newAdjust, newAudio, newBlock, newFx, newImage, newProgress, newSfx, newShape,
  newSticker, newText, newVideo, patchFx, removeFx, SHAPE_LABEL, STICKERS, addFxWithWhoosh, whooshFor,
} from "./ops";

const DIR_LABEL: Record<FxDir, string> = { left: "Izquierda", right: "Derecha", up: "Arriba", down: "Abajo" };
const FX_HINT: Partial<Record<FxKind, string>> = {
  pan: "Barre la imagen lentamente hacia un lado; útil en fotos y planos quietos.",
  drift: "Balanceo suave de cámara en mano: quita la sensación de imagen fija.",
  whip: "Transición: la imagen sale disparada y la siguiente entra con desenfoque. Va centrada en el corte.",
  slide: "Transición: empuja la imagen fuera y entra la siguiente desde el otro lado. Va centrada en el corte.",
  zoom_cut: "Transición: zoom que atraviesa el corte. Arrastra el punto para elegir el centro.",
  zoom_through: "Transición: se mete muy dentro del punto (un ojo, una pantalla, una puerta) y sale ya en el plano siguiente. Arrastra el punto.",
  blur: "Transición: el plano se desenfoca hasta el corte y el siguiente llega borroso y se aclara. La intensidad es el radio.",
  blur_zoom: "Transición: desenfoque con un zoom suave hacia el punto. Arrastra el punto para elegir el centro.",
  leak: "Transición: una fuga de luz de color cruza el plano y se enciende en el corte.",
  flash: "Destello en el corte: blanco o del color que elijas.",
};

interface Props {
  clipId: number;
  comp: Composition;
  duration: number;
  playhead: number;
  assets: Asset[];
  sounds: SoundEffect[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onChange: (c: CompUpdate) => void;
  onAssetsChanged: () => void;
  onSeek?: (t: number) => void;
  /** Capa cuya máscara se está dibujando a mano en la vista previa. */
  maskDraw?: string | null;
  onMaskDraw?: (id: string | null) => void;
  /** «library» = añadir cosas (sidebar izquierdo) · «props» = editar lo elegido (sidebar derecho) · sin él, todo. */
  mode?: "library" | "props";
}

/** Tamaño de un vídeo (para su proporción en la pista). */
function videoSize(url: string): Promise<[number, number]> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve([v.videoWidth, v.videoHeight]);
    v.onerror = () => resolve([1920, 1080]);
    v.src = url;
  });
}

export default function LayersPanel({ clipId, comp, duration, playhead, assets, sounds, selection, onSelect, onChange, onAssetsChanged, onSeek, maskDraw, onMaskDraw, mode }: Props) {
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [fxMenu, setFxMenu] = useState(false);
  useEffect(() => {
    if (!fxMenu) return;
    const close = () => setFxMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [fxMenu]);
  const [soundCat, setSoundCat] = useState("");
  const [soundQ, setSoundQ] = useState("");
  const [picker, setPicker] = useState(false);
  const [tracking, setTracking] = useState("");
  const [upError, setUpError] = useState("");
  const overlay = selection?.kind === "overlay" ? comp.overlays.find((o) => o.id === selection.id) : undefined;
  const audio = selection?.kind === "audio" ? comp.audio.find((a) => a.id === selection.id) : undefined;
  const fx = selection?.kind === "fx" ? (comp.fx ?? []).find((f) => f.id === selection.id) : undefined;
  const images = assets.filter((a) => a.kind === "image");
  const tracks = assets.filter((a) => a.kind === "audio");
  const videos = assets.filter((a) => a.kind === "video");
  const source = comp.segments[0];
  // Se lee el tamaño del vídeo (espera) y se añade sobre la composición de ahora, no sobre la de cuando se pidió
  const addVideo = async (url: string, size?: [number, number]) => {
    const dims = size ?? await videoSize(url);
    addOverlay(newVideo(url, dims, playhead, duration, comp));
  };
  const categories = useMemo(() => [...new Set(sounds.map((s) => s.category))], [sounds]);
  // Una carpeta por categoría, en el orden del catálogo (el pack va primero y en el orden de sus carpetas)
  const groups = useMemo(() => {
    const m = new Map<string, { category: string; pack: boolean; items: SoundEffect[] }>();
    for (const s of sounds) {
      const g = m.get(s.category) ?? { category: s.category, pack: false, items: [] };
      g.pack ||= s.source === "pack";
      g.items.push(s);
      m.set(s.category, g);
    }
    return [...m.values()].sort((a, b) => Number(b.pack) - Number(a.pack));
  }, [sounds]);
  // Buscador: sin acentos ni mayúsculas, por nombre o carpeta; con texto se abren las carpetas que tienen resultados
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = fold(soundQ.trim());
  const shownGroups = groups
    .filter((g) => !soundCat || g.category === soundCat)
    .map((g) => (q ? { ...g, items: g.items.filter((s) => fold(`${s.name} ${g.category}`).includes(q)) } : g))
    .filter((g) => g.items.length > 0);
  // Música: tus recursos de audio (súbelos en la biblioteca del editor)
  const trackLabel = (url: string) => `Música · ${tracks.find((a) => a.url === url)?.name ?? ""}`;
  const musicOptions = (
    <>
      {tracks.length > 0 && (
        <optgroup label="Tus recursos">{tracks.map((a) => <option key={a.url} value={a.url}>{a.name}</option>)}</optgroup>
      )}
    </>
  );

  const setOverlay = (patch: Partial<Overlay>) =>
    onChange({ ...comp, overlays: comp.overlays.map((o) => (o.id === overlay?.id ? ({ ...o, ...patch } as Overlay) : o)) });
  const setAudio = (patch: Partial<AudioTrack>) =>
    onChange({ ...comp, audio: comp.audio.map((a) => (a.id === audio?.id ? { ...a, ...patch } : a)) });
  const setFx = (patch: Partial<Fx>) => { if (fx) onChange(patchFx(comp, fx.id, patch)); };

  async function upload(input: HTMLInputElement, then: (url: string) => void) {
    const file = input.files?.[0];
    input.value = ""; // Así se puede volver a elegir el mismo archivo
    if (!file) return;
    setUpError("");
    try {
      const a = await api.uploadAsset(file);
      onAssetsChanged();
      then(a.url);
    } catch (e) {
      setUpError(e instanceof Error ? e.message : String(e)); // Antes, alert()
    }
  }

  // Funciones sobre la composición de ahora: también valen tras una espera (subir un archivo)
  const addOverlay = (o: Overlay) => {
    onChange((c) => ({ ...c, overlays: [...c.overlays, o] }));
    onSelect({ kind: "overlay", id: o.id });
  };
  const addAudio = (a: AudioTrack) => {
    onChange((c) => ({ ...c, audio: [...c.audio, a] }));
    onSelect({ kind: "audio", id: a.id });
  };
  const addPreset = (name: string) => {
    const made = FX_PRESETS[name].make(playhead).map((f) => ({ ...f, id: Math.random().toString(36).slice(2, 10), end: Math.min(f.end, duration) }));
    onChange({ ...comp, fx: [...(comp.fx ?? []), ...made] });
    onSelect({ kind: "fx", id: made[0].id });
  };
  const addFx = (kind: FxKind) => {
    const at = TRANSITION_FX.includes(kind) ? nearestCut(comp, playhead) ?? playhead : playhead;
    const f = newFx(kind, at, duration);
    onChange(addFxWithWhoosh(comp, f, sounds));
    onSelect({ kind: "fx", id: f.id });
  };
  /** Capa que sigue la cara más cercana o el punto donde está colocada. */
  async function follow(mode: "face" | "point") {
    if (!overlay) return;
    setTracking("Siguiendo…");
    try {
      const id = overlay.id;
      const r = await api.track(clipId, { composition: comp, start: overlay.start, end: overlay.end, mode, x: overlay.x, y: overlay.y });
      onChange((c) => ({ ...c, overlays: c.overlays.map((o) => (o.id === id ? ({ ...o, follow: r.follow } as Overlay) : o)) }));
      setTracking("");
    } catch (e) {
      setTracking(e instanceof Error ? e.message : String(e));
    }
  }
  const cutoutNearby = overlay && overlay.kind !== "cutout"
    ? comp.overlays.findIndex((x) => x.kind === "cutout" && x.start < overlay.end && overlay.start < x.end) : -1;
  const preview = (url: string) => { new Audio(url).play().catch(() => undefined); };

  const slider = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, fmt = (v: number) => v.toFixed(2)) => (
    <label className="field">
      {label}: {fmt(value)}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );
  const times = (start: number, end: number, set: (s: number, e: number) => void) => (
    <div className="grid-2">
      <label className="field">
        Empieza (s)
        <div className="row">
          <input type="number" step={0.1} min={0} value={start} onChange={(e) => set(Number(e.target.value), end)} style={{ flex: 1 }} />
          <button className="btn small" title="Poner en el cursor" onClick={() => set(+playhead.toFixed(2), Math.max(end, playhead + 0.5))}>⇤</button>
        </div>
      </label>
      <label className="field">
        Acaba (s)
        <div className="row">
          <input type="number" step={0.1} min={0} value={end} onChange={(e) => set(start, Number(e.target.value))} style={{ flex: 1 }} />
          <button className="btn small" title="Poner en el cursor" onClick={() => set(start, Math.max(start + 0.2, +playhead.toFixed(2)))}>⇥</button>
        </div>
      </label>
    </div>
  );
  const remove = (label: string, run: () => void) => (
    <button className="btn small danger" onClick={() => { run(); onSelect(null); }}>{label}</button>
  );

  return (
    <div className="stack">
      {mode !== "props" && (<>
      <div className="layer-add">
        <button className="btn small" onClick={() => addOverlay(newText(playhead, duration))}>+ Texto</button>
        <button className="btn small" onClick={() => setPicker(true)} title="Rótulos, títulos, gráficos, mapas… de HyperFrames">+ Bloque animado</button>
        <select className="small-select" value="" aria-label="Añadir señal" onChange={(e) => {
          if (e.target.value === "progress") addOverlay(newProgress(playhead, duration));
          else if (e.target.value) addOverlay(newShape(e.target.value as ShapeOverlay["shape"], playhead, duration));
        }}>
          <option value="">+ Señal…</option>
          {(Object.keys(SHAPE_LABEL) as ShapeOverlay["shape"][]).map((k) => <option key={k} value={k}>{SHAPE_LABEL[k]}</option>)}
          <option value="progress">Barra «espera…»</option>
        </select>
        <select className="small-select" value="" aria-label="Añadir plantilla" title="Checklist, titulares, curva, chat, móvil, revista, cristal"
          onChange={(e) => { if (e.target.value) addOverlay(newGraphic(e.target.value, playhead, duration)); }}>
          <option value="">+ Plantilla…</option>
          {Object.entries(TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
        </select>
        <button className="btn small" title="Capa de ajuste: look, LUT y corrección de color de lo que tiene debajo"
          onClick={() => addOverlay(newAdjust(playhead, duration))}>+ Ajuste de color</button>
        <select className="small-select" value="" aria-label="Añadir recorte" title="Efectos con el sujeto recortado (SAM 2)"
          onChange={(e) => { if (e.target.value) addOverlay(newCutout(e.target.value as CutoutMode, playhead, duration)); }}>
          <option value="">+ Recorte…</option>
          {(Object.keys(CUTOUT_LABEL) as CutoutMode[]).map((k) => <option key={k} value={k}>{CUTOUT_LABEL[k]}</option>)}
        </select>
        <span style={{ position: "relative", display: "inline-flex" }}>
          <button className="btn small" aria-expanded={fxMenu} onPointerDown={(e) => e.stopPropagation()} onClick={() => setFxMenu((v) => !v)}
            title="Zooms, transiciones y color. Pasa el ratón por cada uno para verlo">+ Efecto…</button>
          {fxMenu && (
            <FxMenu style={{ top: "calc(100% + 4px)", left: 0 }} groupNote={(g) => (g === "Transiciones" ? " · en el corte más cercano" : "")}
              onPick={(k) => { setFxMenu(false); addFx(k); }}
              extra={<>
                <div className="menu-label">Presets</div>
                {Object.entries(FX_PRESETS).map(([k, p]) => (
                  <button key={k} title={p.hint} onClick={() => { setFxMenu(false); addPreset(k); }}>{p.label}</button>
                ))}
              </>} />
          )}
        </span>
        <select className="small-select" value="" aria-label="Añadir imagen" onChange={(e) => { if (e.target.value === "__up") imageInput.current?.click(); else if (e.target.value) addOverlay(newImage(e.target.value, playhead, duration)); }}>
          <option value="">+ Imagen…</option>
          {images.map((a) => <option key={a.url} value={a.url}>{a.name}</option>)}
          <option value="__up">Subir imagen…</option>
        </select>
        <select className="small-select" value="" aria-label="Añadir vídeo" title="Clip en una pista de vídeo encima de la principal (V2, V3…)"
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__up") videoInput.current?.click();
            else if (v === "__src" && source) addVideo(source.src, [source.src_w, source.src_h]);
            else if (v) addVideo(v);
          }}>
          <option value="">+ Vídeo…</option>
          {source && <option value="__src">El vídeo original (otro momento)</option>}
          {videos.map((a) => <option key={a.url} value={a.url}>{a.name}</option>)}
          <option value="__up">Subir vídeo…</option>
        </select>
        <select className="small-select" value="" aria-label="Añadir música" onChange={(e) => {
          if (e.target.value === "__up") audioInput.current?.click();
          else if (e.target.value) addAudio({ ...newAudio(e.target.value), label: trackLabel(e.target.value) });
        }}>
          <option value="">+ Música…</option>
          {musicOptions}
          <option value="__up">Subir audio…</option>
        </select>
        <input ref={imageInput} type="file" accept="image/*" hidden onChange={(e) => upload(e.target, (u) => addOverlay(newImage(u, playhead, duration)))} />
        <input ref={videoInput} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={(e) => upload(e.target, (u) => void addVideo(u))} />
        <input ref={audioInput} type="file" accept="audio/*" hidden onChange={(e) => upload(e.target, (u) => addAudio(newAudio(u)))} />
      </div>
      {upError && <div className="notice error" role="alert">No se pudo subir: {upError}</div>}

      <details className="sound-picker">
        <summary>Stickers y emojis · entran con pop y se quedan flotando</summary>
        <div className="sticker-row">
          {STICKERS.map((e) => (
            <button key={e} title="Añadir en el cursor" onClick={() => addOverlay(newSticker(e, playhead, duration))}>{e}</button>
          ))}
        </div>
      </details>

      {picker && (
        <BlockPicker onClose={() => setPicker(false)} onPick={(b) => { setPicker(false); addOverlay(newBlock(b, playhead, duration, canvasSize(comp))); }} />
      )}

      <details className="sound-picker">
        <summary>Sonidos ({sounds.length}) · se añaden en el cursor</summary>
        <input type="search" className="sound-search" value={soundQ} placeholder="Buscar sonido…" aria-label="Buscar sonido"
          onChange={(e) => setSoundQ(e.target.value)} />
        <select className="small-select" value={soundCat} onChange={(e) => setSoundCat(e.target.value)} aria-label="Categoría">
          <option value="">Todas las carpetas</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </select>
        {/* Agrupados como en las carpetas originales: primero las de tu pack (en su orden), luego el resto */}
        {q && shownGroups.length === 0 && <div className="small muted">Ningún sonido con «{soundQ.trim()}».</div>}
        {shownGroups.map((g, gi, all) => (
          <div key={g.category}>
            {g.pack && (gi === 0 || !all[gi - 1].pack) && <div className="sound-group-title">Mi pack de sonidos</div>}
            {!g.pack && (gi === 0 || all[gi - 1].pack) && <div className="sound-group-title">Otros sonidos</div>}
            <details className="sound-folder" open={!!soundCat || !!q}>
              <summary>{g.category} <span className="small muted">({g.items.length})</span></summary>
              <div className="sound-list">
                {g.items.map((s) => (
                  <div key={s.id} className="sound-row">
                    <button className="btn small" title="Escuchar" onClick={() => preview(s.url)}>▶</button>
                    <span className="grow" title={s.license}>{s.name}</span>
                    <span className="small muted">{s.duration.toFixed(1)} s</span>
                    <button className="btn small" onClick={() => addAudio(newSfx(s.url, s.name, playhead, s.duration))}>Añadir</button>
                  </div>
                ))}
              </div>
            </details>
          </div>
        ))}
      </details>
      {mode === "library" && (
        <div className="small muted">Todo se añade en el cursor. Lo que añades se edita en el panel de la derecha.</div>
      )}
      </>)}

      {mode !== "library" && !overlay && !audio && !fx && (
        <div className="small muted">
          Elige una capa en la línea de tiempo o en «Capas» (a la izquierda) para editarla. Las señales y los textos también
          se arrastran sobre la vista previa.
        </div>
      )}
      {mode !== "library" && (<>

      {overlay && (
        <div className="card inset stack">
          {overlay.kind === "text" && (
            <>
              <label className="field">Texto<textarea value={overlay.text} onChange={(e) => setOverlay({ text: e.target.value })} /></label>
              <div className="grid-2">
                <label className="field">
                  Fuente
                  <select value={overlay.font} onChange={(e) => setOverlay({ font: e.target.value })}>
                    {[...GOOGLE_FONTS, ...SYSTEM_FONTS].map((f) => <option key={f}>{f}</option>)}
                  </select>
                </label>
                <label className="field">
                  Grosor
                  <select value={overlay.weight} onChange={(e) => setOverlay({ weight: Number(e.target.value) })}>
                    {[400, 700, 900].map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                </label>
                <label className="field">Color<input type="color" value={overlay.color} onChange={(e) => setOverlay({ color: e.target.value })} /></label>
                <label className="field">
                  Fondo
                  <div className="row">
                    <input type="checkbox" checked={!!overlay.bg} onChange={(e) => setOverlay({ bg: e.target.checked ? "#000000" : "" })} aria-label="Con fondo" />
                    {overlay.bg && <input type="color" value={overlay.bg} onChange={(e) => setOverlay({ bg: e.target.value })} />}
                  </div>
                </label>
              </div>
              {slider("Tamaño", overlay.size, 20, 220, 1, (v) => setOverlay({ size: v }), (v) => String(v))}
              <div className="grid-2">
                <label className="field">
                  Alineación
                  <select value={overlay.align ?? "center"} onChange={(e) => setOverlay({ align: e.target.value as "left" | "center" | "right" })}>
                    <option value="left">Izquierda</option>
                    <option value="center">Centro</option>
                    <option value="right">Derecha</option>
                  </select>
                </label>
                {!overlay.bg && <label className="field">Color del contorno
                  <input type="color" value={overlay.stroke_color || "#000000"} onChange={(e) => setOverlay({ stroke_color: e.target.value })} /></label>}
              </div>
              {!overlay.bg && slider("Contorno", overlay.stroke ?? 4, 0, 12, 0.5, (v) => setOverlay({ stroke: v }), (v) => String(v))}
              {!overlay.bg && slider("Sombra", overlay.shadow ?? 0, 0, 12, 0.5, (v) => setOverlay({ shadow: v }), (v) => String(v))}
            </>
          )}
          {overlay.kind === "image" && (
            <>
              <label className="field">
                Imagen
                <select value={overlay.src} onChange={(e) => setOverlay({ src: e.target.value })}>
                  {images.map((a) => <option key={a.url} value={a.url}>{a.name}</option>)}
                </select>
              </label>
              {slider("Opacidad", overlay.opacity, 0.1, 1, 0.05, (v) => setOverlay({ opacity: v }))}
            </>
          )}
          {overlay.kind === "shape" && (
            <>
              <div className="grid-2">
                <label className="field">
                  Forma
                  <select value={overlay.shape} onChange={(e) => setOverlay({ shape: e.target.value as ShapeOverlay["shape"] })}>
                    {(Object.keys(SHAPE_LABEL) as ShapeOverlay["shape"][]).map((k) => <option key={k} value={k}>{SHAPE_LABEL[k]}</option>)}
                  </select>
                </label>
                <label className="field">Color<input type="color" value={overlay.color} onChange={(e) => setOverlay({ color: e.target.value })} /></label>
              </div>
              {slider("Grosor del trazo", overlay.stroke, 4, 30, 1, (v) => setOverlay({ stroke: v }), (v) => String(v))}
              {(overlay.shape === "circle" || overlay.shape === "box") && slider("Alto", overlay.h, 0.03, 1, 0.01, (v) => setOverlay({ h: v }))}
              {overlay.shape === "arrow" && slider("Dirección (grados)", overlay.rotation, 0, 359, 1, (v) => setOverlay({ rotation: v }), (v) => `${v}°`)}
              {overlay.path?.length ? (
                <div className="row small muted">Sigue un objeto ({overlay.path.length} puntos). <button className="btn small" onClick={() => setOverlay({ path: undefined })}>Fijar</button></div>
              ) : null}
            </>
          )}
          {overlay.kind === "block" && (
            <BlockPanel o={overlay} images={images} canvas={canvasSize(comp)} onChange={(patch) => setOverlay(patch)} />
          )}
          {overlay.kind === "cutout" && (
            <CutoutPanel clipId={clipId} comp={comp} o={overlay} images={images} onPatch={(patch) => setOverlay(patch)} onChange={onChange} />
          )}
          {overlay.kind === "video" && (
            <>
              <div className="grid-2">
                <label className="field">
                  Pista
                  <select value={overlay.track} onChange={(e) => setOverlay({ track: Number(e.target.value) })}>
                    {[2, 3, 4, 5].map((n) => <option key={n} value={n}>V{n}{n === 2 ? " (justo encima del principal)" : ""}</option>)}
                  </select>
                </label>
                <label className="field">
                  Empieza en el vídeo (s)
                  <input type="number" step={0.1} min={0} value={overlay.src_in} onChange={(e) => setOverlay({ src_in: Math.max(0, Number(e.target.value)) })} />
                </label>
              </div>
              <label className="row small">
                <input type="checkbox" checked={!!overlay.fill} onChange={(e) => setOverlay({ fill: e.target.checked })} />
                Pantalla completa (plano de recurso que tapa el principal)
              </label>
              {slider("Opacidad", overlay.opacity, 0, 1, 0.05, (v) => setOverlay({ opacity: v }), (v) => `${Math.round(v * 100)} %`)}
              <VolumeKeys label="Volumen" volume={overlay.volume} keys={overlay.vol_keys} t={playhead - overlay.start}
                length={overlay.end - overlay.start} fps={comp.fps} onChange={(patch) => setOverlay(patch)} onSeek={(t) => onSeek?.(overlay.start + t)} />
              {!overlay.fill && (
                <div className="grid-2">
                  {slider("Esquinas", overlay.radius ?? 0, 0, 120, 2, (v) => setOverlay({ radius: v }), (v) => `${v}px`)}
                  <label className="field">
                    Borde
                    <div className="row">
                      <input type="checkbox" checked={!!overlay.border} aria-label="Con borde" onChange={(e) => setOverlay({ border: e.target.checked ? "#ffffff" : undefined })} />
                      {overlay.border && <input type="color" value={overlay.border} onChange={(e) => setOverlay({ border: e.target.value })} />}
                    </div>
                  </label>
                </div>
              )}
            </>
          )}
          {overlay.kind === "adjust" && <GradePanel o={overlay} onPatch={(patch) => setOverlay(patch)} />}
          {overlay.kind !== "cutout" && overlay.kind !== "shape" && overlay.kind !== "progress" && (
            <MaskPanel o={overlay} hasMatte={comp.segments.some((s) => s.matte) || comp.scenes.some((s) => s.matte)}
              drawing={maskDraw === overlay.id} onPatch={(patch) => setOverlay(patch)} onDraw={(on) => onMaskDraw?.(on ? overlay.id : null)} />
          )}
          {overlay.kind === "graphic" && <TemplatePanel o={overlay} images={images} onChange={(patch) => setOverlay(patch)} />}
          {overlay.kind === "progress" && (
            <div className="grid-2">
              <label className="field">Texto<input type="text" value={overlay.text} onChange={(e) => setOverlay({ text: e.target.value })} /></label>
              <label className="field">Color de la barra<input type="color" value={overlay.color} onChange={(e) => setOverlay({ color: e.target.value })} /></label>
            </div>
          )}
          {cutoutNearby >= 0 && (
            <label className="row small">
              <input type="checkbox" checked={comp.overlays.findIndex((x) => x.id === overlay.id) < cutoutNearby}
                onChange={(e) => onChange(placeAroundCutout(comp, overlay, e.target.checked))} />
              Detrás del sujeto recortado
            </label>
          )}
          {(overlay.kind === "text" || overlay.kind === "image" || overlay.kind === "graphic") && (
            <div className="row small">
              {overlay.follow?.length ? (
                <>
                  <span className="grow muted">Sigue {overlay.follow.length} puntos del vídeo.</span>
                  <button className="btn small" onClick={() => setOverlay({ follow: undefined })}>Fijar</button>
                </>
              ) : (
                <>
                  <span className="grow muted" title="Coloca la capa donde quieras (encima de la cabeza, al lado…) y se moverá con lo que hay debajo">{tracking || "Pegar al vídeo:"}</span>
                  <button className="btn small" disabled={tracking === "Siguiendo…"} onClick={() => follow("face")}>Seguir cara</button>
                  <button className="btn small" disabled={tracking === "Siguiendo…"} onClick={() => follow("point")}>Seguir punto</button>
                </>
              )}
            </div>
          )}
          {overlay.kind !== "cutout" && (
            <KeyframesPanel o={overlay} playhead={playhead} fps={comp.fps} onPatch={(patch) => setOverlay(patch)} onSeek={onSeek} />
          )}
          <div className="grid-2" style={(overlay.kind === "cutout" && overlay.mode !== "escape" && overlay.mode !== "portal") || overlay.keys?.length || overlay.kind === "adjust" || (overlay.kind === "video" && overlay.fill) ? { display: "none" } : undefined}>
            {slider(overlay.kind === "shape" && overlay.shape === "arrow" ? "Punta X" : "Posición X", overlay.x, 0, 1, 0.01, (v) => setOverlay({ x: v }))}
            {slider(overlay.kind === "shape" && overlay.shape === "arrow" ? "Punta Y" : "Posición Y", overlay.y, 0, 1, 0.01, (v) => setOverlay({ y: v }))}
          </div>
          {(overlay.kind !== "cutout" || ["escape", "portal", "orbit"].includes(overlay.mode)) && overlay.kind !== "adjust" && !(overlay.kind === "video" && overlay.fill) && slider(
            overlay.kind === "shape" && overlay.shape === "arrow" ? "Largo" : overlay.kind === "graphic" ? "Tamaño (1 = pantalla completa)"
              : overlay.kind === "cutout" ? (overlay.mode === "orbit" ? "Cuánto gira" : overlay.mode === "portal" ? "Tamaño del portal" : "Tamaño del marco") : "Ancho",
            overlay.w, 0.05, 1, 0.01, (v) => setOverlay({ w: v }))}
          {times(overlay.start, overlay.end, (s, e) => setOverlay({ start: Math.max(0, s), end: Math.min(duration, Math.max(s + 0.2, e)) }))}
          {/* Las plantillas traen su propia entrada */}
          <div className="grid-2" style={overlay.kind === "graphic" || overlay.kind === "cutout" ? { display: "none" } : undefined}>
            <label className="field">
              Entrada
              <select value={overlay.anim} onChange={(e) => setOverlay({ anim: e.target.value as OverlayAnim })}>
                {overlay.kind === "adjust" ? (
                  <>
                    <option value="none">De golpe</option>
                    <option value="fade">Fundido de entrada y salida</option>
                  </>
                ) : overlay.kind === "shape" ? (
                  <>
                    <option value="draw">Se dibuja</option>
                    <option value="pop">Pop</option>
                    <option value="fade">Fundido</option>
                    <option value="none">Ninguna</option>
                  </>
                ) : (Object.keys(ANIM_LABEL) as (keyof typeof ANIM_LABEL)[])
                  .filter((k) => overlay.kind === "text" || (k !== "count" && k !== "type"))
                  .map((k) => <option key={k} value={k}>{ANIM_LABEL[k]}</option>)}
              </select>
            </label>
            {(overlay.kind === "text" || overlay.kind === "image") && (
              <label className="field">
                Mientras se ve
                <select value={overlay.loop ?? "none"} onChange={(e) => setOverlay({ loop: e.target.value as OverlayLoop })}>
                  {(Object.keys(LOOP_LABEL) as OverlayLoop[]).map((k) => <option key={k} value={k}>{LOOP_LABEL[k]}</option>)}
                </select>
              </label>
            )}
          </div>
          {overlay.kind === "text" && overlay.anim === "count" && !/\d/.test(overlay.text) && (
            <div className="small muted">«Números que cuentan» necesita una cifra en el texto (por ejemplo «$5,000» o «90 %»).</div>
          )}
          {(overlay.kind === "text" || overlay.kind === "image") && !overlay.keys?.length &&
            slider("Giro", overlay.rot ?? 0, -45, 45, 1, (v) => setOverlay({ rot: v }), (v) => `${v}°`)}
          <div className="row">
            <span className="grow" />
            <span>{remove("Borrar capa", () => onChange({ ...comp, overlays: comp.overlays.filter((o) => o.id !== overlay.id) }))}</span>
          </div>
        </div>
      )}

      {fx && (
        <div className="card inset stack">
          <label className="field">
            Efecto
            <select value={fx.kind} onChange={(e) => setFx({ kind: e.target.value as FxKind })}>
              {FX_GROUPS.map(([g, kinds]) => (
                <optgroup key={g} label={g}>{kinds.map((k) => <option key={k} value={k}>{FX_LABEL[k]}</option>)}</optgroup>
              ))}
            </select>
          </label>
          {FX_HINT[fx.kind] && <div className="small muted">{FX_HINT[fx.kind]}</div>}
          {slider("Intensidad", fx.amount, 0.05, fx.kind === "punch" || fx.kind === "zoom" || fx.kind === "pan" ? 1 : 1.5, 0.05, (v) => setFx({ amount: v }))}
          {(fx.kind === "pan" || fx.kind === "whip" || fx.kind === "slide") && (
            <label className="field">
              Hacia
              <select value={fx.dir ?? (fx.kind === "pan" ? "right" : "left")} onChange={(e) => setFx({ dir: e.target.value as FxDir })}>
                {(Object.keys(DIR_LABEL) as FxDir[]).map((d) => <option key={d} value={d}>{DIR_LABEL[d]}</option>)}
              </select>
            </label>
          )}
          {fx.kind === "zoom" && slider("Saltos (1 = continuo; 3 = zoom digital)", fx.steps ?? 1, 1, 6, 1, (v) => setFx({ steps: v > 1 ? v : undefined }), (v) => String(v))}
          {(fx.kind === "punch" || fx.kind === "zoom" || fx.kind === "zoom_cut" || fx.kind === "zoom_through" || fx.kind === "blur_zoom") && (
            <div className="grid-2">
              {slider("Hacia X", fx.x, 0, 1, 0.01, (v) => setFx({ x: v }))}
              {slider("Hacia Y", fx.y, 0, 1, 0.01, (v) => setFx({ y: v }))}
            </div>
          )}
          {(fx.kind === "flash" || fx.kind === "leak") && (
            <label className="field">
              Color de la luz
              <input type="color" value={fx.color || (fx.kind === "flash" ? "#ffffff" : "#ff9a3c")} onChange={(e) => setFx({ color: e.target.value })} />
            </label>
          )}
          {times(fx.start, fx.end, (s, e) => setFx({ start: Math.max(0, s), end: Math.min(duration, Math.max(s + 0.1, e)) }))}
          {TRANSITION_FX.includes(fx.kind) && (
            <div className="stack" style={{ gap: 4 }}>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={!!fx.whoosh && comp.audio.some((a) => a.id === fx.whoosh)} onChange={(e) => {
                  if (e.target.checked) {
                    const a = whooshFor(fx, sounds);
                    if (a) onChange((c) => ({ ...c, audio: [...c.audio, a], fx: (c.fx ?? []).map((f) => (f.id === fx.id ? { ...f, whoosh: a.id } : f)) }));
                  } else {
                    onChange((c) => ({ ...c, audio: c.audio.filter((a) => a.id !== fx.whoosh), fx: (c.fx ?? []).map((f) => (f.id === fx.id ? { ...f, whoosh: undefined } : f)) }));
                  }
                }} />
                Whoosh con esta transición
              </label>
              <label className="row small muted" style={{ gap: 6 }}>
                <input type="checkbox" checked={comp.auto_whoosh !== false} onChange={(e) => onChange((c) => ({ ...c, auto_whoosh: e.target.checked ? undefined : false }))} />
                Poner un whoosh al añadir transiciones en este proyecto
              </label>
              {!sounds.some((s) => /wh?oo?sh|swish|swoosh|zas/i.test(s.name) || s.intents?.includes("transicion")) && (
                <div className="small muted">No hay ningún whoosh en Sonidos: importa uno o créalo en «Buscar o crear».</div>
              )}
            </div>
          )}
          {remove("Quitar efecto", () => onChange(removeFx(comp, [fx.id])))}
        </div>
      )}

      {audio && (
        <div className="card inset stack">
          {audio.kind === "sfx" ? (
            <label className="field">
              Sonido
              <select value={audio.src} onChange={(e) => {
                const s = sounds.find((x) => x.url === e.target.value);
                setAudio({ src: e.target.value, label: s?.name, ...(s?.duration ? { duration: +s.duration.toFixed(2) } : {}) });
              }}>
                {!sounds.some((s) => s.url === audio.src) && <option value={audio.src}>{audio.label || audio.src.split("/").pop()}</option>}
                {sounds.map((s) => <option key={s.id} value={s.url}>{s.category} · {s.name}</option>)}
              </select>
            </label>
          ) : audio.kind !== "voice" && audio.id !== "narration" ? (
            <label className="field">
              Pista
              <select value={audio.src} onChange={(e) => setAudio({ src: e.target.value, label: trackLabel(e.target.value) })}>
                {!tracks.some((a) => a.url === audio.src) && (
                  <option value={audio.src}>{audio.label || audio.src.split("/").pop()}</option>
                )}
                {musicOptions}
              </select>
            </label>
          ) : <div className="small muted">Voz en off del vídeo.</div>}
          <VolumeKeys label="Volumen" volume={audio.volume} keys={audio.vol_keys} t={playhead - audio.start}
            length={audio.duration > 0 ? audio.duration : Math.max(0, duration - audio.start)} fps={comp.fps}
            onChange={(patch) => setAudio(patch)} onSeek={(t) => onSeek?.(audio.start + t)} />
          {audio.kind !== "voice" && audio.id !== "narration" && (
            <label className="field">
              Bajar bajo la voz (ducking)
              <select value={audio.duck ?? 0} onChange={(e) => setAudio({ duck: Number(e.target.value) })}>
                <option value={0}>No</option>
                <option value={0.5}>Un poco (al 50 %)</option>
                <option value={0.35}>Bastante (al 35 %)</option>
                <option value={0.15}>Mucho (al 15 %)</option>
              </select>
            </label>
          )}
          <div className="grid-2">
            <label className="field">Empieza en el vídeo (s)<input type="number" step={0.1} min={0} value={audio.start} onChange={(e) => setAudio({ start: Math.max(0, Number(e.target.value)) })} /></label>
            <label className="field">Empezar la pista en (s)<input type="number" step={0.5} min={0} value={audio.src_in} onChange={(e) => setAudio({ src_in: Math.max(0, Number(e.target.value)) })} /></label>
            <label className="field">Fundido de entrada (s)<input type="number" step={0.1} min={0} value={audio.fade_in} onChange={(e) => setAudio({ fade_in: Math.max(0, Number(e.target.value)) })} /></label>
            <label className="field">Fundido de salida (s)<input type="number" step={0.1} min={0} value={audio.fade_out} onChange={(e) => setAudio({ fade_out: Math.max(0, Number(e.target.value)) })} /></label>
          </div>
          {audio.kind === "music" && (
            <div className="small muted">
              Usa solo música con licencia para redes: súbela como recurso de audio en la biblioteca del editor.
            </div>
          )}
          {remove(audio.kind === "sfx" ? "Quitar sonido" : "Quitar pista", () => onChange({ ...comp, audio: comp.audio.filter((a) => a.id !== audio.id) }))}
        </div>
      )}
      </>)}
    </div>
  );
}
