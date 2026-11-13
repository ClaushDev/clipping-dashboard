import { useRef } from "react";
import { type Bezier, type CamEase, easeAt, easeBezier, type KeyEase } from "../remotion/schema";

/** Curvas de fotograma clave, como la interpolación temporal de Premiere. Cada curva va de una clave a la
 *  siguiente: el primer tirador es la salida de la clave anterior y el segundo, la entrada a esta. */
export const EASE_LABEL: Record<KeyEase, string> = {
  ease: "Suave",
  linear: "Lineal",
  ease_in: "Acelera",
  ease_out: "Frena",
  back: "Con rebote",
  hold: "Salto (sin transición)",
  custom: "Curva personalizada",
};

/** Curvas que se ofrecen para la cámara: el corte y el «suave» de siempre van primero. */
export const CAM_EASE_LABEL: Record<CamEase, string> = {
  hold: "Corte",
  smooth: "Suave",
  ease: "Suave (bézier)",
  linear: "Lineal",
  ease_in: "Acelera",
  ease_out: "Frena",
  back: "Con rebote",
  custom: "Curva personalizada",
};

/** Miniatura de la curva. */
export function CurveThumb({ ease, bezier }: { ease: CamEase; bezier?: Bezier }) {
  const pts = Array.from({ length: 25 }, (_, i) => {
    const p = i / 24;
    const e = easeAt(ease, bezier, p);
    const y = e === null ? (p < 1 ? 0 : 1) : e;
    return `${(p * 40).toFixed(1)},${(30 - y * 22).toFixed(1)}`;
  });
  return (
    <svg width={40} height={34} viewBox="0 -2 40 36" className="key-curve" aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

const W = 200;
const H = 150;
// El cuadro 0-1 deja sitio arriba y abajo para curvas que se pasan (rebote).
const PAD_Y = 0.35;
const sx = (x: number) => 8 + x * (W - 16);
const sy = (y: number) => H - 8 - ((y + PAD_Y) / (1 + 2 * PAD_Y)) * (H - 16);

/** Editor de curva con dos tiradores que se arrastran (salida y entrada). Mayús ajusta a pasos de 0,05. */
export function CurveEditor({ value, onChange }: { value: Bezier; onChange: (b: Bezier) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [x1, y1, x2, y2] = value;
  const pts = Array.from({ length: 41 }, (_, i) => {
    const p = i / 40;
    return `${sx(p).toFixed(1)},${sy(easeAt("custom", value, p) ?? 0).toFixed(1)}`;
  });

  const drag = (handle: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = ref.current!;
    const move = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const py = ((ev.clientY - r.top) / r.height) * H;
      let x = Math.min(1, Math.max(0, (px - 8) / (W - 16)));
      let y = Math.min(1 + PAD_Y, Math.max(-PAD_Y, ((H - 8 - py) / (H - 16)) * (1 + 2 * PAD_Y) - PAD_Y));
      const snap = ev.shiftKey ? 0.05 : 0.01;
      x = Math.round(x / snap) * snap;
      y = Math.round(y / snap) * snap;
      const b: Bezier = [...value];
      b[handle * 2] = +x.toFixed(2);
      b[handle * 2 + 1] = +y.toFixed(2);
      onChange(b);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="curve-editor">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Editor de curva">
        <rect x={sx(0)} y={sy(1)} width={sx(1) - sx(0)} height={sy(0) - sy(1)} className="ce-box" />
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} className="ce-grid">
            <line x1={sx(g)} x2={sx(g)} y1={sy(1)} y2={sy(0)} />
            <line x1={sx(0)} x2={sx(1)} y1={sy(g)} y2={sy(g)} />
          </g>
        ))}
        <line className="ce-arm" x1={sx(0)} y1={sy(0)} x2={sx(x1)} y2={sy(y1)} />
        <line className="ce-arm" x1={sx(1)} y1={sy(1)} x2={sx(x2)} y2={sy(y2)} />
        <polyline className="ce-curve" points={pts.join(" ")} />
        <circle className="ce-end" cx={sx(0)} cy={sy(0)} r={3.5} />
        <circle className="ce-end" cx={sx(1)} cy={sy(1)} r={3.5} />
        <circle className="ce-handle out" cx={sx(x1)} cy={sy(y1)} r={6} onPointerDown={drag(0)}>
          <title>Salida de la clave anterior</title>
        </circle>
        <circle className="ce-handle in" cx={sx(x2)} cy={sy(y2)} r={6} onPointerDown={drag(1)}>
          <title>Entrada a esta clave</title>
        </circle>
      </svg>
      <div className="ce-legend small muted">
        <span><i className="ce-dot out" /> Salida ({x1.toFixed(2)}, {y1.toFixed(2)})</span>
        <span><i className="ce-dot in" /> Entrada ({x2.toFixed(2)}, {y2.toFixed(2)})</span>
      </div>
    </div>
  );
}

interface PickerProps<E extends CamEase> {
  ease: E;
  bezier?: Bezier;
  labels: Record<E, string>;
  onChange: (ease: E, bezier: Bezier | undefined) => void;
}

/** Curva de una clave: miniatura, lista de curvas y, en «personalizada», el editor con tiradores. Arrastrar el editor
 *  desde una curva de la lista la convierte en personalizada. */
export function EasePicker<E extends CamEase>({ ease, bezier, labels, onChange }: PickerProps<E>) {
  const shown = easeBezier(ease, bezier);
  const custom = "custom" as E;
  return (
    <>
      <CurveThumb ease={ease} bezier={bezier} />
      <select className="small-select grow" value={ease} aria-label="Curva" title="Cómo llega a esta clave desde la anterior"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = e.target.value as E;
          onChange(v, v === "custom" ? [...(easeBezier(ease, bezier) ?? [0.42, 0, 0.58, 1])] as Bezier : undefined);
        }}>
        {(Object.keys(labels) as E[]).map((v) => <option key={v} value={v}>{labels[v]}</option>)}
      </select>
      {shown && (
        <details className="ce-wrap" onClick={(e) => e.stopPropagation()} open={ease === "custom"}>
          <summary className="small muted">Curva (salida y entrada)</summary>
          <CurveEditor value={shown} onChange={(b) => onChange(custom, b)} />
        </details>
      )}
    </>
  );
}
