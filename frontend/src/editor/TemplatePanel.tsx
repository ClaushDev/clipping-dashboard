import type { GraphicOverlay } from "../remotion/schema";
import type { Asset } from "../types";
import { TEMPLATES, type TemplateField } from "./templates";

interface Props {
  o: GraphicOverlay;
  images: Asset[];
  onChange: (patch: Partial<GraphicOverlay>) => void;
}

type Msg = { from: string; text: string };
type Head = { source: string; text: string };

/** Texto del campo para editarlo y su vuelta a datos (listas una por línea, chat con «>» para los tuyos…). */
function toText(f: TemplateField, v: unknown): string {
  const list = Array.isArray(v) ? v : [];
  if (f.type === "lines") return list.join("\n");
  if (f.type === "numbers") return list.join(", ");
  if (f.type === "chat") return (list as Msg[]).map((m) => `${m.from === "me" ? "> " : ""}${m.text}`).join("\n");
  if (f.type === "headlines") return (list as Head[]).map((h) => (h.source ? `${h.source} | ${h.text}` : h.text)).join("\n");
  return v === undefined || v === null ? "" : String(v);
}

function fromText(f: TemplateField, s: string): unknown {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  if (f.type === "lines") return lines;
  if (f.type === "numbers") return s.split(/[,;\s]+/).map(Number).filter((n) => Number.isFinite(n));
  if (f.type === "chat") return lines.map((l) => (l.startsWith(">") ? { from: "me", text: l.slice(1).trim() } : { from: "them", text: l }));
  if (f.type === "headlines") return lines.map((l) => {
    const [a, ...b] = l.split("|");
    return b.length ? { source: a.trim(), text: b.join("|").trim() } : { source: "", text: a.trim() };
  });
  if (f.type === "number") return Number(s) || 0;
  return s;
}

/** Panel de una plantilla: su contenido, el color de acento y cambiar a otra plantilla. */
export default function TemplatePanel({ o, images, onChange }: Props) {
  const info = TEMPLATES[o.component];
  const setProp = (key: string, value: unknown) => onChange({ props: { ...o.props, [key]: value } });
  if (!info) return <div className="small muted">Gráfico «{o.component}»: se mueve solo. Cambia su tamaño y sus tiempos abajo.</div>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <label className="field">
        Plantilla
        <select value={o.component} onChange={(e) => {
          const next = TEMPLATES[e.target.value];
          onChange({ component: e.target.value, props: { ...structuredClone(next.props), accent: o.props.accent } });
        }}>
          {Object.entries(TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
        </select>
      </label>
      <div className="small muted">{info.hint}</div>
      {info.fields.map((f) => {
        const v = o.props[f.key];
        if (f.type === "bool") {
          return <label key={f.key} className="check small"><input type="checkbox" checked={v !== false} onChange={(e) => setProp(f.key, e.target.checked)} /> {f.label}</label>;
        }
        if (f.type === "image") {
          return (
            <label key={f.key} className="field">{f.label}
              <select value={String(v ?? "")} onChange={(e) => setProp(f.key, e.target.value)}>
                <option value="">Sin imagen</option>
                {images.map((a) => <option key={a.url} value={a.url}>{a.name}</option>)}
              </select>
            </label>
          );
        }
        const multi = f.type === "lines" || f.type === "chat" || f.type === "headlines";
        return (
          <label key={f.key} className="field">{f.label}{f.hint && <span className="hint"> ({f.hint})</span>}
            {multi ? (
              // Sin estado propio: se reescribe en cada tecla y las líneas vacías se pierden; por eso se guarda al salir
              <textarea key={`${o.id}-${f.key}-${toText(f, v)}`} rows={4} defaultValue={toText(f, v)} onBlur={(e) => setProp(f.key, fromText(f, e.target.value))} />
            ) : (
              <input type={f.type === "number" ? "number" : "text"} key={`${o.id}-${f.key}-${toText(f, v)}`} defaultValue={toText(f, v)}
                onBlur={(e) => setProp(f.key, fromText(f, e.target.value))} />
            )}
          </label>
        );
      })}
      <label className="field">Color de acento
        <input type="color" value={String(o.props.accent ?? "#f5c518")} onChange={(e) => setProp("accent", e.target.value)} />
      </label>
    </div>
  );
}
