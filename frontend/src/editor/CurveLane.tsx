import { useRef } from "react";
import { valueAt, type ValueKey } from "../remotion/schema";

interface Props {
  keys?: ValueKey[];
  /** Valor sin claves (el volumen fijo de la pista o del tramo). */
  base: number;
  /** Largo en las unidades de `t` de las claves. */
  len: number;
  w: number;
  h: number;
  /** T de las claves → píxeles dentro del carril, y al revés. */
  toPx: (t: number) => number;
  fromPx: (px: number) => number;
  max?: number;
  fmt?: (v: number) => string;
  /** Merge = parte del mismo arrastre (un solo paso de deshacer). Sin claves = undefined. */
  onChange: (keys: ValueKey[] | undefined, merge: boolean) => void;
  className?: string;
}

const PAD = 5;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const pct = (v: number) => `${Math.round(v * 100)} %`;

/** Curva de volumen que se dibuja y se edita en la propia línea de tiempo (carril ampliado), como la «goma» de
 *  Premiere. Clic en el carril = clave nueva · arrastrar una clave = moverla (Mayús: solo en vertical) · doble clic o
 *  Alt+clic en una clave = quitarla. Arriba = `max` (150 %), abajo = mudo. */
export default function CurveLane({ keys, base, len, w, h, toPx, fromPx, max = 1.5, fmt = pct, onChange, className = "" }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const y = (v: number) => PAD + (1 - clamp(v, 0, max) / max) * (h - 2 * PAD);
  const vAt = (py: number) => +clamp((1 - (py - PAD) / Math.max(1, h - 2 * PAD)) * max, 0, max).toFixed(3);
  const list = keys ?? [];

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  /** Arrastra la clave i de `start`; la primera escritura abre un paso de deshacer salvo `joined`. */
  function drag(e: React.PointerEvent, i: number, start: ValueKey[], joined: boolean) {
    e.stopPropagation();
    e.preventDefault();
    let cur = start;
    let merge = joined;
    const t0 = start[i].t;
    const move = (ev: PointerEvent) => {
      const [px, py] = local(ev);
      const prev = cur[i - 1];
      const next = cur[i + 1];
      const t = ev.shiftKey ? t0 : clamp(fromPx(px), prev ? prev.t + 0.01 : 0, next ? next.t - 0.01 : len);
      cur = cur.map((k, j) => (j === i ? { ...k, t: +t.toFixed(3), v: vAt(py) } : k));
      onChange(cur, merge);
      merge = true;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function remove(i: number) {
    const next = list.filter((_, j) => j !== i);
    onChange(next.length ? next : undefined, false);
  }

  function add(e: React.PointerEvent) {
    if (e.button) return;
    const [px, py] = local(e);
    const t = +clamp(fromPx(px), 0, len).toFixed(3);
    const next = [...list, { t, v: vAt(py) }].sort((a, b) => a.t - b.t);
    onChange(next, false);
    drag(e, next.findIndex((k) => k.t === t), next, true);
  }

  const step = Math.max(len / Math.max(8, w / 3), 0.01);
  let d = "";
  for (let t = 0; t <= len + 1e-6; t += step) d += `${d ? "L" : "M"}${toPx(t).toFixed(1)} ${y(valueAt(keys, t, base)).toFixed(1)}`;

  return (
    <svg ref={ref} className={`tl-curve ${className}`} width={w} height={h} onPointerDown={add}
      onContextMenu={(e) => e.stopPropagation()}>
      <title>Clic: clave de volumen · arrastra las claves · doble clic o Alt+clic: quitarla</title>
      <line className="tl-curve-unity" x1={0} x2={w} y1={y(1)} y2={y(1)} />
      <path d={d} />
      {list.map((k, i) => (
        <circle key={i} cx={toPx(k.t)} cy={y(k.v)} r={4.5}
          onPointerDown={(e) => { if (e.altKey) { e.stopPropagation(); remove(i); return; } drag(e, i, list, false); }}
          onDoubleClick={(e) => { e.stopPropagation(); remove(i); }}>
          <title>{fmt(k.v)} · doble clic para quitar</title>
        </circle>
      ))}
    </svg>
  );
}
