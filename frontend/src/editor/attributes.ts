/** Copiar y pegar atributos (Premiere: Edición → Pegar atributos). Se copia un tramo o una capa entera y al pegar
 *  se eligen los grupos que pasan al tramo o la capa seleccionados. */
import type { Composition, Overlay, Segment } from "../remotion/schema";
import type { Selection } from "./Timeline";

export type AttrClip = { kind: "segment"; seg: Segment } | { kind: "overlay"; o: Overlay };

export type AttrGroup = "framing" | "speed" | "volume" | "motion" | "mask" | "look";

export const ATTR_LABEL: Record<AttrGroup, string> = {
  framing: "Encuadre (cómo se muestra, planos y paneles)",
  speed: "Velocidad (rampa, marcha atrás y congelado)",
  volume: "Volumen (con sus claves)",
  motion: "Movimiento (fotogramas clave, entrada y bucle)",
  mask: "Máscara",
  look: "Aspecto (estilo de texto, opacidad, bordes…)",
};

const SEGMENT_FIELDS: Partial<Record<AttrGroup, (keyof Segment)[]>> = {
  framing: ["layout", "bg_color", "keys", "panels"],
  speed: ["speed", "speed_keys", "reverse", "freeze"],
  volume: ["volume", "vol_keys"],
};

/** Campos de capa por grupo; «look» depende del tipo y solo pasa entre capas del mismo tipo. */
const OVERLAY_FIELDS: Partial<Record<AttrGroup, string[]>> = {
  motion: ["keys", "anim", "loop", "rot"],
  mask: ["mask"],
  volume: ["volume", "vol_keys"],
};
const LOOK_FIELDS: Record<string, string[]> = {
  text: ["size", "color", "bg", "font", "weight", "align", "stroke", "stroke_color", "shadow", "opacity"],
  image: ["opacity"],
  video: ["opacity", "radius", "border", "fill"],
  shape: ["color", "stroke"],
  progress: ["color"],
};

/** Lo que se puede copiar de lo seleccionado. */
export function copyAttrs(c: Composition, sel: Selection): AttrClip | null {
  if (sel?.kind === "segment" && c.segments[sel.index]) return { kind: "segment", seg: structuredClone(c.segments[sel.index]) };
  if (sel?.kind === "shot" && c.segments[sel.index]) return { kind: "segment", seg: structuredClone(c.segments[sel.index]) };
  if (sel?.kind === "overlay") {
    const o = c.overlays.find((x) => x.id === sel.id);
    if (o) return { kind: "overlay", o: structuredClone(o) };
  }
  return null;
}

/** Grupos que tienen sentido de lo copiado a lo seleccionado. */
export function pasteGroups(c: Composition, clip: AttrClip, sel: Selection): AttrGroup[] {
  if (clip.kind === "segment" && (sel?.kind === "segment" || sel?.kind === "shot")) return ["framing", "speed", "volume"];
  if (clip.kind === "overlay" && sel?.kind === "overlay") {
    const o = c.overlays.find((x) => x.id === sel.id);
    if (!o) return [];
    const out: AttrGroup[] = ["motion", "mask"];
    if ("volume" in clip.o && "volume" in o) out.push("volume");
    if (o.kind === clip.o.kind && LOOK_FIELDS[o.kind]) out.push("look");
    return out;
  }
  return [];
}

function pick(from: object, fields: string[]): Record<string, unknown> {
  const src = from as Record<string, unknown>;
  // Lo que no tenía lo copiado se borra también (p. ej. pegar «sin rampa» quita la rampa).
  return Object.fromEntries(fields.map((f) => [f, src[f] === undefined ? undefined : structuredClone(src[f])]));
}

/** Pega los grupos elegidos en lo seleccionado. Los encuadres y claves van en segundos desde el inicio, así que
 *  caen en el mismo sitio relativo; las claves que quedan más allá del final no se ven. */
export function pasteAttrs(c: Composition, clip: AttrClip, sel: Selection, groups: AttrGroup[]): Composition {
  if (clip.kind === "segment" && (sel?.kind === "segment" || sel?.kind === "shot")) {
    const fields = groups.flatMap((g) => SEGMENT_FIELDS[g] ?? []) as string[];
    const patch = pick(clip.seg, fields);
    return { ...c, segments: c.segments.map((s, i) => (i === sel.index ? ({ ...s, ...patch } as Segment) : s)) };
  }
  if (clip.kind === "overlay" && sel?.kind === "overlay") {
    return {
      ...c,
      overlays: c.overlays.map((o) => {
        if (o.id !== sel.id) return o;
        const fields = groups.flatMap((g) => (g === "look" ? (o.kind === clip.o.kind ? LOOK_FIELDS[o.kind] ?? [] : []) : OVERLAY_FIELDS[g] ?? []));
        return { ...o, ...pick(clip.o, fields) } as Overlay;
      }),
    };
  }
  return c;
}
