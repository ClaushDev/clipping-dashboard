import { CaretRight } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type LiveStep, type VideoActivity } from "../api";
import { fmtSecs } from "../components/ActivityDock";
import { kindClass } from "../components/Signal";
import { usePoll } from "../hooks";

/* Piezas comunes de las pantallas de un vídeo:
   - cabecera del paso (título, una línea y, a la derecha, la ÚNICA acción principal, que cambia con lo que toca);
   - la lectura en vivo (paso, modelo, tiempo y medidor) pegada al botón que se pulsó;
   - pestañas;
   - lo avanzado, plegado en <details>. */

/** Lo que necesita la lectura en vivo de un vídeo: si está trabajando, su avance (0-1) y la fase. */
export interface LiveTarget { id: number; busy: boolean; progress: number; stage: string }
export const isWorking = (v: LiveTarget) => v.busy;

type Live = { v: LiveTarget; act: VideoActivity | null; now: number };
const LiveCtx = createContext<Live | null>(null);

/** Lee una sola vez lo que corre para el vídeo y lo reparte a la franja y a los botones de los pasos. */
export function LiveProvider({ v, children }: { v: LiveTarget; children: ReactNode }) {
  const busy = isWorking(v);
  const act = usePoll(() => api.sourceActivity(v.id), busy ? 2000 : 0, [v.id, busy]);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, [busy]);
  return <LiveCtx.Provider value={{ v, act: busy ? act.data : null, now }}>{children}</LiveCtx.Provider>;
}

/** El paso que corre ahora para el vídeo (o nada), con su tipo de color, su tiempo y su avance. */
export function useLive() {
  const ctx = useContext(LiveCtx);
  if (!ctx) return { busy: false, st: undefined as LiveStep | undefined, k: "k-gpu", elapsed: 0, pct: null as number | null, stage: "" };
  const { v, act, now } = ctx;
  const st = act?.live[act.live.length - 1];
  const k = st ? kindClass(st) : act?.jobs.some((j) => j.status === "running") ? "k-gpu" : "k-queue";
  const elapsed = st ? Math.max(st.elapsed, now - Date.parse(st.started_at) / 1000) : 0;
  const pct = st?.progress != null ? st.progress * 100 : v.progress > 0 ? v.progress * 100 : null;
  return { busy: isWorking(v), st, k, elapsed, pct, stage: v.stage };
}

/** Lectura compacta junto a un botón: modelo, tiempo (y lo que suele tardar) y medidor. */
export function LiveNote() {
  const { busy, st, k, elapsed, pct, stage } = useLive();
  if (!busy) return null;
  return (
    <span className={`ca-livenote ${k}`} aria-live="polite">
      <span className="what">{st ? st.label : stage || "En cola"}</span>
      {st && <span className={`ca-chip ${k}`}><span>{st.model || st.kind_label}</span></span>}
      {st && <span className="tc">{fmtSecs(elapsed)}{st.typical ? ` / ${fmtSecs(st.typical)}` : ""}</span>}
      <span className={`ca-meter ${st ? "" : "wait"}`} role="progressbar" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={pct != null ? Math.round(pct) : undefined}>
        <span style={{ width: `${pct ?? (st ? 4 : 0)}%` }} />
      </span>
    </span>
  );
}

