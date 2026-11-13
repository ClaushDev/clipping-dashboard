/** Catálogo de plantillas del editor: nombre, para qué sirve, contenido de ejemplo y campos editables.
 *  Los componentes están en remotion/templates.tsx; aquí solo lo que necesita el panel. */
import type { Fx, GraphicOverlay } from "../remotion/schema";
import { uid } from "./ops";

export type FieldType = "text" | "lines" | "number" | "numbers" | "bool" | "image" | "chat" | "headlines";
export interface TemplateField { key: string; label: string; type: FieldType; hint?: string }
export interface TemplateInfo { label: string; hint: string; len: number; props: Record<string, unknown>; fields: TemplateField[] }

export const TEMPLATES: Record<string, TemplateInfo> = {
  checklist: {
    label: "Checklist Pop / Tally", hint: "Lista que se va marcando con un contador 3/5.", len: 5,
    props: { title: "Morning routine", items: ["Wake up at 5 AM", "Cold shower", "No phone", "Read 10 pages"], tally: true },
    fields: [{ key: "title", label: "Título", type: "text" }, { key: "items", label: "Puntos (uno por línea)", type: "lines" },
      { key: "tally", label: "Contador 3/5", type: "bool" }],
  },
  headline_storm: {
    label: "Headline Storm", hint: "Titulares de prensa que caen uno tras otro y un veredicto final.", len: 4.5,
    props: { title: "Nobody saw it coming", headlines: [{ source: "Daily Post", text: "Scientists baffled by new discovery" },
      { source: "The Times", text: "Experts call it 'impossible'" }, { source: "News 24", text: "Millions react overnight" }] },
    fields: [{ key: "headlines", label: "Titulares («Medio | titular», uno por línea)", type: "headlines" },
      { key: "title", label: "Veredicto final", type: "text" }],
  },
  growth_curve: {
    label: "Growth Curve", hint: "Curva que se dibuja subiendo con la cifra en la punta.", len: 4.5,
    props: { title: "Subscribers in 12 months", points: [0, 120, 400, 1500, 6000, 25000], prefix: "", suffix: "", start_label: "Jan", end_label: "Dec" },
    fields: [{ key: "title", label: "Título", type: "text" }, { key: "points", label: "Valores (separados por comas)", type: "numbers" },
      { key: "prefix", label: "Antes de la cifra", type: "text", hint: "$, €…" }, { key: "suffix", label: "Después de la cifra", type: "text", hint: "%, K…" },
      { key: "start_label", label: "Etiqueta inicial", type: "text" }, { key: "end_label", label: "Etiqueta final", type: "text" }],
  },
  chat: {
    label: "Chat Takeover", hint: "Conversación de mensajería que se escribe sola, con «escribiendo…».", len: 6,
    props: { name: "Alex", messages: [{ from: "them", text: "Did you see what happened?" }, { from: "me", text: "No, what?" },
      { from: "them", text: "Check the news. Now." }] },
    fields: [{ key: "name", label: "Contacto", type: "text" },
      { key: "messages", label: "Mensajes (empieza por «>» los tuyos)", type: "chat" }],
  },
  phone: {
    label: "Phone Mockup", hint: "Móvil que entra en 3D con una publicación y los «me gusta» contando.", len: 4,
    props: { user: "@channel", text: "This changed everything 🤯", likes: 48200, image: "" },
    fields: [{ key: "image", label: "Imagen de la pantalla", type: "image" }, { key: "user", label: "Usuario", type: "text" },
      { key: "text", label: "Texto de la publicación", type: "text" }, { key: "likes", label: "Me gusta", type: "number" }],
  },
  magazine: {
    label: "Magazine Cover", hint: "Portada de revista que gira y se monta: cabecera, titulares y el gran titular.", len: 4,
    props: { masthead: "FOCUS", headline: "The man who sold the moon", lines: ["The scam of the century", "How he did it", "Where is he now"], issue: "Special issue · 2026", image: "" },
    fields: [{ key: "image", label: "Foto de portada", type: "image" }, { key: "masthead", label: "Cabecera", type: "text" },
      { key: "headline", label: "Gran titular", type: "text" }, { key: "lines", label: "Titulares laterales (uno por línea)", type: "lines" },
      { key: "issue", label: "Número / fecha", type: "text" }],
  },
  liquid_glass: {
    label: "Liquid Glass", hint: "Tarjeta de cristal esmerilado con brillo; encima del vídeo lo desenfoca detrás.", len: 3.5,
    props: { icon: "💡", title: "Did you know?", text: "Octopuses have three hearts.", image: "" },
    fields: [{ key: "icon", label: "Emoji", type: "text" }, { key: "title", label: "Título", type: "text" },
      { key: "text", label: "Texto", type: "text" }, { key: "image", label: "Fondo (solo como escena)", type: "image" }],
  },
};

export function newGraphic(component: string, at: number, duration: number): GraphicOverlay {
  const t = TEMPLATES[component];
  return {
    id: uid(), kind: "graphic", component, props: structuredClone(t.props), start: +at.toFixed(2),
    end: +Math.min(at + t.len, duration).toFixed(2), x: 0.5, y: 0.5, w: 1, anim: "none",
  };
}

/** Presets de cámara: combinaciones de efectos que se añaden de una vez. */
export const FX_PRESETS: Record<string, { label: string; hint: string; make: (at: number) => Omit<Fx, "id">[] }> = {
  snap: {
    label: "Snap", hint: "Zoom seco con un golpe de cámara, para remarcar una palabra.",
    make: (at) => [
      { kind: "punch", start: at, end: at + 0.9, x: 0.5, y: 0.42, amount: 0.32 },
      { kind: "shake", start: at, end: at + 0.22, x: 0.5, y: 0.5, amount: 0.5 },
    ],
  },
  digital_zoom: {
    label: "Digital Zoom", hint: "Zoom de cámara en tres saltos secos, como el de una videocámara.",
    make: (at) => [{ kind: "zoom", start: at, end: at + 1.5, x: 0.5, y: 0.42, amount: 0.6, steps: 3 }],
  },
};
