import { Export, FilmSlate, GearSix, House, Plus, Pulse, SpeakerHigh, Subtitles, type Icon } from "@phosphor-icons/react";

// Menú: group = título del grupo encima del elemento, also = rutas que lo marcan como activo.
export type NavItem = { path: string; label: string; icon: Icon; group?: string; g?: number; also?: string[] };
export const NAV: NavItem[] = [
  { path: "videos", label: "Vídeos", icon: House, also: ["video", "marcar"] },
  { path: "nuevo", label: "Nuevo vídeo", icon: Plus, group: "Crear", g: 1 },
  { path: "editor", label: "Editor", icon: FilmSlate, g: 1 },
  { path: "exportar", label: "Exportar", icon: Export, g: 1 },
  { path: "plantillas", label: "Plantillas", icon: Subtitles, group: "Biblioteca", g: 3 },
  { path: "sonidos", label: "Sonidos", icon: SpeakerHigh, g: 3 },
  { path: "actividad", label: "Actividad", icon: Pulse, group: "Sistema", g: 4, also: ["cola"] },
  { path: "ajustes", label: "Ajustes", icon: GearSix, g: 4 },
];