/** Lanza acciones de un paso recordando qué botón se pulsó (su lectura en vivo sale ahí) y guardando el error. */
export function useStepRun(after?: () => unknown) {
  const { busy } = useLive();
  const [pressed, setPressed] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const seen = useRef(false);
  useEffect(() => {
    if (busy) seen.current = true;
    else if (seen.current) {
      seen.current = false;
      setPressed(null);
    }
  }, [busy]);
  async function run(key: string, fn: () => Promise<unknown>) {
    setError("");
    setPending(key);
    try {
      await fn();
      setPressed(key);
      await after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }
  return { run, pressed, pending, error, setError, busy };
}
export type StepRun = ReturnType<typeof useStepRun>;

/** La lectura en vivo, solo junto al botón `at` si fue el pulsado (o, si no se pulsó ninguno aquí, junto al principal). */
export function LiveAt({ r, at, main = false }: { r: StepRun; at: string; main?: boolean }) {
  if (!r.busy || !(r.pressed === at || (r.pressed === null && main))) return null;
  return <LiveNote />;
}

type Ask = { text: string; yes: string };

/** Confirmación dentro del paso, pegada al botón pulsado (en vez del confirm() del navegador).
    `ask(at, preguntas, fn)` encadena preguntas y solo lanza `fn` si se aceptan todas; `view(at)` la pinta junto a ese botón. */
export function useAsk() {
  const [q, setQ] = useState<{ at: string; text: string; yes: string; rest: Ask[]; fn: () => void } | null>(null);
  function ask(at: string, questions: (Ask | false | null | undefined | "")[], fn: () => void) {
    const list = questions.filter(Boolean) as Ask[];
    if (!list.length) return fn();
    setQ({ at, ...list[0], rest: list.slice(1), fn });
  }
  function view(at: string) {
    if (!q || q.at !== at) return null;
    return (
      <div className="ca-ask" role="alertdialog" aria-label="Confirmar">
        <p>{q.text}</p>
        <div className="ca-ask-acts">
          <button className="btn small ghost" onClick={() => setQ(null)}>Cancelar</button>
          <button className="btn small" autoFocus onClick={() => {
            const { at: where, rest, fn } = q;
            setQ(null);
            ask(where, rest, fn);
          }}>{q.yes}</button>
        </div>
      </div>
    );
  }
  return { ask, view, open: !!q };
}

/** Cabecera del paso: título, explicación corta y la acción principal a la derecha, con su lectura en vivo debajo. */
export function StepHead({ title, children, action, meta }: { title: ReactNode; children?: ReactNode; action?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="ca-step-head">
      <div className="ca-step-what">
        <h2>{title}</h2>
        {children && <p>{children}</p>}
        {meta && <div className="ca-step-meta">{meta}</div>}
      </div>
      {action && <div className="ca-go">{action}</div>}
    </header>
  );
}

/** Pestañas del paso (como en la maqueta: subrayado hueso, contador en mono; `need` lo marca en rojo). */
export function StepTabs<T extends string>({ tabs, value, onChange, label }: {
  tabs: { id: T; label: string; count?: number; need?: boolean; hidden?: boolean }[];
  value: T; onChange: (t: T) => void; label: string;
}) {
  const shown = tabs.filter((t) => !t.hidden);
  function key(e: React.KeyboardEvent, i: number) {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = shown[(i + d + shown.length) % shown.length];
    onChange(n.id);
    (e.currentTarget.parentElement?.querySelector(`[data-tab="${n.id}"]`) as HTMLElement | null)?.focus();
  }
  if (shown.length < 2) return null;  // Una pestaña sola no es una elección: se ve directamente su contenido
  return (
    <div className="ca-tabs" role="tablist" aria-label={label}>
      {shown.map((t, i) => (
        <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)} onKeyDown={(e) => key(e, i)}>
          {t.label}
          {t.count != null && t.count > 0 && <span className={`c ${t.need ? "need" : ""}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Barra de acción fija abajo en los formularios largos: lo elegido a la izquierda y la acción principal a la
 * derecha, siempre a la vista sin bajar. Dentro de un <form>, un botón sin type lo envía como siempre. */
export function ActionBar({ summary, children, label = "Acción principal" }: { summary?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <div className="ca-actionbar" role="region" aria-label={label}>
      <div className="ca-actionbar-sum">{summary}</div>
      <div className="ca-actionbar-acts">{children}</div>
    </div>
  );
}

/** Lo avanzado, plegado. */
export function Adv({ summary, children, open, hint }: { summary: ReactNode; children: ReactNode; open?: boolean; hint?: ReactNode }) {
  return (
    <details className="ca-adv" open={open}>
      <summary><CaretRight size={13} weight="bold" aria-hidden />{summary}{hint && <small>{hint}</small>}</summary>
      <div className="ca-adv-body">{children}</div>
    </details>
  );
}

/** Contenedor del paso. */
export function Step({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`ca-step ${className}`}>{children}</section>;
}

/** Estado vacío con la carta «sin señal». */
export function NoSignal({ title, text }: { title: string; text?: ReactNode }) {
  return (
    <div className="ca-empty">
      <span className="ca-nosig" aria-hidden>{Array.from({ length: 7 }, (_, i) => <i key={i} />)}</span>
      <span><b>{title}</b>{text}</span>
    </div>
  );
}

export function StepError({ error }: { error: string }) {
  return error ? <div className="notice error" role="alert">{error}</div> : null;
}
