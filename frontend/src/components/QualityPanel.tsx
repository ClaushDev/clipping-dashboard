import { ArrowsClockwise, CheckCircle, Info, PencilSimple, Warning, WarningOctagon, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Opening, QualityIssue, QualityReport, QualitySummary } from "../types";
import { timeAgo } from "./ui";

const VERDICT: Record<QualitySummary["verdict"], [string, string]> = {
  bien: ["Bien", "high"], revisar: ["Revisar", "mid"], problema: ["Con problemas", ""],
};
const LEVEL: Record<QualityIssue["level"], [typeof Warning, string]> = {
  error: [WarningOctagon, "Problema"], warn: [Warning, "Aviso"], info: [Info, "Sugerencia"],
};

const LAYER: Record<keyof Opening["layers"], string> = { spoken: "Lo que se oye", text: "Lo que se lee", visual: "Lo que se ve" };
const pill = (n: number) => `score-pill ${n >= 72 ? "high" : n >= 55 ? "mid" : ""}`;

/** El arranque en tres capas: en un Short se decide en 1-2 s si se desliza. */
export function OpeningView({ o }: { o: Opening }) {
  const detail = {
    spoken: o.layers.spoken.text ? `«${o.layers.spoken.text}»` : "No se oye voz",
    text: o.layers.text.texts[0] ? `«${o.layers.text.texts[0]}»` : "Sin texto en pantalla",
    visual: o.layers.visual.first_change != null ? `Primer cambio en el segundo ${o.layers.visual.first_change}` : "Ningún cambio de imagen",
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="small strong">Arranque</span>
        <span className="small muted">primeros {o.window} s</span>
        <span className={pill(o.score)}>{o.score}</span>
      </div>
      <div className="opening">
        {(Object.keys(LAYER) as (keyof Opening["layers"])[]).map((k) => (
          <div key={k}>
            <div className="row" style={{ gap: 6 }}>
              <span className={pill(o.layers[k].score)}>{o.layers[k].score}</span>
              <span className="small strong">{LAYER[k]}</span>
            </div>
            <div className="small muted ellipsis" title={detail[k]}>{detail[k]}</div>
            {o.issues.filter((i) => i.layer === k).map((i) => (
              <div key={i.text} className={`small ${i.level === "warn" ? "warn-text" : "faint"}`} title={i.fix || undefined}>· {i.text}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** Nota de calidad en la tarjeta del clip. */
export function QualityBadge({ q, onClick }: { q: QualitySummary; onClick: () => void }) {
  const [label, cls] = VERDICT[q.verdict];
  const n = q.counts.error + q.counts.warn;
  return (
    <button className={`btn small quality-badge ${cls}`} onClick={onClick}
      title={`Filtros de calidad: ${label.toLowerCase()}${n ? ` · ${n} aviso${n > 1 ? "s" : ""}` : ""}`}>
      <span className={`score-pill ${cls}`}>{q.score}</span> {n ? `${n} aviso${n > 1 ? "s" : ""}` : "Calidad"}
    </button>
  );
}

/** Informe de los filtros de calidad: nota, avisos con su segundo, métricas y tira de fotogramas. */
export default function QualityPanel({ title, initial, load, recheck, onSeek, editHref, onClose }: {
  title: string;
  initial?: QualityReport | null;
  load?: () => Promise<QualityReport>;
  recheck?: () => Promise<QualityReport>;
  onSeek?: (t: number) => void;
  editHref?: string;
  onClose: () => void;
}) {
  const [report, setReport] = useState<QualityReport | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<QualityReport>) => {
    setBusy(true);
    setError("");
    try {
      setReport(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!initial && load) run(load);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const m = report?.metrics ?? {};
  const chips: [string, string][] = [];
  if (m.duration) chips.push(["Duración", `${Math.round(m.duration)} s`]);
  if (m.real_cuts != null) chips.push(["Cortes reales", `${m.real_cuts} · plano medio ${m.real_avg_shot} s`]);
  else if (m.shots) chips.push(["Planos", `${m.shots} · medio ${m.avg_shot} s`]);
  if (m.still_share) chips.push(["Imágenes fijas", `${Math.round(m.still_share * 100)} %`]);
  if (m.wpm) chips.push(["Voz", `${m.wpm} palabras/min`]);
  if (m.lufs != null) chips.push(["Volumen", `${m.lufs} LUFS`]);
  if (m.peak != null) chips.push(["Picos", `${m.peak} dBFS`]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal quality" role="dialog" aria-label="Filtros de calidad">
        <div className="publish-head">
          <div style={{ minWidth: 0 }}>
            <h2>Filtros de calidad</h2>
            <p className="small muted ellipsis" style={{ margin: "-8px 0 0" }}>{title}</p>
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </div>

        {error && <div className="notice error small">{error}</div>}
        {!report && !error && <div className="muted">{busy ? "Revisando…" : "Sin informe todavía."}</div>}
        {report && (
          <>
            <div className="quality-head">
              <span className={`score-pill big ${VERDICT[report.verdict][1]}`}>{report.score}</span>
              <div className="stack" style={{ gap: 2 }}>
                <strong>{VERDICT[report.verdict][0]}</strong>
                <span className="small muted">
                  {report.rendered ? "Composición y MP4 revisados" : "Solo la composición (sin renderizar)"}
                  {report.checked_at && ` · ${timeAgo(report.checked_at)}`}
                </span>
              </div>
              <span className="spacer" />
              {editHref && <a className="btn small" href={editHref}><PencilSimple size={14} /> Abrir en el editor</a>}
              {recheck && <button className="btn small" disabled={busy} onClick={() => run(recheck)}>
                <ArrowsClockwise size={14} /> {busy ? "Revisando…" : "Volver a comprobar"}</button>}
            </div>
            {chips.length > 0 && (
              <div className="quality-chips">
                {chips.map(([k, v]) => <span key={k} className="tag"><span className="muted">{k}</span> {v}</span>)}
              </div>
            )}
            {report.targets && (
              <div className="small muted">
                Comparado con tus referencias ({report.targets.name}):
                {report.targets.avg_shot ? ` cambian de plano cada ${report.targets.avg_shot} s` : ""}
                {report.targets.wpm ? ` · hablan a ${report.targets.wpm} palabras/min` : ""}.
              </div>
            )}
            {report.opening && <OpeningView o={report.opening} />}
            {report.sheet && <img className="quality-sheet" src={report.sheet} alt="Fotogramas repartidos por el vídeo" />}
            {report.issues.length === 0 ? (
              <div className="ok-text"><CheckCircle size={16} /> No hay nada que revisar: listo para tu revisión final.</div>
            ) : (
              <ul className="quality-issues">
                {report.issues.map((i, k) => {
                  const [Icon, label] = LEVEL[i.level];
                  return (
                    <li key={k} className={`q-${i.level}`}>
                      <Icon size={16} weight="fill" aria-label={label} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div>{i.text}</div>
                        {i.fix && <div className="small muted">{i.fix}</div>}
                      </div>
                      {i.at !== null && (onSeek
                        ? <button className="btn small ghost" onClick={() => { onSeek(i.at!); onClose(); }}>Ir a {fmtT(i.at)}</button>
                        : <span className="small faint">{fmtT(i.at)}</span>)}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="small faint" style={{ margin: 0 }}>
              Los filtros solo avisan: tú decides qué se aprueba. Miden el vídeo con FFmpeg (negros, imagen congelada, cortes,
              volumen y silencios) y revisan la composición (imágenes fijas, ritmo, gancho, arranque y subtítulos).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
