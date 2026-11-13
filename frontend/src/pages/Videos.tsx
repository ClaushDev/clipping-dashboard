import { Plus } from "@phosphor-icons/react";
import { api } from "../api";
import { LAYOUT_OPTIONS } from "../components/LayoutPicker";
import MomentAccuracy from "../components/MomentAccuracy";
import { PageHead, timeAgo } from "../components/ui";
import { usePoll } from "../hooks";
import { NoSignal } from "../project/StepKit";
import type { Source } from "../types";

const STAGE: Record<string, string> = {
  queued: "En cola", downloading: "Descargando", transcribing: "Transcribiendo", selecting: "Buscando momentos",
  rendering: "Renderizando", done: "Terminado", error: "Error",
};

function badgeClass(status: string) {
  if (status === "done") return "done";
  if (status === "error") return "error";
  if (status === "queued") return "queued";
  return "running";
}

/** Inicio: los vídeos largos procesados, con lo que queda por revisar de cada uno. */
export default function Videos() {
  const sources = usePoll(api.sources, 3000);
  const list = sources.data ?? [];
  return (
    <>
      <PageHead title="Vídeos" subtitle="Cada vídeo largo que procesas, con sus clips. Ábrelo para revisarlos, editarlos y exportarlos.">
        <a className="btn primary" href="#/nuevo"><Plus size={15} weight="bold" /> Nuevo vídeo</a>
      </PageHead>
      {sources.error && <div className="notice error">{sources.error}</div>}
      {sources.data && list.length === 0 && (
        <div className="card">
          <NoSignal title="Todavía no has procesado ningún vídeo" text={<> Empieza con <a href="#/nuevo">Nuevo vídeo</a>.</>} />
        </div>
      )}
      {list.length > 0 && (
        <div className="card">
          {list.map((s: Source) => {
            const total = Object.values(s.clip_counts).reduce((a, b) => a + b, 0);
            const toReview = s.clip_counts.review ?? 0;
            const approved = s.clip_counts.approved ?? 0;
            const running = s.status !== "done" && s.status !== "error";
            return (
              <a className="source-row" key={s.id} href={`#/video?id=${s.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                <div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
                  <div className="row">
                    <span className={`badge ${badgeClass(s.status)}`}>{STAGE[s.status] ?? s.status}</span>
                    <span className="source-title">{s.title || s.url}</span>
                  </div>
                  <div className="small muted">
                    {s.selection === "manual" ? "clips marcados a mano" : `${s.requested_clips} clips pedidos`} · {s.aspect} · {LAYOUT_OPTIONS.find((o) => o.value === s.layout)?.label ?? s.layout}
                    {s.duration ? ` · ${Math.round(s.duration / 60)} min` : ""}
                    {total ? ` · ${total} clips${toReview ? `, ${toReview} por revisar` : ""}${approved ? `, ${approved} aprobados` : ""}` : ""}
                    {s.created_at ? ` · ${timeAgo(s.created_at)}` : ""}
                  </div>
                  {running && (
                    <>
                      <div className="progress"><div style={{ transform: `scaleX(${s.progress})` }} /></div>
                      <div className="small muted">{s.stage_detail}</div>
                    </>
                  )}
                  {s.status === "error" && <div className="error-text">{s.error}</div>}
                </div>
                {s.thumb_url && <img src={s.thumb_url} alt="" style={{ height: 72, borderRadius: 4 }} />}
              </a>
            );
          })}
        </div>
      )}
      <MomentAccuracy />
    </>
  );
}
