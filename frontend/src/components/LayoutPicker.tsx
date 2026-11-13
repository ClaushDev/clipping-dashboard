import type { SourceLayout } from "../types";

export const LAYOUT_OPTIONS: { value: SourceLayout; label: string; hint: string }[] = [
  { value: "auto", label: "Automático", hint: "Sigue la cara y pasa a doble vista solo en los momentos en que dos personas se hablan; sin caras, vídeo completo" },
  { value: "face", label: "Seguir cara", hint: "Recorta siempre siguiendo a quien habla" },
  { value: "center", label: "Centro fijo", hint: "Recorta el centro del vídeo sin moverse" },
  { value: "duo", label: "Podcast a dos", hint: "Alterna: doble vista cuando hay exactamente dos personas mirándose y hablando; el resto del clip sigue la cara" },
  { value: "gaming", label: "Gameplay + cámara", hint: "Webcam arriba a todo el ancho (detecta su recuadro) y gameplay abajo ajustado para ver casi toda la escena" },
  { value: "fit_black", label: "Bandas negras", hint: "Vídeo completo en 16:9 con bandas negras" },
  { value: "fit_blur", label: "Fondo desenfocado", hint: "Vídeo completo sobre una copia desenfocada" },
  { value: "fit_color", label: "Fondo de color", hint: "Vídeo completo sobre un color liso" },
];

/** Miniatura esquemática de cómo queda el vídeo 16:9 dentro del formato vertical. */
export function Diagram({ value, color }: { value: SourceLayout; color: string }) {
  const fit = value.startsWith("fit");
  if (value === "duo" || value === "gaming") {
    return (
      <div className="layout-diagram split">
        <div className={`layout-panel ${value === "gaming" ? "cam" : ""}`}><span className="layout-face" /></div>
        <div className={`layout-panel ${value === "gaming" ? "game" : ""}`}>{value === "duo" && <span className="layout-face" />}</div>
      </div>
    );
  }
  const bg = value === "fit_black" ? "#000" : value === "fit_color" ? color : value === "fit_blur"
    ? "linear-gradient(180deg, #6b7a99, #3d4660)" : "transparent";
  return (
    <div className="layout-diagram" style={{ background: bg }}>
      {fit ? (
        <div className="layout-band" style={value === "fit_blur" ? { boxShadow: "0 0 10px 4px rgb(255 255 255 / 0.25)" } : undefined} />
      ) : (
        <div className="layout-fill">
          {value !== "center" && <span className="layout-face" />}
        </div>
      )}
    </div>
  );
}

export default function LayoutPicker({ value, color, onChange }: { value: SourceLayout; color: string; onChange: (v: SourceLayout) => void }) {
  return (
    <div className="layout-picker" role="radiogroup" aria-label="Encuadre">
      {LAYOUT_OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.hint}
          className={`layout-option ${value === o.value ? "on" : ""}`} onClick={() => onChange(o.value)}>
          <Diagram value={o.value} color={color} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
