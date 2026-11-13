import { type KeyEase, upsertValueKey, valueAt, type ValueKey } from "../remotion/schema";
import { EASE_LABEL, EasePicker } from "./CurveEditor";

interface Props {
  label: string;
  volume: number;
  keys: ValueKey[] | undefined;
  /** Cursor en el tiempo de las claves (segundos desde el inicio del elemento); null = fuera del elemento. */
  t: number | null;
  /** Hasta dónde llegan las claves (duración del elemento en su tiempo). */
  length: number;
  fps: number;
  max?: number;
  /** Otros valores con claves (p. ej. velocidad): mínimo, paso, formato, texto del botón y para qué sirve. */
  min?: number;
  step?: number;
  fmt?: (v: number) => string;
  addLabel?: string;
  hint?: string;
  onChange: (patch: { volume?: number; vol_keys?: ValueKey[] | undefined }) => void;
  /** Lleva el cursor a una clave (en el tiempo de las claves). */
  onSeek?: (t: number) => void;
}

const pct = (v: number) => (v ? `${Math.round(v * 100)} %` : "mudo");

/** Volumen con fotogramas clave, como la línea de volumen de Premiere. Sin claves, el deslizador cambia el volumen
 *  de todo el elemento; con claves, el del cursor (y crea una clave ahí si no la hay). */
export default function VolumeKeys({ label, volume, keys, t, length, fps, max = 1.5, min = 0, step = 0.01, fmt = pct, addLabel = "◆ Clave de volumen en el cursor",
  hint = "Pon una clave aquí, mueve el cursor y cambia el volumen: entre las dos claves sube o baja con la curva que elijas.", onChange, onSeek }: Props) {
  const list = keys ?? [];
  const inside = t !== null && t >= -1e-3 && t <= length + 1e-3;
  const at = inside ? Math.min(Math.max(0, t!), length) : 0;
  const now = valueAt(keys, at, volume);
  const onKey = inside ? list.findIndex((k) => Math.abs(k.t - at) < 0.5 / fps) : -1;
  const setKeys = (next: ValueKey[] | undefined) => onChange({ vol_keys: next?.length ? next : undefined });

  return (
    <div className="stack vol-keys">
      <label className="field">
        {label}{list.length ? " en el cursor" : ""}: {fmt(list.length ? now : volume)}
        <input type="range" min={min} max={max} step={step} value={list.length ? now : volume} disabled={!!list.length && !inside}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!list.length) onChange({ volume: v });
            else setKeys(upsertValueKey(list, at, v, fps));
          }} />
      </label>
      {!list.length ? (
        <div className="row">
          <button className="btn small" disabled={!inside}
            title={hint} onClick={() => setKeys([{ t: +at.toFixed(3), v: volume }])}>{addLabel}</button>
        </div>
      ) : (
        <>
          <div className="small muted">
            {!inside ? "Pon el cursor dentro para editar las claves." : onKey >= 0 ? `Editando la clave ${onKey + 1}.` : "Mover el deslizador crea una clave en el cursor."}
          </div>
          <div className="key-list">
            {list.map((k, i) => (
              <div key={i} className={`key-row ${i === onKey ? "on" : ""}`}>
                <button className="btn small" title="Ir a esta clave" onClick={() => onSeek?.(k.t)}>◆ {k.t.toFixed(2)} s · {fmt(k.v)}</button>
                {i > 0
                  ? <EasePicker ease={k.ease ?? "linear"} bezier={k.bezier} labels={EASE_LABEL}
                      onChange={(e: KeyEase, bz) => setKeys(list.map((kk, j) => (j === i ? { ...kk, ease: e, bezier: bz } : kk)))} />
                  : <span className="grow small muted">Inicio</span>}
                <button className="btn small" title="Borrar clave" onClick={() => setKeys(list.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
          <div className="row">
            <button className="btn small" disabled={!inside || onKey >= 0} onClick={() => setKeys(upsertValueKey(list, at, now, fps))}>◆ Clave en el cursor</button>
            <span className="grow" />
            <button className="btn small" title="Quita las claves y deja el valor que hay en el cursor"
              onClick={() => onChange({ volume: +now.toFixed(2), vol_keys: undefined })}>Quitar claves</button>
          </div>
        </>
      )}
    </div>
  );
}
