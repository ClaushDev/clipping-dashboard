import { ArrowsClockwise, MagnifyingGlass, PencilSimple, Warning, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { BlockCatalog, BlockItem } from "../types";

const ORIENT: Record<string, string> = { all: "Cualquier formato", fill: "Se adaptan a la caja", "16:9": "Horizontales", "9:16": "Verticales" };

function orientation(b: BlockItem): string {
  if (!b.width || !b.height) return "fill";
  return b.width > b.height ? "16:9" : b.height > b.width ? "9:16" : "1:1";
}

/** Catálogo de bloques animados de HyperFrames: buscar, ver la vista previa y añadir uno en el cursor. */
export default function BlockPicker({ onPick, onClose }: { onPick: (b: BlockItem) => void; onClose: () => void }) {
  const [cat, setCat] = useState<BlockCatalog | null>(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [orient, setOrient] = useState("all");
  const [onlyEditable, setOnlyEditable] = useState(false);
  const [hideGpu, setHideGpu] = useState(true);
  const [busy, setBusy] = useState("");
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = () => api.blockCatalog().then((c) => {
      if (!alive) return;
      setCat(c);
      if (c.status.running) timer = window.setTimeout(load, 1500);
    }).catch((e) => alive && setError(String(e.message ?? e)));
    load();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    window.addEventListener("keydown", onKey);
    return () => { alive = false; window.clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, []);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (cat?.items ?? []).filter((b) =>
      (!category || b.category === category)
      && (orient === "all" || orientation(b) === orient)
      && (!onlyEditable || b.editable)
      && (!hideGpu || !b.gpu)
      && (!q || `${b.title} ${b.description} ${b.tags.join(" ")}`.toLowerCase().includes(q)));
  }, [cat, category, query, orient, onlyEditable, hideGpu]);

  async function pick(b: BlockItem) {
    setBusy(b.name);
    setError("");
    try {
      onPick(await api.installBlock(b.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy("");
    }
  }

  const status = cat?.status;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal block-picker" role="dialog" aria-label="Bloques animados">
        <div className="publish-head">
          <div>
            <h2>Bloques animados</h2>
            <div className="small muted">
              Rótulos, títulos, gráficos, mapas y tarjetas de redes del catálogo abierto de{" "}
              <a href={cat?.source ?? "https://github.com/heygen-com/hyperframes"} target="_blank" rel="noreferrer">HyperFrames</a>{" "}
              (licencia Apache 2.0). Se añaden en el cursor y sus textos y colores se cambian en el panel de la capa.
            </div>
          </div>
          <button className="btn small ghost" onClick={onClose} aria-label="Cerrar"><X size={16} /></button>
        </div>

        <div className="block-filters">
          <label className="block-search">
            <MagnifyingGlass size={15} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar: lower third, chart, map, title…" autoFocus />
          </label>
          <select className="small-select" value={orient} onChange={(e) => setOrient(e.target.value)} aria-label="Formato">
            {Object.entries(ORIENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <label className="check small"><input type="checkbox" checked={onlyEditable} onChange={(e) => setOnlyEditable(e.target.checked)} /> Con opciones editables</label>
          <label className="check small"><input type="checkbox" checked={hideGpu} onChange={(e) => setHideGpu(e.target.checked)} /> Ocultar 3D y shaders</label>
          <span className="spacer" />
          <button className="btn small ghost" disabled={status?.running} title="Volver a leer el catálogo" onClick={() => api.refreshBlockCatalog().then(() => setCat((c) => c && { ...c, status: { ...c.status, running: true } })).then(() => api.blockCatalog().then(setCat))}>
            <ArrowsClockwise size={14} className={status?.running ? "spin" : ""} />
          </button>
        </div>
        {cat && cat.categories.length > 0 && (
          <div className="chips">
            <button className={`chip ${!category ? "on" : ""}`} onClick={() => setCategory("")}>Todos</button>
            {cat.categories.map((c) => (
              <button key={c.key} className={`chip ${category === c.key ? "on" : ""}`} onClick={() => setCategory(c.key)}>{c.label} <span className="faint">{c.count}</span></button>
            ))}
          </div>
        )}

        {error && <div className="notice error small">{error}</div>}
        {status?.error && <div className="notice error small">{status.error}</div>}
        {status?.running && (
          <div className="notice info small">
            Leyendo el catálogo de HyperFrames{status.total ? ` (${status.done} de ${status.total})` : ""}… solo la primera vez.
          </div>
        )}

        <div className="block-grid">
          {items.map((b) => (
            <button key={b.name} className="block-card" disabled={!!busy} onClick={() => pick(b)} title={b.description}>
              <BlockThumb b={b} />
              <span className="block-card-title">{b.title}</span>
              <span className="block-card-meta">
                {orientation(b) === "fill" ? "Se adapta" : `${b.width}×${b.height}`} · {b.duration.toFixed(1)} s
                {b.editable && <span title="Tiene opciones editables"><PencilSimple size={12} /></span>}
                {b.gpu && <span title="3D o shaders: puede ir lento o no verse al renderizar"><Warning size={12} /></span>}
              </span>
              {busy === b.name && <span className="block-card-busy">Descargando…</span>}
            </button>
          ))}
        </div>
        {cat && !status?.running && items.length === 0 && <div className="empty">Ningún bloque con esos filtros.</div>}
      </div>
    </div>
  );
}

/** Póster del bloque; al pasar el ratón, su vídeo de muestra. */
function BlockThumb({ b }: { b: BlockItem }) {
  const [hover, setHover] = useState(false);
  return (
    <span className="block-thumb" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {b.poster && <img src={b.poster} alt="" loading="lazy" />}
      {hover && b.video && <video src={b.video} autoPlay muted loop playsInline />}
    </span>
  );
}
