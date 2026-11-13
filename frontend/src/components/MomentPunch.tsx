/** De dónde sale la nota de un momento (IA, rúbrica de punch, señales sin IA) y la bolsa de descartados. */
import { ArrowUUpLeft } from "@phosphor-icons/react";
import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import type { MomentCandidate, PunchKey, ScoreBreakdown } from "../types";

const PUNCH_LABEL: Record<PunchKey, string> = {
  hook: "Gancho en 2 s", tension: "Tensión → remate", emotion: "Emoción clara", standalone: "Se entiende solo",
  quotable: "Frase citable",
};
const SIGNAL_LABEL = { audio: ["Picos de audio", 30], energy: ["Energía de la voz", 20], turns: ["Frases de giro", 20], heat: ["Más vistos de YouTube", 30] } as const;
const VIA_LABEL: Record<ScoreBreakdown["via"], string> = {
  "": "", advocate: "Rescatado en la segunda pasada (abogado del diablo)", signals: "Entra por sus señales: la IA lo había dejado fuera",
  rescued: "Lo rescataste tú de los descartados",
};

const bonus = (signal: number) => Math.round((15 * signal) / 100);
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** Desglose: nota de la IA + lo que suman las señales, la rúbrica en barras y qué señales hay. */
export function PunchBreakdown({ b, score }: { b: ScoreBreakdown; score: number }) {
  const sig = b.signals?.score ?? 0;
  const keys = Object.keys(PUNCH_LABEL) as PunchKey[];
  return (
    <div className="punch">
      <div className="punch-sum">
        <span>IA <b>{b.ai}</b></span>
        <span>+ señales <b>{bonus(sig)}</b> <small>({sig}/100)</small></span>
        <span>= <b>{score}</b></span>
      </div>
      {b.via && <div className="punch-via">{VIA_LABEL[b.via]}</div>}
      {Object.keys(b.punch ?? {}).length > 0 && (
        <div className="punch-bars" aria-label="Rúbrica de punch">
          {keys.map((k) => (
            <div key={k} className="punch-row">
              <span>{PUNCH_LABEL[k]}</span>
              <span className="punch-bar"><span style={{ width: `${((b.punch[k] ?? 0) / 20) * 100}%` }} /></span>
              <small>{b.punch[k] ?? 0}/20</small>
            </div>
          ))}
        </div>
      )}
      {sig > 0 && (
        <div className="punch-bars" aria-label="Señales sin IA">
          {(Object.keys(SIGNAL_LABEL) as (keyof typeof SIGNAL_LABEL)[]).filter((k) => (b.signals.parts?.[k] ?? 0) > 0).map((k) => (
            <div key={k} className="punch-row sig">
              <span>{SIGNAL_LABEL[k][0]}</span>
              <span className="punch-bar"><span style={{ width: `${((b.signals.parts?.[k] ?? 0) / SIGNAL_LABEL[k][1]) * 100}%` }} /></span>
              <small>{b.signals.parts?.[k]}/{SIGNAL_LABEL[k][1]}</small>
            </div>
          ))}
        </div>
      )}
      {!!b.signals?.notes?.length && <div className="punch-notes">{b.signals.notes.join(" · ")}</div>}
    </div>
  );
}

/** «Descartados por la IA»: todo lo que se quedó fuera de la última búsqueda, con su motivo; se rescata con un clic. */
export function RejectedMoments({ sourceId, onRescued }: { sourceId: number; onRescued: () => void }) {
  const data = usePoll(() => api.momentCandidates(sourceId), 0, [sourceId]);
  const [busy, setBusy] = useState(0);
  const [open, setOpen] = useState(0);
  const [error, setError] = useState("");
  const items = data.data?.items ?? [];
  if (!data.data || !items.length) return null;
  const free = items.filter((c) => !c.clip_id).length;

  async function rescue(c: MomentCandidate) {
    setBusy(c.id);
    setError("");
    try {
      await api.rescueMoment(sourceId, c.id);
      data.reload();
      onRescued();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(0);
    }
  }

  return (
    <details className="ca-adv rejects">
      <summary>Descartados por la IA <small>{free} sin usar · la búsqueda guarda todo lo que vio</small></summary>
      <div className="ca-adv-body">
        {error && <div className="notice error">{error}</div>}
        <ul className="rejects-list">
          {items.map((c) => (
            <li key={c.id}>
              <div className="rejects-head">
                <span className="rejects-score" title="Nota final (IA + señales)">{c.score || "—"}</span>
                <div className="rejects-text">
                  <b>{c.title || "Sin título (solo lo vieron las señales)"}</b>
                  <small>{fmt(c.start)}–{fmt(c.end)} · {Math.round(c.end - c.start)} s · {c.discard}</small>
                  {c.reason && <span className="why">{c.reason}</span>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn small ghost" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? 0 : c.id)}>
                    {open === c.id ? "Ocultar nota" : "Ver nota"}</button>
                  {c.clip_id ? <span className="tag">Clip {c.clip_id}</span> : (
                    <button className="btn small" disabled={busy === c.id} onClick={() => rescue(c)} title="Se monta como un clip más y aparece arriba para revisarlo">
                      <ArrowUUpLeft size={14} /> {busy === c.id ? "Rescatando…" : "Rescatar"}</button>
                  )}
                </div>
              </div>
              {open === c.id && <PunchBreakdown b={c.breakdown} score={c.score} />}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
