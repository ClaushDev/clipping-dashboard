import { ArrowDown, ArrowLineUp, ArrowUp, CaretDown, CaretRight, Pause, Play, Stop } from "@phosphor-icons/react";
import { useState } from "react";
import { api, type JobRow, type StepEvent } from "../api";
import { DoneStepRow, fmtTokens } from "../components/ActivityDock";
import { kindClass } from "../components/Signal";
import { PageHead, timeAgo } from "../components/ui";
import { usePoll } from "../hooks";
import { NoSignal, useAsk } from "../project/StepKit";

const STATUS: Record<JobRow["status"], string> = {
  queued: "En cola", running: "En marcha", done: "Hecho", error: "Error", cancelled: "Parado",
};
const DONE_KIND: Record<JobRow["status"], string> = {
  queued: "k-queue", running: "k-idle", done: "k-render", error: "k-need", cancelled: "k-idle",
};

function Title({ j }: { j: JobRow }) {
  const name = j.title || `#${j.ref_id}`;
  return (
    <div className="ca-row-what">
      <b>{j.link ? <a href={j.link}>{name}</a> : name}</b>
      <small>{j.label}{j.stage ? ` · ${j.stage}` : ""}</small>
    </div>
  );
}

/** Los pasos de un trabajo (qué proceso o modelo corrió, cuánto tardó y cuántos tokens gastó). */
function JobSteps({ id, live }: { id: number; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ events: StepEvent[]; tokens: number } | null>(null);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) setData(await api.jobEvents(id).catch(() => ({ events: [], tokens: 0 })));
  };
  return (
    <div className="ca-row-edit job-steps-wrap">
      <button className="btn small ghost" onClick={toggle} aria-expanded={open}>
        {open ? <CaretDown size={13} /> : <CaretRight size={13} />} Pasos y modelos
      </button>
      {open && (
        <div className="job-steps">
          {!data && <span className="small muted">Cargando…</span>}
          {data && data.events.length === 0 && (
            <span className="small muted">{live ? "Aún no ha terminado ningún paso: el que corre ahora sale en el panel Actividad (abajo a la derecha)." : "Sin pasos guardados."}</span>
          )}
          {data?.events.map((ev) => <DoneStepRow key={ev.id} ev={ev} />)}
          {data && data.tokens > 0 && <span className="small faint">{fmtTokens(data.tokens)} tokens en total</span>}
        </div>
      )}
    </div>
  );
}

/** Actividad (la Cola de trabajos; rediseño): lo que está en marcha, lo que espera (en su orden) y lo último que
 *  terminó. Se para cualquier trabajo (el que está en marcha mata su render) y se cambia el orden de los que esperan.
 *  Todo pasa por un único hilo porque la gráfica se usa de uno en uno. */
