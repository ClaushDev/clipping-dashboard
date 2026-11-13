import { ArrowCounterClockwise, Warning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { BlockOverlay } from "../remotion/schema";
import type { Asset, BlockItem, BlockVariable } from "../types";

const infos = new Map<string, Promise<BlockItem>>();
function blockInfo(name: string): Promise<BlockItem> {
  let p = infos.get(name);
  if (!p) {
    p = api.block(name).then((b) => (b.texts ? b : api.installBlock(name)));
    p.catch(() => infos.delete(name));
    infos.set(name, p);
  }
  return p;
}

/** Opciones de una capa de bloque de HyperFrames: variables, textos, colores, imágenes y fondo. */
export default function BlockPanel({ o, images, canvas, onChange }: {
  o: BlockOverlay; images: Asset[]; canvas: [number, number]; onChange: (patch: Partial<BlockOverlay>) => void;
}) {
  const [info, setInfo] = useState<BlockItem | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    blockInfo(o.block).then((b) => alive && setInfo(b)).catch((e) => alive && setError(String(e.message ?? e)));
    return () => { alive = false; };
  }, [o.block]);

  const setMap = (key: "texts" | "colors" | "images", k: string, v: string | null) => {
    const next = { ...o[key] };
    if (v === null) delete next[k];
    else next[k] = v;
    onChange({ [key]: next });
  };
  const fit = () => {
    if (!o.base_w || !o.base_h) return;
    const [cw, ch] = canvas;
    onChange({ h: +Math.min(1, o.w * (cw / ch) * (o.base_h / o.base_w)).toFixed(4) });
  };

  return (
    <div className="stack block-panel">
      <div>
        <div className="strong">{o.title}</div>
        <div className="small muted">Bloque de HyperFrames{info ? ` · ${info.author} · ${info.license}` : ""}</div>
      </div>
      {error && <div className="notice error small">{error}</div>}
      {info?.warnings?.map((w) => <div key={w} className="notice small"><Warning size={14} /> {w}</div>)}

      {info && info.variables.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="small strong">Opciones del bloque</div>
          {info.variables.map((v) => (
            <VariableField key={v.id} v={v} value={o.vars[v.id] ?? v.default} onChange={(val) => onChange({ vars: { ...o.vars, [v.id]: val } })} />
          ))}
        </div>
      )}

      {info?.texts && info.texts.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small strong">Textos</div>
          {info.texts.map((t) => {
            const changed = o.texts[t.i] !== undefined;
            return (
              <div key={t.i} className="row" style={{ gap: 6 }}>
                <input type="text" style={{ flex: 1 }} value={o.texts[t.i] ?? t.text} aria-label={`Texto ${t.i + 1}`}
                  onChange={(e) => setMap("texts", String(t.i), e.target.value === t.text ? null : e.target.value)} />
                {changed && <button className="btn small ghost" title="Volver al original" onClick={() => setMap("texts", String(t.i), null)}><ArrowCounterClockwise size={13} /></button>}
              </div>
            );
          })}
          <div className="small faint">Los textos que el bloque genera con código (datos de gráficos, nombres de meses…) no salen aquí.</div>
        </div>
      )}

      {info?.colors && info.colors.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small strong">Colores</div>
          <div className="block-colors">
            {info.colors.map((c) => (
              <label key={c.color} className="block-color" title={`${c.color} · ${c.uses} usos`}>
                <input type="color" value={o.colors[c.color] ?? c.color} onChange={(e) => setMap("colors", c.color, e.target.value.toLowerCase() === c.color ? null : e.target.value.toLowerCase())} />
                {o.colors[c.color] && <button className="btn small ghost" title="Volver al original" onClick={(e) => { e.preventDefault(); setMap("colors", c.color, null); }}><ArrowCounterClockwise size={12} /></button>}
              </label>
            ))}
          </div>
        </div>
      )}

      {info?.images && info.images.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small strong">Imágenes</div>
          {info.images.map((src) => (
            <label key={src} className="field">
              {src.split("/").pop()}
              <select value={o.images[src] ?? ""} onChange={(e) => setMap("images", src, e.target.value || null)}>
                <option value="">La del bloque</option>
                {images.map((a) => <option key={a.url} value={a.url}>{a.name}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}

      <label className="check small">
        <input type="checkbox" checked={o.transparent} onChange={(e) => onChange({ transparent: e.target.checked })} />
        Quitar el fondo del bloque (para ponerlo encima del vídeo)
      </label>
      <label className="field">
        Alto: {o.h.toFixed(2)}
        <input type="range" min={0.03} max={1} step={0.01} value={o.h} onChange={(e) => onChange({ h: Number(e.target.value) })} />
      </label>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {o.base_w > 0 && <button className="btn small" onClick={fit}>Ajustar el alto a su proporción</button>}
        {info && Math.abs(o.end - o.start - info.duration) > 0.05 && (
          <button className="btn small" onClick={() => onChange({ end: +(o.start + info.duration).toFixed(2) })}>Usar su duración ({info.duration.toFixed(1)} s)</button>
        )}
      </div>
    </div>
  );
}

function VariableField({ v, value, onChange }: { v: BlockVariable; value: string | number | boolean; onChange: (v: string | number | boolean) => void }) {
  const label = <span title={v.description}>{v.label}</span>;
  if (v.type === "boolean") {
    return <label className="check small"><input type="checkbox" checked={value === true || value === "true"} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
  }
  if (v.type === "enum") {
    return (
      <label className="field">{label}
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {(v.options ?? []).map((op) => <option key={String(op.value)} value={String(op.value)}>{op.label}</option>)}
        </select>
      </label>
    );
  }
  if (v.type === "color") {
    return <label className="field">{label}<input type="color" value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#ffffff"} onChange={(e) => onChange(e.target.value)} /></label>;
  }
  if (v.type === "number") {
    return (
      <label className="field">{label}
        <input type="number" value={Number(value)} min={v.min} max={v.max} step={v.step ?? "any"} onChange={(e) => onChange(Number(e.target.value))} />
      </label>
    );
  }
  if (v.type === "text") {
    return <label className="field">{label}<textarea rows={2} value={String(value)} onChange={(e) => onChange(e.target.value)} /></label>;
  }
  return <label className="field">{label}<input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} /></label>;
}
