import { ArrowLeft, Check, CopySimple } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";

/** Cabecera de página: título editorial, subtítulo y acciones a la derecha. */
export function PageHead({ title, subtitle, back, children }: { title: ReactNode; subtitle?: ReactNode; back?: { href: string; label: string }; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {back && <a className="back" href={back.href}><ArrowLeft size={14} /> {back.label}</a>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

/** Copia al portapapeles y confirma durante un momento. */
export function CopyButton({ text, label = "Copiar", className = "btn small" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(false), 1400);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <button type="button" className={className} disabled={!text} onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setDone(true);
      } catch {
        /* Sin permiso de portapapeles */
      }
    }}>
      {done ? <Check size={14} /> : <CopySimple size={14} />} {done ? "Copiado" : label}
    </button>
  );
}

const nf = new Intl.NumberFormat("es-ES");
const compact = new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 1 });

export function fmtNum(n: number | null | undefined, short = false): string {
  if (n === null || n === undefined) return "—";
  return short && Math.abs(n) >= 10000 ? compact.format(n) : nf.format(n);
}

export function timeAgo(iso: string): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) {
    const m = Math.round(-s / 60);
    return m < 60 ? `en ${m} min` : `en ${Math.round(m / 60)} h`;
  }
  if (s < 90) return "hace un momento";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400 * 2) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} días`;
}

export function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Curva simple en SVG (tiempo → valor). Sin dependencias; se adapta al ancho del contenedor. */
export function LineChart({ points, height = 160, format = (v: number) => fmtNum(v, true), label }: {
  points: { t: string; v: number }[]; height?: number; format?: (v: number) => string; label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) {
    return <div className="chart-empty small muted">La curva aparece a partir de la segunda lectura (se lee cada pocas horas).</div>;
  }
  const W = 600;
  const H = height;
  const pad = { l: 8, r: 8, t: 12, b: 22 };
  const ts = points.map((p) => new Date(p.t).getTime());
  const vs = points.map((p) => p.v);
  const t0 = ts[0];
  const t1 = ts[ts.length - 1] || t0 + 1;
  let v0 = Math.min(...vs);
  let v1 = Math.max(...vs);
  if (v0 === v1) { v0 -= 1; v1 += 1; }
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - v0) / (v1 - v0)) * (H - pad.t - pad.b);
  const d = points.map((_, i) => `${i ? "L" : "M"}${x(ts[i]).toFixed(1)},${y(vs[i]).toFixed(1)}`).join(" ");
  const area = `${d} L${x(t1).toFixed(1)},${H - pad.b} L${x(t0).toFixed(1)},${H - pad.b} Z`;
  const fmtDate = (t: number) => new Date(t).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  const h = hover !== null ? hover : null;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const tx = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
          let best = 0;
          ts.forEach((t, i) => { if (Math.abs(t - tx) < Math.abs(ts[best] - tx)) best = i; });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}>
        <path d={area} className="chart-area" />
        <path d={d} className="chart-line" vectorEffect="non-scaling-stroke" />
        {h !== null && <line x1={x(ts[h])} x2={x(ts[h])} y1={pad.t} y2={H - pad.b} className="chart-guide" vectorEffect="non-scaling-stroke" />}
      </svg>
      {h !== null && (
        <div className="chart-tip" style={{ left: `${(x(ts[h]) / W) * 100}%` }}>
          <strong>{format(vs[h])}</strong>
          <span>{new Date(ts[h]).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      )}
      <div className="chart-axis"><span>{fmtDate(t0)}</span><span>{format(v0)} – {format(v1)}</span><span>{fmtDate(t1)}</span></div>
    </div>
  );
}

/** Mini curva para tablas. */
export function Sparkline({ values, width = 90, height = 26 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <span className="faint small">—</span>;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} className="sparkline" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** Pestañas entre secciones hermanas de una entrada del menú. */
export function SubNav({ items, current }: { items: [string, string][]; current: string }) {
  return (
    <nav className="ca-subnav" aria-label="Secciones">
      {items.map(([path, label]) => (
        <a key={path} href={`#/${path}`} className={path === current ? "on" : ""} aria-current={path === current ? "page" : undefined}>{label}</a>
      ))}
    </nav>
  );
}
