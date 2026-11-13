import { Plus, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import type { Angle, Composition } from "../remotion/schema";
import type { Asset } from "../types";
import type { CompUpdate } from "./ops";

interface Props {
  comp: Composition;
  index: number;
  assets: Asset[];
  onChange: (c: CompUpdate) => void;
  /** Texto del atajo que cambia de ángulo. */
  hint: string;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const LETTERS = "BCDEFGH";

function videoSize(url: string): Promise<[number, number]> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve([v.videoWidth, v.videoHeight]);
    v.onerror = () => reject(new Error("No se pudo leer el vídeo"));
    v.src = url;
  });
}

/** Multicámara. Pistas de vídeo extra (la misma grabación con otro encuadre, u otro archivo sincronizado) y cuál se
 *  ve en el tramo elegido. En la línea de tiempo cada ángulo tiene su pista: clic en un tramo para verlo desde ahí. */
export default function AnglesPanel({ comp, index, assets, onChange, hint }: Props) {
  const seg = comp.segments[index];
  const angles = comp.angles ?? [];
  const [pick, setPick] = useState("");
  const [err, setErr] = useState("");
  if (!seg) return null;
  const nextLabel = `Ángulo ${LETTERS[angles.length] ?? angles.length + 2}`;

  const add = (a: Angle) => onChange((c) => ({
    ...c, angles: [...(c.angles ?? []), a],
    // El tramo elegido pasa a verse desde el ángulo nuevo: así se ve enseguida qué hace
    segments: c.segments.map((s, i) => (i === index ? { ...s, angle: a.id } : s)),
  }));
  const patch = (id: string, p: Partial<Angle>) => onChange((c) => ({ ...c, angles: (c.angles ?? []).map((a) => (a.id === id ? { ...a, ...p } : a)) }));
  const remove = (id: string) => onChange((c) => {
    const rest = (c.angles ?? []).filter((a) => a.id !== id);
    return { ...c, angles: rest.length ? rest : undefined, segments: c.segments.map((s) => (s.angle === id ? { ...s, angle: undefined } : s)) };
  });
  const show = (id: string | undefined) => onChange((c) => ({ ...c, segments: c.segments.map((s, i) => (i === index ? { ...s, angle: id } : s)) }));

  async function addFile() {
    const asset = assets.find((a) => a.url === pick);
    if (!asset) return;
    setErr("");
    try {
      const [w, h] = await videoSize(asset.url);
      add({ id: uid(), label: nextLabel, src: asset.url, src_w: w, src_h: h, offset: 0, zoom: 1, x: 0.5, y: 0.5 });
      setPick("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const videos = assets.filter((a) => a.kind === "video");
  return (
    <div className="stack">
      {angles.length > 0 && (
        <div className="field">
          Se ve en este tramo
          <div className="seg-toggle" role="radiogroup" aria-label="Ángulo del tramo">
            <button role="radio" aria-checked={!seg.angle} className={!seg.angle ? "on" : ""} onClick={() => show(undefined)}>A · principal</button>
            {angles.map((a) => (
              <button key={a.id} role="radio" aria-checked={seg.angle === a.id} className={seg.angle === a.id ? "on" : ""} onClick={() => show(a.id)}>{a.label}</button>
            ))}
          </div>
          <span className="small muted">{hint ? `${hint} cambia el ángulo del tramo elegido. ` : ""}Corta con la cuchilla y alterna ángulos tramo a tramo; el sonido sigue siendo el de la pista A.</span>
        </div>
      )}
      {angles.map((a) => (
        <div key={a.id} className="card inset stack" style={{ gap: 8 }}>
          <div className="row">
            <input value={a.label} onChange={(e) => patch(a.id, { label: e.target.value })} aria-label="Nombre del ángulo" style={{ flex: 1 }} />
            <button className="btn small icon ghost" onClick={() => remove(a.id)} title="Quitar este ángulo (sus tramos vuelven a la pista A)" aria-label="Quitar ángulo"><Trash size={14} /></button>
          </div>
          <span className="small muted ellipsis" title={a.src}>{a.src === seg.src ? "La misma grabación" : a.src.split("/").pop()}</span>
          <label className="field">
            Zoom {a.zoom.toFixed(2)}×
            <input type="range" min={1} max={3} step={0.05} value={a.zoom} onChange={(e) => patch(a.id, { zoom: Number(e.target.value) })} />
          </label>
          <div className="grid-2">
            <label className="field">Hacia (horizontal)
              <input type="range" min={0} max={1} step={0.01} value={a.x} onChange={(e) => patch(a.id, { x: Number(e.target.value) })} />
            </label>
            <label className="field">Hacia (vertical)
              <input type="range" min={0} max={1} step={0.01} value={a.y} onChange={(e) => patch(a.id, { y: Number(e.target.value) })} />
            </label>
          </div>
          {a.src !== seg.src && (
            <label className="field" title="Si la otra cámara empezó a grabar antes o después: segundos que se suman al tiempo de la pista A">
              Sincronía (s)
              <input type="number" step={0.04} value={a.offset} onChange={(e) => patch(a.id, { offset: Number(e.target.value) || 0 })} />
            </label>
          )}
        </div>
      ))}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn small" onClick={() => add({ id: uid(), label: nextLabel, src: seg.src, src_w: seg.src_w, src_h: seg.src_h, offset: 0, zoom: 1.6, x: 0.5, y: 0.4 })}
          title="Otra pista con la misma grabación y un encuadre más cerrado: alterna plano abierto y primer plano">
          <Plus size={13} /> Duplicar el vídeo en otra pista</button>
      </div>
      {videos.length > 0 && (
        <div className="row">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Vídeo de otra cámara" style={{ flex: 1, minWidth: 0 }}>
            <option value="">Otra cámara: un vídeo de tus archivos…</option>
            {videos.map((v) => <option key={v.url} value={v.url}>{v.name}</option>)}
          </select>
          <button className="btn small" disabled={!pick} onClick={() => void addFile()}>Añadir</button>
        </div>
      )}
      {err && <div className="notice error">{err}</div>}
    </div>
  );
}
