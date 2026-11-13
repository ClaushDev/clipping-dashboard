import { ArrowCounterClockwise, Check, DownloadSimple, Export, PencilSimple, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { api } from "../api";
import { LAYOUT_OPTIONS } from "../components/LayoutPicker";
import { PunchBreakdown, RejectedMoments } from "../components/MomentPunch";
import QualityPanel, { QualityBadge } from "../components/QualityPanel";
import SourceIdea from "../components/SourceIdea";
import { PageHead } from "../components/ui";
import { usePoll } from "../hooks";
import { Adv, LiveAt, LiveNote, LiveProvider, NoSignal, Step, StepError, StepHead, StepTabs, useAsk, useStepRun } from "../project/StepKit";
import type { Clip, Source } from "../types";

const STAGE: Record<string, string> = {
  queued: "En cola", downloading: "Descargando", transcribing: "Transcribiendo", selecting: "Buscando momentos",
  rendering: "Renderizando", done: "Terminado", error: "Error",
};

const STATUS_LABEL: Record<string, string> = {
  queued: "En cola", scoring: "Puntuando", rendering: "Renderizando", review: "Por revisar",
  approved: "Aprobado", rejected: "Descartado", error: "Error",
};

const FILTERS: { value: string; label: string; match: (c: Clip) => boolean }[] = [
  { value: "", label: "Todos", match: () => true },
  { value: "review", label: "Por revisar", match: (c) => c.status === "review" },
  { value: "approved", label: "Aprobados", match: (c) => c.status === "approved" },
  { value: "rejected", label: "Descartados", match: (c) => c.status === "rejected" },
  { value: "busy", label: "Renderizando", match: (c) => ["queued", "scoring", "rendering"].includes(c.status) },
  { value: "error", label: "Con error", match: (c) => c.status === "error" },
];

const MODE_LABEL: Record<string, string> = {
  crop: "recorte", split: "pantalla dividida", fit_black: "bandas negras", fit_blur: "fondo desenfocado", fit_color: "fondo de color",
};

const ASPECT_RATIO: Record<string, string> = { "16:9": "16 / 9", "1:1": "1", "4:5": "4 / 5" };

const isRunning = (s: Source) => s.status !== "done" && s.status !== "error";

/** Ficha de un vídeo largo: el procesado (descarga, transcripción, momentos) y la revisión de sus clips. */
export default function Video({ id }: { id: number }) {
  const src = usePoll(() => api.source(id), 0, [id]);
  const running = !!src.data && isRunning(src.data);
  const live = usePoll(() => api.source(id), running ? 2500 : 0, [id, running]);
  const s = live.data ?? src.data;
  const reload = async () => { await src.reload(); await live.reload(); };

  if (!s) return <div className="muted">{src.error || "Cargando…"}</div>;
  return (
    <LiveProvider v={{ id: s.id, busy: isRunning(s), progress: s.progress, stage: STAGE[s.status] ?? s.status }}>
      <PageHead title={s.title || s.url} back={{ href: "#/videos", label: "Vídeos" }} />
      <Processing s={s} onChange={reload} />
      {s.status === "done" && <Review source={s} onChange={reload} />}
    </LiveProvider>
  );
}

function Processing({ s, onChange }: { s: Source; onChange: () => unknown }) {
  const [tab, setTab] = useState<"proc" | "idea">("proc");
  const r = useStepRun(onChange);
  const q = useAsk();
  const total = Object.values(s.clip_counts).reduce((a, b) => a + b, 0);
  const running = isRunning(s);
  const redo = () => q.ask("redo", [s.status === "done" && { text: "¿Volver a buscar los momentos? Se sustituyen los clips que no hayas tocado.", yes: "Volver a buscar" }],
    () => r.run("redo", () => api.retrySource(s.id, s.status === "done")));
  const remove = () => q.ask("del", [{ text: "¿Borrar este vídeo y todos sus clips? No se puede deshacer.", yes: "Borrar" }],
    () => r.run("del", async () => { await api.deleteSource(s.id); window.location.hash = "#/videos"; }));
  // La acción principal según el estado: reintentar si falló, marcar a mano si no salió nada
  const main = s.status === "error"
    ? <button className="btn primary" disabled={!!r.pending} onClick={redo}>Reintentar</button>
    : s.status === "done" && total === 0
      ? <a className="btn primary" href={`#/marcar?source=${s.id}`}>Marcar clips a mano</a>
      : s.status === "done"
        ? <a className="btn" href={`#/marcar?source=${s.id}`}>Marcar más clips</a>
        : <button className="btn primary" disabled>Procesando…</button>;
  return (
    <Step>
      <StepHead title="Procesado"
        meta={<>
          <span>{s.selection === "manual" ? "clips marcados a mano" : `${s.requested_clips} clips`}</span>
          <span>{s.aspect} · {LAYOUT_OPTIONS.find((o) => o.value === s.layout)?.label ?? s.layout}</span>
          {s.duration ? <span className="tc">{Math.round(s.duration / 60)} min</span> : null}
          <span>permiso: {s.permission_note}</span>
        </>}
        action={<>
          <div className="ca-go-row">{main}{q.view("redo")}</div>
          {running && <LiveNote />}
          {running && !r.busy && <span className="ca-livenote k-queue"><span className="what">{STAGE[s.status] ?? s.status}{s.stage_detail ? ` · ${s.stage_detail}` : ""}</span>
            <span className="tc">{Math.round(s.progress * 100)} %</span>
            <span className="ca-meter"><span style={{ width: `${s.progress * 100}%` }} /></span></span>}
          {running && <small>Al terminar, los clips aparecen aquí debajo para revisarlos.</small>}
        </>}>
        <b>{s.url}</b>
      </StepHead>
      <StepError error={r.error || (s.status === "error" ? s.error : "")} />
      {s.status === "done" && total === 0 && (
        <div className="notice">
          {s.selection === "manual" ? "Transcrito. Ahora marca tú los momentos en la onda o en la transcripción."
            : "No salió ningún clip. Márcalos a mano o vuelve a intentarlo con otras instrucciones."}
        </div>
      )}
      {s.selection !== "manual" && s.transcript_path && (
        <>
          <StepTabs label="Procesado" value={tab} onChange={setTab} tabs={[
            { id: "proc", label: "Momentos" },
            { id: "idea", label: "Idea del vídeo" },
          ]} />
          <div className="ca-tabpanel" role="tabpanel">
            {tab === "proc" && (
              <p className="small muted" style={{ margin: 0 }}>
                {running ? "La IA está buscando los momentos con la transcripción, el volumen y los cambios de plano."
                  : `${total} clip${total === 1 ? "" : "s"} propuesto${total === 1 ? "" : "s"}. En «Idea del vídeo» puedes ajustar de qué va el vídeo y qué es un buen momento antes de volver a buscar.`}
              </p>
            )}
            {tab === "idea" && <SourceIdea sourceId={s.id} onRedo={s.status === "done" || s.status === "error"
              ? () => r.run("redo", () => api.retrySource(s.id, true)) : undefined} />}
          </div>
        </>
      )}
      {!running && (
        <Adv summary="Avanzado: volver a buscar o borrar el vídeo">
          <div className="ca-step-acts">
            {s.status === "done" && <button className="btn" disabled={!!r.pending || r.busy} onClick={redo}>Volver a buscar momentos</button>}
            {q.view("redo")}
            <LiveAt r={r} at="redo" />
            <button className="btn danger" disabled={!!r.pending} onClick={remove}><Trash size={14} /> Borrar vídeo</button>
            {q.view("del")}
          </div>
        </Adv>
      )}
    </Step>
  );
}

type Tab = "video" | "qa";

const qaIssues = (c: Clip) => (c.quality ? c.quality.counts.error + c.quality.counts.warn : 0);
const qaBad = (c: Clip) => c.quality?.verdict === "problema";

/** Revisión: mira cada clip, retócalo en el editor si hace falta y apruébalo o descártalo. */
function Review({ source, onChange }: { source: Source; onChange: () => unknown }) {
  const clipsQ = usePoll(() => api.clips({ source_id: source.id }), 3000, [source.id]);
  const [tab, setTab] = useState<Tab>("video");
  const [filter, setFilter] = useState("");
  const [qualityFor, setQualityFor] = useState<Clip | null>(null);
  const q = useAsk();
  const [error, setError] = useState("");
  const clips = [...(clipsQ.data ?? [])].sort((a, b) => b.score - a.score || a.id - b.id);
  const approved = clips.filter((c) => c.status === "approved").length;
  const toReview = clips.filter((c) => c.status === "review").length;
  const pending = clips.filter((c) => ["review", "queued", "scoring", "rendering"].includes(c.status)).length;
  const shown = clips.filter(FILTERS.find((f) => f.value === filter)?.match ?? (() => true));
  const live = clips.filter((c) => c.status !== "rejected" && c.status !== "error" && c.video_url);
  const issues = live.reduce((n, c) => n + qaIssues(c), 0);
  const refresh = () => { clipsQ.reload(); onChange(); };

  async function act(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!clipsQ.data) return <div className="muted">{clipsQ.error || "Cargando clips…"}</div>;
  return (
    <Step>
      <StepHead title="Revisar clips"
        meta={<>
          <span><b>{clips.length}</b> clip{clips.length === 1 ? "" : "s"}</span>
          {toReview > 0 && <span><b>{toReview}</b> por revisar</span>}
          {approved > 0 && <span><b>{approved}</b> aprobado{approved === 1 ? "" : "s"}</span>}
        </>}
        action={<>
          <div className="ca-go-row">
            <a className={`btn ${approved ? "primary" : ""}`} href={approved ? `#/exportar?source=${source.id}` : undefined} aria-disabled={!approved}
              title={approved ? "Exportar los clips aprobados" : "Aprueba al menos un clip"}>
              <Export size={15} /> Exportar aprobados{approved ? ` (${approved})` : ""}
            </a>
          </div>
          {pending > 0 && <small>Quedan {pending} por revisar o renderizar.</small>}
        </>}>
        Mira cada clip, retócalo en el editor si hace falta y apruébalo o descártalo.
      </StepHead>
      <StepError error={error} />

      <StepTabs<Tab> label="Revisión" value={tab} onChange={setTab} tabs={[
        { id: "video", label: "Clips", count: toReview, need: true },
        { id: "qa", label: "Calidad", count: issues, need: live.some(qaBad) },
      ]} />

      {tab === "video" && (
        <div className="ca-tabpanel" role="tabpanel">
          {clips.length > 3 && (
            <div className="ca-step-acts">
              <label className="small muted" htmlFor={`f-${source.id}`}>Ver</label>
              <select id={`f-${source.id}`} className="small-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                {FILTERS.map((f) => {
                  const n = clips.filter(f.match).length;
                  return (f.value === "" || n > 0) && <option key={f.value} value={f.value}>{f.label} ({n})</option>;
                })}
              </select>
            </div>
          )}
          {clips.length === 0 && <NoSignal title="Aún no hay clips" text="Márcalos a mano o vuelve a buscar momentos." />}
          {source.selection !== "manual" && <RejectedMoments sourceId={source.id} onRescued={refresh} />}
          {clips.length > 0 && shown.length === 0 && <NoSignal title="Nada en esta vista" text="Prueba con otro filtro." />}
          <div className={`ca-review ${shown.length === 1 ? "one" : ""}`}>
            {shown.map((clip) => {
              const busy = ["queued", "scoring", "rendering"].includes(clip.status);
              const slateCls = clip.status === "approved" ? "ok" : clip.status === "review" ? "" : "off";
              return (
                <article className="ca-rv" key={clip.id}>
                  <div className="ca-rv-media" style={ASPECT_RATIO[clip.aspect] ? { aspectRatio: ASPECT_RATIO[clip.aspect] } : undefined}>
                    <span className={`ca-slate ${slateCls}`}><span>{String(source.id).padStart(3, "0")}</span><span>{clip.id}</span></span>
                    <span className="ca-rv-score" title="Potencial viral estimado por la IA">{clip.score}</span>
                    {clip.video_url && !busy ? (
                      <video src={clip.video_url} poster={clip.thumb_url} controls preload="none" playsInline />
                    ) : (
                      <div className="ph">
                        {clip.status === "error" ? "El render falló" : clip.status === "queued" ? "En cola…" : busy ? `${STATUS_LABEL[clip.status]} ${Math.round(clip.progress * 100)} %` : "Sin render todavía"}
                        {busy && <span className="ca-meter k-render"><span style={{ width: `${clip.progress * 100}%` }} /></span>}
                      </div>
                    )}
                  </div>
                  <div className="ca-rv-body">
                    <span className={`ca-state ${clip.status}`}>{STATUS_LABEL[clip.status] ?? clip.status}</span>
                    <h3>{clip.title || `Clip ${clip.id}`}{clip.origin === "manual" && <span className="tag" style={{ marginLeft: 6 }}>manual</span>}
                      {clip.origin === "rescued" && <span className="tag" style={{ marginLeft: 6 }}>rescatado</span>}
                      {clip.breakdown?.via === "advocate" && <span className="tag" style={{ marginLeft: 6 }} title="Lo rescató la segunda pasada de la IA">2.ª pasada</span>}
                      {clip.breakdown?.via === "signals" && <span className="tag" style={{ marginLeft: 6 }} title="Entró por sus señales (audio, energía, giros, más vistos)">señales</span>}</h3>
                    <span className="meta">
                      {clip.duration.toFixed(0)} s{clip.aspect ? ` · ${clip.aspect}` : ""}
                      {clip.resolved_mode ? ` · ${MODE_LABEL[clip.resolved_mode] ?? clip.resolved_mode}` : ""}
                    </span>
                    {clip.hook && <span className="hook">Gancho: {clip.hook}</span>}
                    {clip.reason && <span className="why">{clip.reason}</span>}
                    {clip.status === "error" && <span className="bad">{clip.error}</span>}
                    {clip.breakdown && (
                      <Adv summary="Por qué esta nota"><PunchBreakdown b={clip.breakdown} score={clip.score} /></Adv>
                    )}
                  </div>
                  <div className="ca-rv-acts">
                    {clip.status === "review" && (
                      <>
                        <button className="btn small primary" onClick={() => act(() => api.patchClip(clip.id, { status: "approved" }))}><Check size={14} /> Aprobar</button>
                        <button className="btn small" onClick={() => act(() => api.patchClip(clip.id, { status: "rejected" }))}>Descartar</button>
                      </>
                    )}
                    {(clip.status === "approved" || clip.status === "rejected") && (
                      <button className="btn small" title="Volver a revisión" onClick={() => act(() => api.patchClip(clip.id, { status: "review" }))}>
                        <ArrowCounterClockwise size={14} /> Revisar</button>
                    )}
                    {clip.status === "error" && <button className="btn small primary" onClick={() => act(() => api.renderClip(clip.id))}>Reintentar</button>}
                    {!busy && <a className="btn small ghost" href={`#/editor?clip=${clip.id}`} title="Abrir en el editor"><PencilSimple size={14} /> Editar</a>}
                  </div>
                  {!busy && (
                    <Adv summary="Más">
                      <div className="row" style={{ gap: 6 }}>
                        {clip.video_url && <a className="btn small" href={`/api/clips/${clip.id}/download`} download><DownloadSimple size={14} /> Descargar MP4</a>}
                        {clip.has_captions && <a className="btn small" href={api.subtitlesUrl(clip.id, "srt")} download>Subtítulos .srt</a>}
                        <button className="btn small danger" onClick={() => q.ask(`del-${clip.id}`, [{ text: `¿Borrar «${clip.title || "este clip"}»? No se puede deshacer.`, yes: "Borrar" }],
                          () => act(() => api.deleteClip(clip.id)))}><Trash size={14} /> Borrar</button>
                      </div>
                      {q.view(`del-${clip.id}`)}
                    </Adv>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}

      {tab === "qa" && (
        <div className="ca-tabpanel" role="tabpanel">
          <p className="small muted" style={{ margin: 0 }}>
            Los filtros de calidad miran el plan y el MP4 (silencios, subtítulos fuera de la zona segura, volumen…).
            Pulsa una nota para ver el detalle.
          </p>
          {live.length === 0 ? <NoSignal title="Nada que revisar aún" text="Aparece cuando hay clips renderizados." /> : (
            <div className="ca-qrows">
              {live.map((c) => (
                <div key={c.id} className={`ca-qrow ${qaBad(c) ? "need" : ""}`}>
                  {c.thumb_url ? <img src={c.thumb_url} alt="" /> : <span className="noimg" />}
                  <span>
                    <b>{c.title || `Clip ${c.id}`}</b>
                    <small>{c.quality ? `Calidad ${c.quality.score} · ${c.quality.counts.error} errores, ${c.quality.counts.warn} avisos` : "Calidad sin comprobar"}</small>
                  </span>
                  <span className="acts">
                    {c.quality ? <QualityBadge q={c.quality} onClick={() => setQualityFor(c)} />
                      : <button className="btn small" onClick={() => setQualityFor(c)}>Comprobar calidad</button>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {qualityFor && (
        <QualityPanel title={qualityFor.title} editHref={`#/editor?clip=${qualityFor.id}`}
          load={async () => (await api.clip(qualityFor.id)).quality ?? api.checkQuality(qualityFor.id)}
          recheck={() => api.checkQuality(qualityFor.id)}
          onClose={() => { setQualityFor(null); refresh(); }} />
      )}
    </Step>
  );
}
