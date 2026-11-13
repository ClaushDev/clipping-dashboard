import { X } from "@phosphor-icons/react";
import React, { useEffect, useRef, useState } from "react";
import { CAM_EASE_LABEL, EasePicker } from "./CurveEditor";
import VolumeKeys from "./VolumeKeys";
import { type Bezier, type CamEase, canvasSize, type Composition, containPlacement, type CropKey, cropAt, cropRect, type Layout, type Segment, SOURCE_CUT_LABEL, sourceCutsLocal } from "../remotion/schema";
import { defaultPanels } from "./ops";

/** Speaker = la cámara sigue a quien habla · cuts = solo marcar los cortes, transiciones y zooms del original. */
export type AutoframeMode = "face" | "duo" | "gaming" | "speaker" | "cuts";

interface Props {
  comp: Composition;
  index: number;
  /** Segundo dentro del tramo donde está el cursor (si está fuera, 0). */
  local: number;
  sourceUrl: string;
  /** Panel que se edita en pantalla dividida (lo elige también la línea de tiempo al pulsar un plano). */
  panel: number;
  onPanel: (i: number) => void;
  /** Ir a un plano (lo selecciona también en la línea de tiempo). panel -1 = sin pantalla dividida. */
  onPickShot: (panel: number, key: number) => void;
  onChange: (seg: Segment) => void;
  onAutoframe: (mode: AutoframeMode) => Promise<void>;
  /** Seguir lo que hay en (x, y) del original desde el segundo `t` del tramo. */
  onTrack?: (p: TrackPick) => Promise<void>;
}

export interface TrackPick { t: number; x: number; y: number; zoom: number; margin: number; smooth: number }
type Pos = { x: number; y: number; zoom: number };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const { hold: _hold, ...PAN_EASE_LABEL } = CAM_EASE_LABEL;

/** Paneo de A (el encuadre en el cursor) a B en `dur` segundos. Quita los planos que había por medio. */
export function panKeys(keys: CropKey[], t0: number, segLen: number, b: Pos, dur: number, ease: CamEase, bezier?: Bezier): CropKey[] {
  const a = cropAt(keys, t0);
  const t1 = +Math.min(segLen, t0 + Math.max(0.1, dur)).toFixed(3);
  const before = keys.filter((k) => k.t < t0 - 0.02);
  const after = keys.filter((k) => k.t > t1 + 0.02);
  const startAt0 = !before.length;
  const start: CropKey = { t: startAt0 ? 0 : +t0.toFixed(3), x: a.x, y: a.y, zoom: a.zoom, ease: "hold" };
  const end: CropKey = {
    t: t1, x: +b.x.toFixed(4), y: +b.y.toFixed(4), zoom: +b.zoom.toFixed(3), ease: ease === "hold" ? "ease" : ease,
    ...(ease === "custom" && bezier ? { bezier } : {}),
    // Sin plano antes del cursor, el primero va en 0 y la rampa dura solo lo pedido (CropKey.dur)
    ...(startAt0 && t0 > 0.02 ? { dur: +(t1 - t0).toFixed(3) } : {}),
  };
  return [...before, start, end, ...after];
}

const LAYOUTS: { value: Layout; label: string }[] = [
  { value: "crop", label: "Recortar (encuadre)" },
  { value: "split", label: "Pantalla dividida (paneles)" },
  { value: "fit_black", label: "Completo con bandas negras" },
  { value: "fit_blur", label: "Completo con fondo desenfocado" },
  { value: "fit_color", label: "Completo con fondo de color" },
];

/** Encuadre de un tramo: se arrastra el marco sobre el vídeo original y se guarda un punto clave en el cursor.
 *  En pantalla dividida, cada panel tiene su propio marco (con el formato de ese panel). */
