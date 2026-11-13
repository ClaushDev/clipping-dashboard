import { hookProps } from "../remotion/Captions";
import type { Composition, Overlay } from "../remotion/schema";
import { fmtTime } from "../hooks";
import { FX_LABEL, SHAPE_LABEL } from "./ops";
import { TEMPLATES } from "./templates";
import type { Selection } from "./Timeline";

function overlayLabel(o: Overlay): string {
  switch (o.kind) {
    case "text": return `Texto · ${o.text.trim().slice(0, 40) || "vacío"}`;
    case "image": return `Imagen · ${o.src.split("/").pop()}`;
    case "shape": return `Señal · ${SHAPE_LABEL[o.shape]}`;
    case "progress": return `Barra · ${o.text}`;
    case "block": return `Bloque · ${o.title}`;
    case "graphic": return `Plantilla · ${TEMPLATES[o.component]?.label ?? o.component}`;
    case "cutout": return "Recorte del sujeto";
    case "video": return `Vídeo · ${o.src.split("/").pop()}`;
    case "adjust": return "Ajuste de color";
    default: return "Capa";
  }
}

interface Row { key: string; sel: Selection; label: string; start: number; end: number }

/** Todas las capas del vídeo en una lista (sidebar izquierdo): de arriba abajo como se apilan en pantalla. */
export default function LayerList({ comp, duration, selection, onSelect, onSeek }: {
  comp: Composition; duration: number; selection: Selection; onSelect: (s: Selection) => void; onSeek: (t: number) => void;
}) {
  const groups: { title: string; rows: Row[] }[] = [];
  const hook = hookProps(comp.hook, comp.captions.style);
  if (comp.hook.text.trim()) {
    groups.push({ title: "Texto", rows: [{ key: "hook", sel: { kind: "hook" }, label: `Gancho · ${comp.hook.text.trim().slice(0, 40)}`, start: hook.start, end: Math.min(duration, hook.start + hook.duration) }] });
  }
  const overlays = [...comp.overlays].reverse(); // La última del array se pinta encima
  if (overlays.length) {
    groups.push({ title: "Capas", rows: overlays.map((o) => ({ key: o.id, sel: { kind: "overlay", id: o.id }, label: overlayLabel(o), start: o.start, end: o.end })) });
  }
  if (comp.fx?.length) {
    groups.push({ title: "Zoom y efectos", rows: [...comp.fx].sort((a, b) => a.start - b.start).map((f) => ({ key: f.id, sel: { kind: "fx", id: f.id }, label: FX_LABEL[f.kind], start: f.start, end: f.end })) });
  }
  const audio = comp.audio.filter((a) => a.kind !== "voice");
  if (audio.length) {
    groups.push({ title: "Audio", rows: audio.map((a) => ({ key: a.id, sel: { kind: "audio", id: a.id }, label: `${a.kind === "sfx" ? "Sonido" : "Música"} · ${a.label || a.src.split("/").pop()}`, start: a.start, end: a.duration > 0 ? a.start + a.duration : duration })) });
  }
  const same = (a: Selection, b: Selection) => !!a && !!b && a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);
  if (!groups.length) return <div className="small muted">Aún no hay capas. Añádelas desde «Biblioteca».</div>;
  return (
    <div className="layer-list">
      {groups.map((g) => (
        <section key={g.title}>
          <div className="layer-list-title">{g.title} <span className="faint">{g.rows.length}</span></div>
          {g.rows.map((r) => (
            <button key={r.key} className={`layer-row ${same(selection, r.sel) ? "on" : ""}`} title={r.label}
              onClick={() => { onSelect(r.sel); onSeek(r.start); }}>
              <span className="grow ellipsis">{r.label}</span>
              <span className="faint small mono">{fmtTime(r.start)}–{fmtTime(r.end)}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
