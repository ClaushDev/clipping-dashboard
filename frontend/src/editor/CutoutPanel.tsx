import { useState } from "react";
import { api } from "../api";
import { type Composition, type CutoutMode, type CutoutOverlay, type Overlay, segmentLength } from "../remotion/schema";
import type { Asset } from "../types";
import { type CompUpdate, uid } from "./ops";

export const CUTOUT_LABEL: Record<CutoutMode, string> = {
  behind: "Texto detrás del sujeto",
  screen: "Fondo nuevo (croma sin verde)",
  paper: "Recortable de papel",
  escape: "Se sale del marco",
  portal: "Portal con zoom",
  orbit: "Órbita 2,5D",
};

const HINT: Record<CutoutMode, string> = {
  behind: "El sujeto queda por delante de las capas que añadiste antes que este recorte (un título grande detrás de la persona).",
  screen: "Cambia el fondo por un color, una imagen o el propio plano desenfocado; el sujeto se queda.",
  paper: "Fondo de papel, borde blanco grueso y sombra dura, con un temblor de stop motion.",
  escape: "El plano se encoge dentro de un marco y el sujeto, que sigue a tamaño completo, se sale de él.",
  portal: "Se abre un portal circular con el plano dentro; el sujeto lo atraviesa mientras la cámara se acerca.",
  orbit: "El fondo y el sujeto se mueven en sentidos contrarios, como si la cámara girase alrededor.",
};

const DEFAULTS: Record<CutoutMode, Partial<CutoutOverlay>> = {
  behind: { bg: "", color: "#ffffff", w: 1 },
  screen: { bg: "blur", color: "#ffffff", w: 1 },
  paper: { bg: "#efe4cf", color: "#ffffff", w: 1 },
  escape: { bg: "blur", color: "#ffffff", w: 0.78 },
  portal: { bg: "#07060f", color: "#7fd4ff", w: 0.7 },
  orbit: { bg: "", color: "#ffffff", w: 1 },
};

export function newCutout(mode: CutoutMode, at: number, duration: number): CutoutOverlay {
  return {
    id: uid(), kind: "cutout", mode, start: +at.toFixed(2), end: +Math.min(at + 3, duration).toFixed(2), x: 0.5, y: 0.5,
    anim: "none", bg: "", color: "#ffffff", w: 1, ...DEFAULTS[mode],
  };
}

/** Plano (tramo o escena) que se ve en el instante t, con su recorte si lo tiene. */
export function shotAt(c: Composition, t: number): { matte?: { src: string } } | undefined {
  const scene = c.scenes.find((s) => s.start <= t && t < s.start + s.duration && s.kind !== "graphic" && s.src);
  if (scene) return scene;
  let acc = 0;
  for (const s of c.segments) {
    const len = segmentLength(s);
    if (acc <= t && t < acc + len) return s;
    acc += len;
  }
  return undefined;
}

interface Props {
  clipId: number;
  comp: Composition;
  o: CutoutOverlay;
  images: Asset[];
  onPatch: (patch: Partial<CutoutOverlay>) => void;
  onChange: (c: CompUpdate) => void;
}

export default function CutoutPanel({ clipId, comp, o, images, onPatch, onChange }: Props) {
  const [query, setQuery] = useState("person");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const shot = shotAt(comp, o.start);
  const bgKind = !o.bg ? "none" : o.bg === "blur" ? "blur" : o.bg.startsWith("#") ? "color" : "image";

  async function cut() {
    setBusy(true);
    setMsg("Recortando con SAM 2… (alrededor de 1 minuto por cada 10 s de plano)");
    try {
      const r = await api.matte(clipId, comp, o.start, query);
      const put = <T extends { id: string }>(list: T[]) => list.map((x) => (x.id === r.id ? { ...x, matte: r.matte } : x));
      // Sobre la composición de ahora (el recorte tarda minutos y mientras tanto se puede seguir editando)
      onChange((c) => (r.target === "scene" ? { ...c, scenes: put(c.scenes) } : { ...c, segments: put(c.segments) }));
      setMsg(r.partial ? "Recortado. El plano es largo: solo se recortan sus primeros 30 s." : "Sujeto recortado.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label className="field">
        Efecto
        <select value={o.mode} onChange={(e) => onPatch({ mode: e.target.value as CutoutMode, ...DEFAULTS[e.target.value as CutoutMode] })}>
          {(Object.keys(CUTOUT_LABEL) as CutoutMode[]).map((k) => <option key={k} value={k}>{CUTOUT_LABEL[k]}</option>)}
        </select>
      </label>
      <div className="small muted">{HINT[o.mode]}</div>
      <div className="card inset stack">
        <div className="small">
          {shot?.matte ? "✓ El plano de este momento tiene el sujeto recortado." : "⚠ El plano de este momento aún no tiene el sujeto recortado: sin recorte, el efecto no se ve."}
        </div>
        <div className="row">
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="person, dog, car…"
            title="Qué recortar, en inglés (lo busca el detector local)" aria-label="Qué recortar" style={{ flex: 1 }} />
          <button className="btn small" disabled={busy || !shot} onClick={cut}>{shot?.matte ? "Recortar otra vez" : "Recortar sujeto"}</button>
        </div>
        {msg && <div className="small muted">{msg}</div>}
      </div>
      {o.mode !== "behind" && o.mode !== "orbit" && (
        <div className="grid-2">
          <label className="field">
            Fondo
            <select value={bgKind} onChange={(e) => onPatch({ bg: e.target.value === "blur" ? "blur" : e.target.value === "color" ? "#101418" : e.target.value === "image" ? images[0]?.url ?? "blur" : "" })}>
              <option value="blur">El plano desenfocado</option>
              <option value="color">Color</option>
              {images.length > 0 && <option value="image">Imagen</option>}
            </select>
          </label>
          {bgKind === "color" && <label className="field">Color de fondo<input type="color" value={o.bg} onChange={(e) => onPatch({ bg: e.target.value })} /></label>}
          {bgKind === "image" && (
            <label className="field">
              Imagen
              <select value={o.bg} onChange={(e) => onPatch({ bg: e.target.value })}>
                {images.map((a) => <option key={a.url} value={a.url}>{a.name}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {(o.mode === "paper" || o.mode === "escape" || o.mode === "portal") && (
        <label className="field">{o.mode === "paper" ? "Borde" : o.mode === "portal" ? "Brillo del portal" : "Marco"}
          <input type="color" value={o.color} onChange={(e) => onPatch({ color: e.target.value })} />
        </label>
      )}
    </>
  );
}

/** Mueve una capa justo delante o justo detrás del primer recorte que coincide con ella en el tiempo. */
export function placeAroundCutout(c: Composition, o: Overlay, behind: boolean): Composition {
  const cut = c.overlays.find((x) => x.kind === "cutout" && x.start < o.end && o.start < x.end);
  if (!cut) return c;
  const rest = c.overlays.filter((x) => x.id !== o.id);
  const at = rest.findIndex((x) => x.id === cut.id) + (behind ? 0 : 1);
  return { ...c, overlays: [...rest.slice(0, at), o, ...rest.slice(at)] };
}
