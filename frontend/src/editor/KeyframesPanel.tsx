import { keyedAt, type KeyedState, type Overlay } from "../remotion/schema";
import { EASE_LABEL, EasePicker } from "./CurveEditor";
import { setKeyAt } from "./ops";

const PROPS: { k: keyof KeyedState; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { k: "x", label: "Posición X", min: -0.5, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
  { k: "y", label: "Posición Y", min: -0.5, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
  { k: "scale", label: "Escala", min: 0, max: 4, step: 0.01, fmt: (v) => `×${v.toFixed(2)}` },
  { k: "rot", label: "Giro", min: -360, max: 360, step: 1, fmt: (v) => `${Math.round(v)}°` },
  { k: "opacity", label: "Opacidad", min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %` },
];

interface Props {
  o: Overlay;
  playhead: number;
  fps: number;
  onPatch: (patch: Partial<Overlay>) => void;
  onSeek?: (t: number) => void;
}

/** Fotogramas clave de una capa: con el cursor dentro de la capa, cambiar un valor crea o edita la clave de ese
 *  instante, como en Premiere. */
export default function KeyframesPanel({ o, playhead, fps, onPatch, onSeek }: Props) {
  const keys = o.keys ?? [];
  const t = playhead - o.start;
  const inside = t >= -1e-3 && t <= o.end - o.start + 1e-3;
  const state = keyedAt(o, t);
  const onKey = keys.findIndex((k) => Math.abs(k.t - t) < 0.5 / fps);
  const set = (patch: Partial<KeyedState>) => onPatch({ keys: setKeyAt(o, t, patch, fps).keys });
  const setKey = (i: number, patch: Partial<NonNullable<Overlay["keys"]>[number]>) =>
    onPatch({ keys: keys.map((k, j) => (j === i ? { ...k, ...patch } : k)) });

  return (
    <details className="sound-picker" open={keys.length > 0}>
      <summary>Fotogramas clave{keys.length ? ` · ${keys.length}` : ""} · mover, escalar, girar y fundir</summary>
      {!keys.length ? (
        <div className="stack">
          <div className="small muted">
            Pon el cursor donde empieza el movimiento y añade una clave; luego muévelo a otro instante y cambia la posición,
            la escala, el giro o la opacidad: se crea otra clave y la capa va de una a otra con la curva que elijas.
          </div>
          <button className="btn small" disabled={!inside} onClick={() => set({})}>◆ Añadir clave en el cursor</button>
        </div>
      ) : (
        <div className="stack">
          {!inside && <div className="small muted">Pon el cursor dentro de la capa para editar sus claves.</div>}
          <div className="small muted">
            {onKey >= 0 ? `Editando la clave ${onKey + 1}.` : "Cambiar un valor aquí crea una clave nueva en el cursor."}
            {" "}Arrastrar la capa en la vista previa también.
          </div>
          <div className="grid-2">
            {PROPS.map((p) => (
              <label key={p.k} className="field">
                {p.label}: {p.fmt(state[p.k])}
                <input type="range" min={p.min} max={p.max} step={p.step} value={state[p.k]} disabled={!inside}
                  onChange={(e) => set({ [p.k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <div className="key-list">
            {keys.map((k, i) => {
              const ease = k.ease ?? "ease";
              return (
                <div key={i} className={`key-row ${i === onKey ? "on" : ""}`}>
                  <button className="btn small" title="Ir a esta clave" onClick={() => onSeek?.(o.start + k.t)}>◆ {k.t.toFixed(2)} s</button>
                  {i > 0
                    ? <EasePicker ease={ease} bezier={k.bezier} labels={EASE_LABEL} onChange={(e, bz) => setKey(i, { ease: e, bezier: bz })} />
                    : <span className="grow small muted">Inicio</span>}
                  <button className="btn small" title="Borrar clave" onClick={() => onPatch({ keys: keys.length > 1 ? keys.filter((_, j) => j !== i) : undefined })}>×</button>
                </div>
              );
            })}
          </div>
          <div className="row">
            <button className="btn small" disabled={!inside || onKey >= 0} onClick={() => set({})}>◆ Clave en el cursor</button>
            <span className="grow" />
            <button className="btn small" onClick={() => onPatch({ keys: undefined, x: keys[0].x, y: keys[0].y })}>Quitar animación</button>
          </div>
        </div>
      )}
    </details>
  );
}
