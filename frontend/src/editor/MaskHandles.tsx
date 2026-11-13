import { keyedAt, type Mask, type Overlay } from "../remotion/schema";
import { polyCenter } from "./MaskPanel";

interface Props {
  o: Overlay;
  playhead: number;
  drawing: boolean;
  /** Cambio continuo (arrastre) de la máscara. */
  onChange: (mask: Mask) => void;
}

const clamp = (v: number) => +Math.min(1.5, Math.max(-0.5, v)).toFixed(4);

/** Contorno de la máscara sobre la vista previa: se arrastra entera desde el centro, los puntos del polígono uno
 *  a uno, y en modo dibujo cada clic añade un punto. */
export default function MaskHandles({ o, playhead, drawing, onChange }: Props) {
  const m = o.mask;
  if (!m || m.shape === "subject") return null;
  // En las capas de ajuste, las claves mueven y escalan la máscara: se enseña donde está en el cursor.
  const k = o.kind === "adjust" && o.keys?.length ? keyedAt(o, playhead - o.start) : null;
  const dx = k ? k.x - o.x : 0;
  const dy = k ? k.y - o.y : 0;
  const sc = k ? k.scale : 1;
  const pts = (m.points ?? []).map(([x, y]) => [m.x + dx + (x - m.x) * sc, m.y + dy + (y - m.y) * sc] as [number, number]);

  const drag = (e: React.PointerEvent, apply: (fx: number, fy: number) => Mask) => {
    e.preventDefault();
    e.stopPropagation();
    const box = (e.currentTarget.closest(".overlay-handle-layer") as HTMLElement).getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => onChange(apply((ev.clientX - sx) / box.width, (ev.clientY - sy) / box.height));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const moveAll = (e: React.PointerEvent) => drag(e, (fx, fy) => ({
    ...m, x: clamp(m.x + fx), y: clamp(m.y + fy),
    points: m.points?.map(([x, y]) => [clamp(x + fx), clamp(y + fy)] as [number, number]),
  }));
  const movePoint = (e: React.PointerEvent, i: number) => drag(e, (fx, fy) => {
    const points = (m.points ?? []).map((p, j) => (j === i ? [clamp(p[0] + fx / sc), clamp(p[1] + fy / sc)] : p) as [number, number]);
    const [x, y] = polyCenter(points);
    return { ...m, points, x, y };
  });
  const addPoint = (e: React.PointerEvent) => {
    if (!drawing || m.shape !== "poly") return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const points = [...(m.points ?? []), [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)] as [number, number]];
    const [x, y] = polyCenter(points);
    onChange({ ...m, points, x, y });
  };

  const cx = m.x + dx;
  const cy = m.y + dy;
  return (
    <div className={`overlay-handle-layer mask-layer ${drawing ? "drawing" : ""}`} onPointerDown={addPoint}>
      <svg className="mask-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {m.shape === "poly" ? (
          pts.length > 1 && <polygon points={pts.map(([x, y]) => `${x * 100},${y * 100}`).join(" ")} />
        ) : m.shape === "ellipse" ? (
          <ellipse cx={cx * 100} cy={cy * 100} rx={(m.w * sc * 100) / 2} ry={(m.h * sc * 100) / 2} />
        ) : (
          <rect x={(cx - (m.w * sc) / 2) * 100} y={(cy - (m.h * sc) / 2) * 100} width={m.w * sc * 100} height={m.h * sc * 100} />
        )}
      </svg>
      {m.shape === "poly" && pts.map(([x, y], i) => (
        <div key={i} className="mask-point" style={{ left: `${x * 100}%`, top: `${y * 100}%` }} title="Arrastra el punto"
          onPointerDown={(e) => movePoint(e, i)} />
      ))}
      {(m.shape !== "poly" || pts.length >= 3) && (
        <div className="mask-center" style={{ left: `${cx * 100}%`, top: `${cy * 100}%` }} title="Arrastra para mover la máscara"
          onPointerDown={moveAll} />
      )}
    </div>
  );
}