export default function Cola() {
  const queue = usePoll(api.jobQueue, 2000);
  const live = usePoll(api.activity, 3000);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState("");
  const q = useAsk();
  const d = queue.data;
  // Color del trabajo en marcha: el del paso que corre ahora (IA, modelo local, render o audio)
  const kindOf = (id: number) => {
    const st = live.data?.jobs.find((j) => j.id === id)?.current[0];
    return st ? kindClass(st) : "k-idle";
  };

  async function act(id: number, fn: () => Promise<unknown>) {
    setBusy(id);
    setError("");
    try {
      await fn();
      await queue.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(0);
    }
  }

  const stop = (j: JobRow) => {
    const what = j.status === "running" ? "Se corta ahora y se pierde lo que lleva hecho" : "Sale de la cola";
    q.ask(`j${j.id}`, [{ text: `¿Parar «${j.title || j.label}»? ${what}. Puedes volver a lanzarlo después.`, yes: "Parar" }],
      () => void act(j.id, () => api.cancelJob(j.id)));
  };
  const ask = (j: JobRow) => q.view(`j${j.id}`) && <div className="ca-row-edit">{q.view(`j${j.id}`)}</div>;

  return (
    <div className="ca-page">
      <PageHead title="Actividad"
        subtitle="Renders, procesados y exportaciones van de uno en uno (la gráfica no da para dos). Para cualquiera o cambia el orden de los que esperan.">
        {d && (
          <button className={`btn ${d.paused ? "primary" : ""}`} onClick={() => act(-1, () => api.pauseJobs(!d.paused))}
            title={d.paused ? "Sigue con el siguiente trabajo" : "El que está en marcha termina y no empieza el siguiente"}>
            {d.paused ? <><Play size={15} /> Reanudar la cola</> : <><Pause size={15} /> Pausar la cola</>}
          </button>
        )}
      </PageHead>
      {!d && <div className="muted">{queue.error || "Cargando…"}</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {d?.paused && <div className="ca-strip k-queue"><b>Cola en pausa</b><span>No empieza ningún trabajo nuevo hasta que la reanudes.</span></div>}

      {d && (
        <section className="ca-sec" aria-label="En marcha">
          <div className="ca-sec-head"><h2>En marcha</h2><span className="ca-n">{d.running.length}</span></div>
          {d.running.length === 0 ? <NoSignal title="Nada en marcha" text="Cuando lances un render o un procesado aparecerá aquí." /> : (
            <div className="ca-rows plain">
              {d.running.map((j) => (
                <div className={`ca-row ca-job ${kindOf(j.id)}`} key={j.id}>
                  <Title j={j} />
                  <div className="ca-lib-acts">
                    <div className="ca-job-meter">
                      <div className="ca-meter"><span style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
                      <small className="tc">{Math.round(j.progress * 100)} %{j.started_at ? ` · empezó ${timeAgo(j.started_at)}` : ""}</small>
                    </div>
                    <button className="btn small danger" disabled={busy !== 0 || j.stopping || q.open} onClick={() => stop(j)}>
                      <Stop size={14} weight="fill" /> {j.stopping ? "Parando…" : "Parar"}</button>
                  </div>
                  {ask(j)}
                  <JobSteps id={j.id} live />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {d && (
        <section className="ca-sec" aria-label="En espera">
          <div className="ca-sec-head"><h2>En espera</h2><span className="ca-n">{d.queued.length}</span>
            {d.queued.length > 1 && <span className="small muted">se hacen de arriba abajo</span>}</div>
          {d.queued.length === 0 ? <NoSignal title="No hay nada esperando" /> : (
            <div className="ca-rows plain">
              {d.queued.map((j, i) => (
                <div className="ca-row ca-job-wait" key={j.id}>
                  <span className="ca-slate-n">{i + 1}</span>
                  <Title j={j} />
                  <div className="ca-lib-acts">
                    <small className="muted">en cola {timeAgo(j.created_at)}</small>
                    <button className="btn small ghost" disabled={busy !== 0 || i === 0} title="El siguiente" aria-label="Poner el primero"
                      onClick={() => act(j.id, () => api.moveJob(j.id, "top"))}><ArrowLineUp size={14} /></button>
                    <button className="btn small ghost" disabled={busy !== 0 || i === 0} title="Subir" aria-label="Subir"
                      onClick={() => act(j.id, () => api.moveJob(j.id, "up"))}><ArrowUp size={14} /></button>
                    <button className="btn small ghost" disabled={busy !== 0 || i === d.queued.length - 1} title="Bajar" aria-label="Bajar"
                      onClick={() => act(j.id, () => api.moveJob(j.id, "down"))}><ArrowDown size={14} /></button>
                    <button className="btn small ghost danger" disabled={busy !== 0 || q.open} title="Quitar de la cola" aria-label="Quitar de la cola"
                      onClick={() => stop(j)}><Stop size={14} /></button>
                  </div>
                  {ask(j)}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {d && d.recent.length > 0 && (
        <section className="ca-sec" aria-label="Terminados hace poco">
          <div className="ca-sec-head"><h2>Terminados hace poco</h2><span className="ca-n">{d.recent.length}</span></div>
          <div className="ca-rows plain">
            {d.recent.map((j) => (
              <div className="ca-row" key={j.id}>
                <Title j={j} />
                <div className="ca-lib-acts">
                  {j.status === "error" && j.error && <small className="warn-text ellipsis" title={j.error} style={{ maxWidth: 280 }}>{j.error}</small>}
                  <span className={`ca-chip ${DONE_KIND[j.status]}`}><span>{STATUS[j.status]}</span></span>
                  <small className="muted">{j.finished_at ? timeAgo(j.finished_at) : ""}</small>
                </div>
                <JobSteps id={j.id} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