export default function FramingPanel({ comp, index, local, sourceUrl, panel: panelIdx, onPanel: setPanelIdx, onPickShot, onChange, onAutoframe, onTrack }: Props) {
  const seg = comp.segments[index];
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<AutoframeMode | null>(null);
  // Herramienta de cámara activa en el marco: paneo A→B o seguir un punto
  const [tool, setTool] = useState<"pan" | "track" | null>(null);
  const [panB, setPanB] = useState<Pos>({ x: 0.5, y: 0.5, zoom: 1 });
  const [panDur, setPanDur] = useState(2);
  const [panEase, setPanEase] = useState<{ ease: Exclude<CamEase, "hold">; bezier?: Bezier }>({ ease: "ease" });
  const [trackOpt, setTrackOpt] = useState({ margin: 0.25, smooth: 0.5 });
  const [tracking, setTracking] = useState(false);
  const [outW, outH] = canvasSize(comp);
  const split = seg.layout === "split" && !!seg.panels?.length;
  const panel = split ? seg.panels![Math.min(panelIdx, seg.panels!.length - 1)] : null;

  // Puntos clave que se editan (los del tramo o los del panel elegido) y tamaño del hueco que rellenan.
  const keys = panel ? panel.keys : seg.keys;
  const boxH = panel ? outH * panel.h : outH;
  const setKeys = (next: CropKey[]) => {
    if (!panel) return onChange({ ...seg, keys: next });
    onChange({ ...seg, panels: seg.panels!.map((p) => (p === panel ? { ...p, keys: next } : p)) });
  };
  const k = cropAt(keys, local);
  // Plano en el que está el cursor (el último corte antes de él). Mover el marco o el zoom cambia ese plano entero;
  // Los planos nuevos se crean cortando (S o la cuchilla en la pista «Cámara»).
  const shot = keys.reduce((acc, key, i) => (key.t <= local + 0.02 ? i : acc), 0);
  const patchShot = (base: CropKey[], patch: Partial<CropKey>) =>
    base.length ? base.map((kk, i) => (i === shot ? { ...kk, ...patch } : kk)) : [{ t: 0, x: 0.5, y: 0.5, zoom: 1, ease: "hold" as const, ...patch }];
  const contain = panel?.fit === "contain";
  // Zona del original que se ve en el panel (para dibujar el marco).
  const r = contain
    ? (() => {
        const v = containPlacement(seg.src_w, seg.src_h, outW, boxH, k).visible;
        return { left: v.x0 * seg.src_w, top: v.y0 * seg.src_h, width: (v.x1 - v.x0) * seg.src_w, height: (v.y1 - v.y0) * seg.src_h };
      })()
    : cropRect(seg.src_w, seg.src_h, outW, boxH, k);

  useEffect(() => {
    const v = videoRef.current;
    if (v && Math.abs(v.currentTime - (seg.src_in + local)) > 0.05) v.currentTime = seg.src_in + local;
  }, [seg.src_in, local, seg.layout]);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = boxRef.current!.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseKeys = keys;
    const kx = keys[shot]?.x ?? k.x;
    const ky = keys[shot]?.y ?? k.y;
    const move = (ev: PointerEvent) => {
      const nx = Math.min(1, Math.max(0, kx + (ev.clientX - startX) / box.width));
      const ny = Math.min(1, Math.max(0, ky + (ev.clientY - startY) / box.height));
      setKeys(patchShot(baseKeys, { x: +nx.toFixed(4), y: +ny.toFixed(4) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Arrastra un punto (0-1) sobre el original: el marco B del paneo. */
  const dragPos = (e: React.PointerEvent, from: { x: number; y: number }, apply: (x: number, y: number) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const box = boxRef.current!.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) =>
      apply(+clamp01(from.x + (ev.clientX - sx) / box.width).toFixed(4), +clamp01(from.y + (ev.clientY - sy) / box.height).toFixed(4));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const segLen = seg.src_out - seg.src_in;
  const openPan = () => {
    // B empieza a un lado de A, hacia donde hay más sitio
    setPanB({ x: +clamp01(k.x + (k.x < 0.5 ? 0.3 : -0.3)).toFixed(4), y: k.y, zoom: k.zoom });
    setPanDur(Math.min(2, Math.max(0.1, +(segLen - local).toFixed(1))));
    setTool("pan");
  };
  const rB = cropRect(seg.src_w, seg.src_h, outW, boxH, panB);
  // Velocidad: cuánto se mueve el centro, en anchos del encuadre por segundo
  const panSpeed = Math.hypot((panB.x - k.x) * seg.src_w, (panB.y - k.y) * seg.src_h) / Math.max(r.width, 1) / Math.max(panDur, 0.1);

  const pickTrack = async (e: React.MouseEvent) => {
    if (!onTrack || tracking) return;
    const box = boxRef.current!.getBoundingClientRect();
    const x = +clamp01((e.clientX - box.left) / box.width).toFixed(4);
    const y = +clamp01((e.clientY - box.top) / box.height).toFixed(4);
    setTracking(true);
    try {
      await onTrack({ t: +local.toFixed(3), x, y, zoom: k.zoom, ...trackOpt });
      setTool(null);
    } finally {
      setTracking(false);
    }
  };

  const auto = async (mode: AutoframeMode) => {
    setBusy(mode);
    try {
      await onAutoframe(mode);
    } finally {
      setBusy(null);
    }
  };

  const setTopHeight = (h: number) => {
    if (!seg.panels || seg.panels.length < 2) return;
    const [a, b, ...rest] = seg.panels;
    onChange({ ...seg, panels: [{ ...a, y: 0, h }, { ...b, y: h, h: 1 - h }, ...rest] });
  };

  const keyHere = keys[shot];
  const srcLocal = sourceCutsLocal({ ...seg, speed: 1 });
  const srcCutAt = (t: number) => srcLocal.find((c) => Math.abs(c.at - t) < 0.06);
  const editable = seg.layout === "crop" || split;

  return (
    <div className="stack">
      <label className="field">
        Cómo se muestra este tramo
        <select value={seg.layout} onChange={(e) => {
          const layout = e.target.value as Layout;
          onChange({ ...seg, layout, panels: layout === "split" ? seg.panels ?? defaultPanels() : seg.panels });
        }}>
          {LAYOUTS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </label>
      {seg.note && <div className="small muted">Elegido automáticamente: {seg.note}.</div>}
      {seg.layout === "fit_color" && (
        <label className="field">
          Color de fondo
          <input type="color" value={seg.bg_color ?? "#111111"} onChange={(e) => onChange({ ...seg, bg_color: e.target.value })} />
        </label>
      )}

      <div className="row">
        <button className="btn small" disabled={busy !== null} onClick={() => auto("face")}>{busy === "face" ? "Buscando…" : "Seguir cara"}</button>
        <button className="btn small" disabled={busy !== null} onClick={() => auto("duo")}>{busy === "duo" ? "Buscando…" : "Detectar podcast a dos"}</button>
        <button className="btn small" disabled={busy !== null} onClick={() => auto("gaming")}>{busy === "gaming" ? "Buscando…" : "Detectar cámara + gameplay"}</button>
        <button className="btn small" disabled={busy !== null} onClick={() => auto("speaker")}
          title="Escucha quién habla (diarización local) y mira qué boca se mueve: la cámara va a esa persona. Tarda alrededor de 1 s por cada segundo del tramo.">
          {busy === "speaker" ? "Escuchando…" : "Seguir a quien habla"}</button>
        <button className="btn small" disabled={busy !== null} onClick={() => auto("cuts")}
          title="Busca los cortes, transiciones y zooms que ya trae el vídeo original y pone un corte de cámara en cada uno, con el mismo encuadre.">
          {busy === "cuts" ? "Buscando…" : "Marcar cortes del original"}</button>
      </div>
      {seg.source_cuts && (
        <div className="small muted">
          {seg.source_cuts.length
            ? <>El vídeo original trae {cutSummary(seg)} en este tramo: van marcados con <span className="src-cut-dot" /> en la pista «Cámara».</>
            : "El vídeo original no trae cortes, transiciones ni zooms en este tramo."}
        </div>
      )}

      {split && seg.panels && (
        <>
          <div className="tabs">
            {seg.panels.map((p, i) => (
              <button key={i} className={panelIdx === i ? "on" : ""} onClick={() => setPanelIdx(i)}>{p.label || `Panel ${i + 1}`}</button>
            ))}
          </div>
          {panel && (
            <label className="field">
              Ajuste del panel
              <select value={panel.fit ?? "cover"} onChange={(e) => onChange({ ...seg, panels: seg.panels!.map((p) => (p === panel ? { ...p, fit: e.target.value as "cover" | "contain" } : p)) })}>
                <option value="cover">Rellenar (recorta para llenar el panel)</option>
                <option value="contain">Ajustar (se ve más escena, fondo desenfocado)</option>
              </select>
            </label>
          )}
          {seg.panels.length >= 2 && (
            <label className="field">
              Alto del panel superior: {Math.round(seg.panels[0].h * 100)} %
              <input type="range" min={0.25} max={0.6} step={0.01} value={seg.panels[0].h} onChange={(e) => setTopHeight(Number(e.target.value))} />
            </label>
          )}
        </>
      )}

      {editable && (
        <>
          <div className="shot-head">
            <strong>{split ? `${panel?.label || `Panel ${panelIdx + 1}`} · ` : ""}Plano {shot + 1} de {keys.length}</strong>
            <span className="small muted">
              El marco y el zoom cambian todo este plano. Para un plano nuevo, corta con la tecla de dividir o la cuchilla en la pista «Cámara».
            </span>
          </div>
          <div className="framing" ref={boxRef} style={{ aspectRatio: `${seg.src_w} / ${seg.src_h}` }}>
            <video ref={videoRef} src={sourceUrl} muted preload="auto" playsInline />
            <div className="framing-shade" />
            <div className="framing-rect" onPointerDown={startDrag}
              style={{
                left: `${(r.left / seg.src_w) * 100}%`, top: `${(r.top / seg.src_h) * 100}%`,
                width: `${(r.width / seg.src_w) * 100}%`, height: `${(r.height / seg.src_h) * 100}%`,
              }}>{tool === "pan" && <span className="framing-tag">A</span>}</div>
            {tool === "pan" && (
              <>
                <svg className="framing-path" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                  <line x1={k.x * 100} y1={k.y * 100} x2={panB.x * 100} y2={panB.y * 100} />
                </svg>
                <div className="framing-rect b" title="Arrastra: dónde acaba el paneo"
                  onPointerDown={(e) => dragPos(e, panB, (x, y) => setPanB((p) => ({ ...p, x, y })))}
                  style={{
                    left: `${(rB.left / seg.src_w) * 100}%`, top: `${(rB.top / seg.src_h) * 100}%`,
                    width: `${(rB.width / seg.src_w) * 100}%`, height: `${(rB.height / seg.src_h) * 100}%`,
                  }}><span className="framing-tag">B</span></div>
              </>
            )}
            {tool === "track" && (
              <div className={`framing-pick ${tracking ? "busy" : ""}`} onClick={(e) => void pickTrack(e)} title="Clic en lo que quieres seguir">
                {tracking && <span className="framing-pick-msg">Siguiendo… (unos {Math.max(5, Math.round(Math.min(60, segLen - local) * 2.5))} s)</span>}
              </div>
            )}
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button className={`btn small ${tool === "pan" ? "primary" : ""}`} disabled={tracking} onClick={() => (tool === "pan" ? setTool(null) : openPan())}
              title="Movimiento de cámara desde el encuadre del cursor (A) hasta otro (B)">Paneo A → B</button>
            {onTrack && !split && (
              <button className={`btn small ${tool === "track" ? "primary" : ""}`} disabled={tracking} onClick={() => setTool(tool === "track" ? null : "track")}
                title="Haz clic en algo del vídeo (una pelota, una mano, un coche) y la cámara lo sigue desde el cursor (SAM 2.1, en la GPU)">
                Seguir un punto</button>
            )}
          </div>
          {tool === "pan" && (
            <div className="card inset stack" style={{ gap: 8 }}>
              <span className="small muted">A es el encuadre en el cursor ({local.toFixed(1)} s). Arrastra B hasta donde acaba el movimiento.</span>
              <label className="field">
                Duración: {panDur.toFixed(1)} s · {panSpeed.toFixed(2)} encuadres por segundo
                <input type="range" min={0.1} max={Math.max(0.2, +(segLen - local).toFixed(1))} step={0.1} value={panDur}
                  onChange={(e) => setPanDur(Number(e.target.value))} />
              </label>
              <label className="field">
                Zoom en B: {panB.zoom.toFixed(2)}×
                <input type="range" min={1} max={6} step={0.05} value={panB.zoom} onChange={(e) => setPanB((p) => ({ ...p, zoom: Number(e.target.value) }))} />
              </label>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <span className="small">Suavidad</span>
                <EasePicker ease={panEase.ease} bezier={panEase.bezier} labels={PAN_EASE_LABEL} onChange={(ease, bezier) => setPanEase({ ease, bezier })} />
              </div>
              <div className="row">
                <button className="btn small primary" disabled={segLen - local < 0.1}
                  onClick={() => { setKeys(panKeys(keys, local, segLen, panB, panDur, panEase.ease, panEase.bezier)); setTool(null); }}>Aplicar paneo</button>
                <button className="btn small ghost" onClick={() => setTool(null)}>Cancelar</button>
              </div>
            </div>
          )}
          {tool === "track" && (
            <div className="card inset stack" style={{ gap: 8 }}>
              <span className="small muted">Haz clic en el marco, sobre lo que quieres seguir. Se sigue desde el cursor ({local.toFixed(1)} s) hasta el
                final del tramo o hasta que se pierde de vista; quedan puntos clave que puedes retocar.</span>
              <label className="field" title="Cuánto sitio se deja entre el objeto y el borde del encuadre">
                Margen: {Math.round(trackOpt.margin * 100)} %
                <input type="range" min={0} max={0.45} step={0.01} value={trackOpt.margin} onChange={(e) => setTrackOpt((o) => ({ ...o, margin: Number(e.target.value) }))} />
              </label>
              <label className="field" title="Inercia de la cámara: más = se mueve más despacio y sin tirones">
                Suavizado: {Math.round(trackOpt.smooth * 100)} %
                <input type="range" min={0} max={1} step={0.05} value={trackOpt.smooth} onChange={(e) => setTrackOpt((o) => ({ ...o, smooth: Number(e.target.value) }))} />
              </label>
            </div>
          )}
          <label className="field">
            Zoom: {k.zoom.toFixed(2)}×
            <input type="range" min={1} max={6} step={0.05} value={k.zoom}
              onChange={(e) => setKeys(patchShot(keys, { zoom: Number(e.target.value) }))} />
          </label>
          <div className="row">
            <button className="btn small" onClick={() => setKeys(patchShot(keys, { x: 0.5, y: 0.5 }))}>Centrar el plano</button>
            <button className="btn small" onClick={() => setKeys([{ t: 0, x: k.x, y: k.y, zoom: k.zoom, ease: "hold" }])}>Encuadre fijo</button>
          </div>
          <div className="field">
            Planos ({keys.length})
            <div className="keys">
              {keys.map((key, i) => (
                <div key={i} className={`key-row ${keyHere === key ? "on" : ""}`} onClick={() => onPickShot(split ? panelIdx : -1, i)}
                  title="Ir a este plano">
                  <span>{i + 1} · {key.t.toFixed(1)} s{key.label ? ` · ${key.label}` : ""}
                    {i > 0 && srcCutAt(key.t) && <span className="src-cut-tag" title={SOURCE_CUT_LABEL[srcCutAt(key.t)!.kind]}>original</span>}</span>
                  <span className="muted">x {key.x.toFixed(2)} · zoom {key.zoom.toFixed(2)}</span>
                  {i > 0
                    ? <EasePicker ease={key.ease ?? "hold"} bezier={key.bezier} labels={CAM_EASE_LABEL}
                        onChange={(e, bz) => setKeys(keys.map((kk, j) => (j === i ? { ...kk, ease: e, bezier: bz } : kk)))} />
                    : <span className="grow small muted">Inicio</span>}
                  <button className="btn small icon ghost" disabled={i === 0} aria-label="Quitar este corte" title="Quitar este corte (se une al plano anterior)"
                    onClick={(e) => { e.stopPropagation(); setKeys(keys.filter((_, j) => j !== i)); }}><X size={13} /></button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

    </div>
  );
}

/** Sonido del tramo (mejorar voz y volumen del original), en la pestaña Audio del inspector. */
export function SegmentAudio({ comp, seg, local, cursorIn, onChange, onSeekLocal, onEnhanceVoice }: {
  comp: Composition; seg: Segment; local: number; cursorIn: boolean;
  onChange: (seg: Segment) => void; onSeekLocal?: (local: number) => void;
  /** Limpia la voz del archivo de este tramo con ese nivel y la pone en los tramos de ese archivo. */
  onEnhanceVoice?: (level: string) => Promise<void>;
}) {
  const [voiceBusy, setVoiceBusy] = useState(false);
  return (
    <div className="stack">
      <label className="field" title="Quita el ruido de fondo (viento, tráfico, zumbidos) y deja la voz más clara. Corre en tu PC (RNNoise); la primera vez tarda unos segundos por cada minuto del vídeo.">
        Mejorar voz{voiceBusy ? " · limpiando…" : ""}
        <select value={seg.voice?.level ?? ""} disabled={voiceBusy || !onEnhanceVoice} onChange={async (e) => {
          const level = e.target.value;
          if (!level) return onChange({ ...seg, voice: undefined });
          setVoiceBusy(true);
          try {
            await onEnhanceVoice!(level);
          } finally {
            setVoiceBusy(false);
          }
        }}>
          <option value="">No</option>
          <option value="light">Suave (quita el ruido de fondo)</option>
          <option value="strong">Fuerte (ruido intenso)</option>
        </select>
      </label>
      <VolumeKeys label="Volumen del vídeo original" volume={seg.volume} keys={seg.vol_keys} t={cursorIn ? local : null}
        length={seg.src_out - seg.src_in} fps={comp.fps} onChange={(patch) => onChange({ ...seg, ...patch })} onSeek={onSeekLocal} />
    </div>
  );
}

/** «3 cortes y 1 zoom» */
function cutSummary(seg: Segment): string {
  const n = { cut: 0, transition: 0, zoom: 0 };
  for (const c of seg.source_cuts ?? []) n[c.kind]++;
  const parts = [
    n.cut && `${n.cut} ${n.cut === 1 ? "corte" : "cortes"}`,
    n.transition && `${n.transition} ${n.transition === 1 ? "transición" : "transiciones"}`,
    n.zoom && `${n.zoom} ${n.zoom === 1 ? "zoom" : "zooms"}`,
  ].filter(Boolean) as string[];
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}` : parts[0] ?? "";
}
