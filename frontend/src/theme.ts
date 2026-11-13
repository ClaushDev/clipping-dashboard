/** Tema de la interfaz: oscuro (por defecto), claro o el del sistema. Se guarda en este navegador. */
export type ThemeChoice = "light" | "dark" | "system";

const KEY = "cs-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function savedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "system" ? v : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(choice: ThemeChoice) {
  document.documentElement.dataset.theme = effectiveTheme(choice);
}

export function setTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* Sin almacenamiento: solo esta sesión */
  }
  applyTheme(choice);
}

/** Con «sistema», sigue los cambios del sistema operativo. */
export function watchSystemTheme(choice: ThemeChoice): () => void {
  if (choice !== "system") return () => undefined;
  const m = media();
  const on = () => applyTheme("system");
  m.addEventListener("change", on);
  return () => m.removeEventListener("change", on);
}

/** Tema que se ve ahora mismo (resuelve «sistema»). */
export function effectiveTheme(choice: ThemeChoice): "light" | "dark" {
  return choice === "dark" || (choice === "system" && media().matches) ? "dark" : "light";
}
