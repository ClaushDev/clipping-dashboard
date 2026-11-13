import { useRef, useState } from "react";
import { fitCube, LOOKS } from "../remotion/grade";
import type { AdjustOverlay, Grade } from "../remotion/schema";

interface Props {
  o: AdjustOverlay;
  onPatch: (patch: Partial<AdjustOverlay>) => void;
}

const SLIDERS: { k: keyof Grade; label: string; min: number; max: number; step: number; base: number; fmt: (v: number) => string }[] = [
  { k: "exposure", label: "Exposición", min: -2, max: 2, step: 0.05, base: 0, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} pasos` },
  { k: "contrast", label: "Contraste", min: 0.4, max: 2, step: 0.02, base: 1, fmt: (v) => `${Math.round(v * 100)} %` },
  { k: "saturation", label: "Saturación", min: 0, max: 2.5, step: 0.05, base: 1, fmt: (v) => `${Math.round(v * 100)} %` },
  { k: "temperature", label: "Temperatura (frío ↔ cálido)", min: -1, max: 1, step: 0.05, base: 0, fmt: (v) => (v ? `${v > 0 ? "+" : ""}${v.toFixed(2)}` : "neutra") },
  { k: "tint", label: "Matiz (verde ↔ magenta)", min: -1, max: 1, step: 0.05, base: 0, fmt: (v) => (v ? `${v > 0 ? "+" : ""}${v.toFixed(2)}` : "neutro") },
  { k: "vignette", label: "Viñeta", min: 0, max: 1, step: 0.05, base: 0, fmt: (v) => (v ? `${Math.round(v * 100)} %` : "no") },
];

/** Capa de ajuste: look o LUT con su intensidad y los controles básicos de color. */
export default function GradePanel({ o, onPatch }: Props) {
  const g = o.grade;
  const cube = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const set = (patch: Partial<Grade>) => onPatch({ grade: { ...g, ...patch } });

  async function importCube(file: File | undefined) {
    if (!file) return;
    try {
      const lut = fitCube(await file.text(), file.name.replace(/\.cube$/i, ""));
      setError("");
      set({ look: "lut", lut, amount: g.amount ?? 1 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="stack">
      <div className="small muted">
        Corrige el color de todo lo que hay debajo mientras dura: el vídeo y las capas que van antes en la lista. Los
        subtítulos quedan por encima.
      </div>
      <div className="grid-2">
        <label className="field">
          Look
          <select value={g.look ?? ""} onChange={(e) => {
            const v = e.target.value;
            if (v === "__cube") cube.current?.click();
            else set({ look: v || undefined });
          }}>
            <option value="">Ninguno (solo los ajustes)</option>
            {Object.entries(LOOKS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
            {g.lut && <option value="lut">LUT · {g.lut.name}</option>}
            <option value="__cube">Importar LUT .cube…</option>
          </select>
        </label>
        <label className="field">
          Intensidad del look: {Math.round((g.amount ?? 1) * 100)} %
          <input type="range" min={0} max={1} step={0.05} value={g.amount ?? 1} disabled={!g.look}
            onChange={(e) => set({ amount: Number(e.target.value) })} />
        </label>
      </div>
      <input ref={cube} type="file" accept=".cube" hidden onChange={(e) => { importCube(e.target.files?.[0]); e.target.value = ""; }} />
      {error && <div className="notice error small">{error}</div>}
      {g.look === "lut" && g.lut && (
        <div className="small muted">
          LUT ajustado a curvas y matriz para verse en vivo: parecido con el original {Math.round((g.lut.fit ?? 0) * 100)} %
          {(g.lut.fit ?? 0) < 0.85 ? " (los LUT muy creativos, que cambian un tono concreto, se aproximan peor)." : "."}
        </div>
      )}
      <div className="grid-2">
        {SLIDERS.map((s) => {
          const v = (g[s.k] as number | undefined) ?? s.base;
          return (
            <label key={s.k} className="field">
              {s.label}: {s.fmt(v)}
              <input type="range" min={s.min} max={s.max} step={s.step} value={v}
                onChange={(e) => set({ [s.k]: Number(e.target.value) })}
                onDoubleClick={() => set({ [s.k]: undefined })} title="Doble clic: valor normal" />
            </label>
          );
        })}
      </div>
      <div className="row">
        <span className="grow" />
        <button className="btn small" onClick={() => onPatch({ grade: g.lut ? { lut: g.lut } : {} })}>Restablecer color</button>
      </div>
    </div>
  );
}
