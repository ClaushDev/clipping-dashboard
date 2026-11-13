import { CaretDown, CaretUp, CheckCircle, Cpu, Queue, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api, type Activity, type LiveStep, type StepEvent } from "../api";
import { kindClass } from "./Signal";

/** «1 min 05 s», «42 s», «1 h 03 min». */
export function fmtSecs(s: number): string {
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t} s`;
  if (t < 3600) return `${Math.floor(t / 60)} min${t % 60 ? ` ${String(t % 60).padStart(2, "0")} s` : ""}`;
  return `${Math.floor(t / 3600)} h ${String(Math.floor((t % 3600) / 60)).padStart(2, "0")} min`;
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n);
}

const isAI = (kind: string) => kind === "llm" || kind === "agent";
/** Segundos que lleva un paso, contando en el navegador entre una consulta y la siguiente. */
const since = (st: LiveStep, now: number) => Math.max(st.elapsed, now - Date.parse(st.started_at) / 1000);

/** El paso en marcha: qué es, con qué modelo, cuánto lleva frente a lo que suele tardar y a su límite. */
export function LiveStepRow({ st, now }: { st: LiveStep; now: number }) {
  const elapsed = since(st, now);
  const scale = st.limit ?? (st.typical ? st.typical * 1.5 : null);
  const pct = st.progress != null ? st.progress * 100 : scale ? Math.min(100, (elapsed / scale) * 100) : null;
  const slow = st.typical != null && elapsed > st.typical * 1.3;
  return (
    <div className="act-step live">
      <div className="act-step-head">
        <span className="spin-dot" aria-hidden />
        <span className="act-step-label">{st.label}</span>
        <span className="act-time" title="Tiempo que lleva">{fmtSecs(elapsed)}</span>
      </div>
      <div className="act-model">
        <span className={`act-chip ${isAI(st.kind) ? "ai" : "local"} ${kindClass(st)}`}>
          {isAI(st.kind) ? <Sparkle size={11} weight="fill" /> : <Cpu size={11} />} {st.model || st.kind_label}
        </span>
        {st.detail && <span className="faint">{st.detail}</span>}
      </div>
      {pct != null && (
        <div className={`act-bar ${st.progress == null ? "time" : ""} ${slow ? "slow" : ""}`} role="progressbar" aria-valuenow={Math.round(pct)}
          aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
          {st.progress == null && st.typical && scale && <i style={{ left: `${Math.min(100, (st.typical / scale) * 100)}%` }} title="Lo que suele tardar" />}
        </div>
      )}
      <div className="act-hint">
        {st.progress != null ? `${Math.round(st.progress * 100)} %` : isAI(st.kind) ? "La IA responde de golpe al terminar: no hay avance intermedio." : ""}
        {st.typical != null && ` · suele tardar ${fmtSecs(st.typical)}`}
        {st.limit != null && ` · límite ${fmtSecs(st.limit)}`}
        {slow && " · va más lento de lo normal"}
      </div>
    </div>
  );
}

export function DoneStepRow({ ev }: { ev: StepEvent }) {
  const tokens = ev.tokens_in + ev.tokens_out;
  return (
    <div className={`act-step done ${ev.ok ? "" : "bad"}`} title={ev.error || undefined}>
      {ev.ok ? <CheckCircle size={14} weight="fill" className="ok" /> : <WarningCircle size={14} weight="fill" className="danger" />}
      <span className="act-step-label">{ev.label}</span>
      <span className="faint act-step-model">{ev.model}</span>
      <span className="act-time">{fmtSecs(ev.secs)}{tokens ? ` · ${fmtTokens(tokens)} tok` : ""}</span>
    </div>
  );
}

/** Panel fijo «Actividad»: en todas las pantallas, qué trabajo corre, en qué paso y con qué modelo. */
export default function ActivityDock({ home = false }: { home?: boolean }) {
  const [data, setData] = useState<Activity | null>(null);
  const [open, setOpen] = useState(() => localStorage.getItem("fs-activity") === "1");
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [pulse, setPulse] = useState(false);
  const seen = useRef<Set<number>>(new Set());

  const busy = !!data && (data.jobs.length > 0 || data.direct.length > 0);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const d = await api.activity();
        if (!alive) return;
        const ids = d.jobs.map((j) => j.id);
        if (ids.some((id) => !seen.current.has(id)) && seen.current.size + ids.length > 0) {
          setPulse(true);
          window.setTimeout(() => setPulse(false), 2400);
        }
        ids.forEach((id) => seen.current.add(id));
        setData(d);
        timer = window.setTimeout(tick, d.jobs.length || d.direct.length ? 1500 : 5000);
      } catch {
        if (alive) timer = window.setTimeout(tick, 8000);
      }
    };
    tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem("fs-activity", next ? "1" : "0"); } catch { /* Sin almacenamiento */ }
  };

  if (!data || (!busy && data.queued === 0 && !open)) return null;

  const job = data.jobs[0];
  const live = [...(job?.current ?? []), ...data.direct];
  const head = live[live.length - 1];
  const summary = head ? `${head.label} · ${head.model || head.kind_label}` : job ? job.stage || job.label : data.queued ? `${data.queued} en cola${data.paused ? " (pausada)" : ""}` : "Nada en marcha";

  return (
    <section className={`act-dock ${open ? "open" : ""} ${pulse ? "pulse" : ""} ${home ? "home" : ""}`} aria-label="Actividad">
      <button className={`act-pill ${head ? kindClass(head) : "k-queue"}`} onClick={toggle} aria-expanded={open} title={open ? "Plegar la actividad" : "Ver qué está corriendo"}>
        {busy ? <span className="spin-dot" aria-hidden /> : <Queue size={14} />}
        <span className="act-pill-text">{summary}</span>
        {head && <span className="act-time">{fmtSecs(since(head, now))}</span>}
        {open ? <CaretDown size={13} /> : <CaretUp size={13} />}
      </button>
      {open && (
        <div className="act-body">
          {!busy && <p className="small muted" style={{ margin: 0 }}>Nada en marcha ahora mismo.</p>}
          {data.jobs.map((j) => (
            <article key={j.id} className="act-job">
              <header>
                <div className="stack" style={{ gap: 0, minWidth: 0 }}>
                  <b className="ellipsis">{j.label}</b>
                  {j.title && <span className="small muted ellipsis">{j.title}</span>}
                </div>
                <a className="small" href="#/actividad">Actividad</a>
              </header>
              {j.stage && <div className="small act-stage">{j.stage}</div>}
              {j.progress > 0 && (
                <div className="act-bar" role="progressbar" aria-valuenow={Math.round(j.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${j.progress * 100}%` }} />
                </div>
              )}
              <div className="act-steps">
                {j.steps.map((ev) => <DoneStepRow key={ev.id} ev={ev} />)}
                {j.current.map((st) => <LiveStepRow key={st.id} st={st} now={now} />)}
                {!j.current.length && <div className="act-hint">Preparando el siguiente paso…</div>}
              </div>
              <footer className="small faint">
                {j.started_at && `Empezó hace ${fmtSecs(now - Date.parse(j.started_at.endsWith("Z") ? j.started_at : `${j.started_at}Z`) / 1000)}`}
                {j.typical != null && ` · suele tardar ${fmtSecs(j.typical)}`}
                {j.step_count > 0 && ` · ${j.step_count} paso${j.step_count === 1 ? "" : "s"}`}
                {j.tokens > 0 && ` · ${fmtTokens(j.tokens)} tokens`}
              </footer>
            </article>
          ))}
          {data.direct.length > 0 && (
            <article className="act-job">
              <header><b>Peticiones directas</b><span className="small faint">fuera de la cola</span></header>
              <div className="act-steps">{data.direct.map((st) => <LiveStepRow key={st.id} st={st} now={now} />)}</div>
            </article>
          )}
          {data.queued > 0 && (
            <div className="small muted act-next">
              {data.queued} en cola{data.paused ? " · pausada" : ""}
              {data.next[0] && <> · siguiente: {data.next[0].label}{data.next[0].title ? ` (${data.next[0].title})` : ""}</>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
