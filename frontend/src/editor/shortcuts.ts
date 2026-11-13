/** Atajos de teclado configurables del editor (como Premiere: Editar → Métodos abreviados de teclado).
 *  Cada acción tiene una o varias combinaciones ("ctrl+shift+z", "space", "m"). Lo cambiado se guarda en este
 *  navegador (localStorage); lo que no se cambia sigue con el valor por defecto. */

export type ShortcutAction =
  | "play" | "undo" | "redo" | "save" | "duplicate" | "copy_attrs" | "paste_attrs"
  | "select_tool" | "blade_tool" | "rolling_tool" | "slip_tool" | "slide_tool"
  | "split" | "punch" | "snap" | "marker" | "deselect" | "delete"
  | "frame_back" | "frame_fwd" | "sec_back" | "sec_fwd" | "prev_edit" | "next_edit" | "home" | "end"
  | "zoom_in" | "zoom_out" | "fit" | "command" | "angle";

export const SHORTCUTS: { action: ShortcutAction; label: string; keys: string[] }[] = [
  { action: "play", label: "Reproducir / pausar", keys: ["space"] },
  { action: "undo", label: "Deshacer", keys: ["ctrl+z"] },
  { action: "redo", label: "Rehacer", keys: ["ctrl+shift+z", "ctrl+y"] },
  { action: "save", label: "Guardar", keys: ["ctrl+s"] },
  { action: "duplicate", label: "Duplicar lo seleccionado", keys: ["ctrl+d"] },
  { action: "copy_attrs", label: "Copiar atributos", keys: ["ctrl+alt+c"] },
  { action: "paste_attrs", label: "Pegar atributos", keys: ["ctrl+alt+v"] },
  { action: "select_tool", label: "Herramienta mover", keys: ["v"] },
  { action: "blade_tool", label: "Cuchilla", keys: ["c"] },
  { action: "rolling_tool", label: "Edición de rodillo (mover un corte)", keys: ["r"] },
  { action: "slip_tool", label: "Desplazar (slip)", keys: ["y"] },
  { action: "slide_tool", label: "Deslizar (slide)", keys: ["u"] },
  { action: "split", label: "Dividir en el cursor", keys: ["s"] },
  { action: "punch", label: "Zoom en el cursor", keys: ["z"] },
  { action: "snap", label: "Imán", keys: ["n"] },
  { action: "marker", label: "Marcador en el cursor", keys: ["m"] },
  { action: "deselect", label: "Soltar selección", keys: ["escape"] },
  { action: "delete", label: "Borrar y juntar", keys: ["delete", "backspace"] },
  { action: "frame_back", label: "Fotograma anterior", keys: ["arrowleft"] },
  { action: "frame_fwd", label: "Fotograma siguiente", keys: ["arrowright"] },
  { action: "sec_back", label: "1 s atrás", keys: ["shift+arrowleft"] },
  { action: "sec_fwd", label: "1 s adelante", keys: ["shift+arrowright"] },
  { action: "prev_edit", label: "Corte o marcador anterior", keys: ["arrowup"] },
  { action: "next_edit", label: "Corte o marcador siguiente", keys: ["arrowdown"] },
  { action: "home", label: "Ir al inicio", keys: ["home"] },
  { action: "end", label: "Ir al final", keys: ["end"] },
  { action: "zoom_in", label: "Acercar la timeline", keys: ["+", "="] },
  { action: "zoom_out", label: "Alejar la timeline", keys: ["-"] },
  { action: "fit", label: "Ver toda la timeline", keys: ["\\"] },
  { action: "command", label: "Pedir un cambio a la IA (barra de comandos)", keys: ["ctrl+k"] },
  { action: "angle", label: "Cambiar de ángulo el tramo elegido (multicámara)", keys: ["a"] },
];

const STORE = "clipping.shortcuts";
export type KeyMap = Record<ShortcutAction, string[]>;

export function defaultKeyMap(): KeyMap {
  return Object.fromEntries(SHORTCUTS.map((s) => [s.action, [...s.keys]])) as KeyMap;
}

export function loadKeyMap(): KeyMap {
  const map = defaultKeyMap();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "{}") as Partial<KeyMap>;
    for (const s of SHORTCUTS) if (Array.isArray(saved[s.action])) map[s.action] = saved[s.action]!;
  } catch { /* Atajos guardados ilegibles: los de por defecto */ }
  return map;
}

/** Guarda solo lo que difiere de los de por defecto. */
export function saveKeyMap(map: KeyMap) {
  const def = defaultKeyMap();
  const diff = Object.fromEntries(SHORTCUTS.filter((s) => map[s.action].join() !== def[s.action].join()).map((s) => [s.action, map[s.action]]));
  try { localStorage.setItem(STORE, JSON.stringify(diff)); } catch { /* Sin almacenamiento: valen hasta cerrar la página */ }
}

/** Combinación de una pulsación: "ctrl+shift+z". Mayús no cuenta en los signos («+» ya la lleva). null = solo una tecla
 *  modificadora. */
export function comboOf(e: KeyboardEvent): string | null {
  const k = e.key === " " ? "space" : e.key.toLowerCase();
  if (["control", "shift", "alt", "meta", "altgraph"].includes(k)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && (k.length > 1 || /[a-z0-9]/.test(k))) parts.push("shift");
  parts.push(k);
  return parts.join("+");
}

/** Acción de una pulsación con este mapa (o null). */
export function actionFor(map: KeyMap, e: KeyboardEvent): ShortcutAction | null {
  const c = comboOf(e);
  if (!c) return null;
  for (const s of SHORTCUTS) if (map[s.action].includes(c)) return s.action;
  return null;
}

const NAMES: Record<string, string> = {
  space: "Espacio", ctrl: "Ctrl", shift: "Mayús", alt: "Alt", escape: "Esc", delete: "Supr", backspace: "Retroceso",
  arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", home: "Inicio", end: "Fin",
};

/** «Ctrl+Mayús+Z» */
export function comboLabel(c: string): string {
  const parts = c === "+" ? ["+"] : c.endsWith("++") ? [...c.slice(0, -2).split("+"), "+"] : c.split("+");
  return parts.map((p) => NAMES[p] ?? p.toUpperCase()).join("+");
}

/** Primera combinación de una acción, para los textos de ayuda. */
export function keyHint(map: KeyMap, a: ShortcutAction): string {
  return map[a][0] ? comboLabel(map[a][0]) : "—";
}
