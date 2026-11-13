import { FilmSlate, MagnifyingGlass, PencilSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { fmtDuration, PageHead } from "../components/ui";

const STATUS_LABEL: Record<string, string> = {
  review: "Por revisar", approved: "Aprobado", rejected: "Descartado", error: "Error",
};

/** «Editor» sin clip: elige cualquier clip ya montado y ábrelo en el editor. */
export default function EditorVideos() {
  const list = usePoll(() => api.clips({ status: "review,approved,rejected,error" }), 0);
  const sources = usePoll(api.sources, 0);
  const [q, setQ] = useState("");
  const all = [...(list.data ?? [])].sort((a, b) => b.id - a.id);
  const sourceName = (id: number) => { const s = sources.data?.find((x) => x.id === id); return s ? s.title || s.url : ""; };
  const needle = q.trim().toLowerCase();
  const shown = all.filter((c) => !needle || `${c.title} ${sourceName(c.source_id)}`.toLowerCase().includes(needle));

  return (
    <div className="stack">
      <PageHead title="Editor" subtitle="Elige un clip y ábrelo en el editor." />
      <label className="row" style={{ gap: 6 }}>
        <MagnifyingGlass size={15} />
        <input type="search" value={q} placeholder="Buscar por título o vídeo" onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
      </label>
      {list.error && <div className="notice error">{list.error}</div>}
      {!list.data && !list.error && <div className="muted small">Cargando…</div>}
      {list.data && shown.length === 0 && (
        <div className="card empty"><strong>No hay clips montados</strong><a href="#/nuevo">Procesar un vídeo</a></div>
      )}
      <div className="editor-pick-grid">
        {shown.map((c) => (
          <div key={c.id} className="card editor-pick">
            {c.thumb_url ? <img src={c.thumb_url} alt="" loading="lazy" /> : <div className="editor-pick-ph"><FilmSlate size={28} /></div>}
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <strong className="ellipsis" title={c.title}>{c.title || `Clip ${c.id}`}</strong>
              <span className="small muted ellipsis">
                <span className="tag">{STATUS_LABEL[c.status] ?? c.status}</span> {sourceName(c.source_id)}{c.duration ? ` · ${fmtDuration(c.duration)}` : ""}
              </span>
            </div>
            <a className="btn small primary" href={`#/editor?clip=${c.id}`}><PencilSimple size={14} /> Abrir en el editor</a>
          </div>
        ))}
      </div>
    </div>
  );
}
