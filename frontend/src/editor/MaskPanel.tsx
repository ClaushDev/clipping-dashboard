import type { Mask, Overlay } from "../remotion/schema";

const SHAPE_LABEL: Record<Mask["shape"], string> = {
  rect: "Rectángulo",
  ellipse: "Elipse",
  poly: "A mano (polígono)",
  subject: "Sujeto recortado (5b)",
};

interface Props {
  o: Overlay;
  /** Hay algún plano con el sujeto recortado (para la máscara del sujeto en capas de ajuste). */
  hasMatte: boolean;
  drawing: boolean;
  onPatch: (patch: Partial<Overlay>) => void;
  onDraw: (on: boolean) => void;
}

export function newMask(shape: Mask["shape"], o: Pick<Overlay, "x" | "y">): Mask {
  if (shape === "subject") return { shape, x: 0.5, y: 0.5, w: 1, h: 1, feather: 0 };
  if (shape === "poly") return { shape, x: o.x, y: o.y, w: 0, h: 0, feather: 0.02, points: [] };
  return { shape, x: o.x, y: o.y, w: 0.5, h: 0.3, feather: 0.04 };
}

/** Centro (media de los puntos) de un polígono. */
export function polyCenter(points: [number, number][]): [number, number] {
  if (!points.length) return [0.5, 0.5];
  return [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
}

/** Máscara de una capa: rectángulo, elipse, polígono dibujado sobre la vista previa o, en capas de ajuste, el
 *  sujeto recortado con SAM 2. */
export default function MaskPanel({ o, hasMatte, drawing, onPatch, onDraw }: Props) {
  const m = o.mask;
  const adjust = o.kind === "adjust";
  const set = (patch: Partial<Mask>) => m && onPatch({ mask: { ...m, ...patch } });
  const slider = (label: string, v: number, min: number, max: number, step: number, on: (v: number) => void, fmt = (x: number) => x.toFixed(2)) => (
    <label className="field">
      {label}: {fmt(v)}
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.target.value))} />
    </label>
  );
  return (
    <details className="sound-picker" open={!!m}>
      <summary>Máscara{m ? ` · ${SHAPE_LABEL[m.shape]}` : ""} · {adjust ? "corregir solo una zona" : "ver solo una zona"}</summary>
      <div className="stack">
        <label className="field">
          Forma
          <select value={m?.shape ?? ""} onChange={(e) => {
            const v = e.target.value as Mask["shape"] | "";
            onDraw(v === "poly");
            onPatch({ mask: v ? newMask(v, o) : undefined });
          }}>
            <option value="">Sin máscara</option>
            {(Object.keys(SHAPE_LABEL) as Mask["shape"][]).filter((k) => k !== "subject" || adjust).map((k) => (
              <option key={k} value={k} disabled={k === "subject" && !hasMatte}>
                {SHAPE_LABEL[k]}{k === "subject" && !hasMatte ? " · recorta antes el sujeto" : ""}
              </option>
            ))}
          </select>
        </label>
        {m?.shape === "subject" && (
          <div className="small muted">Usa el recorte del sujeto de cada plano (+ Recorte… → «Recortar sujeto»).</div>
        )}
        {m && (m.shape === "rect" || m.shape === "ellipse") && (
          <>
            <div className="small muted">Arrastra la máscara en la vista previa para moverla.</div>
            <div className="grid-2">
              {slider("Ancho", m.w, 0.02, 1.5, 0.01, (v) => set({ w: v }))}
              {slider("Alto", m.h, 0.02, 1.5, 0.01, (v) => set({ h: v }))}
            </div>
          </>
        )}
        {m?.shape === "poly" && (
          <div className="row small">
            <span className="grow muted">
              {drawing ? "Haz clic en la vista previa para poner puntos; arrástralos para ajustarlos."
                : `${m.points?.length ?? 0} puntos. Arrastra los puntos o el centro en la vista previa.`}
            </span>
            {drawing ? (
              <button className="btn small primary" disabled={(m.points?.length ?? 0) < 3} onClick={() => onDraw(false)}>Terminar</button>
            ) : (
              <>
                <button className="btn small" onClick={() => onDraw(true)}>Añadir puntos</button>
                <button className="btn small" onClick={() => { set({ points: [] }); onDraw(true); }}>Volver a dibujar</button>
              </>
            )}
          </div>
        )}
        {m && m.shape !== "subject" && slider("Borde suave", m.feather, 0, 0.3, 0.01, (v) => set({ feather: v }), (v) => (v ? `${Math.round(v * 100)}` : "duro"))}
        {m && (
          <label className="row small">
            <input type="checkbox" checked={!!m.invert} onChange={(e) => set({ invert: e.target.checked })} />
            {adjust ? (m.shape === "subject" ? "Invertir: corregir el fondo y dejar el sujeto como está" : "Invertir: corregir lo de fuera")
              : "Invertir: ver solo lo de fuera"}
          </label>
        )}
        {adjust && m && m.shape !== "subject" && (
          <div className="small muted">Los fotogramas clave de la capa mueven y escalan la máscara (seguir algo que se mueve).</div>
        )}
      </div>
    </details>
  );
}
