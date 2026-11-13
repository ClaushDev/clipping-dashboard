import { useState } from "react";
import { api, type BenchSummary } from "../api";
import { usePoll } from "../hooks";
import { timeAgo } from "./ui";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)} %`);

function Bench({ b }: { b: BenchSummary | null }) {
  if (!b) return <span className="muted">sin probar</span>;
  if (b.status === "running") return <span className="muted">probando…</span>;
  if (b.status === "error") return <span className="error-text" title={b.error}>falló</span>;
  const delta = b.prev && b.prev.recall !== null && b.recall !== null ? Math.round((b.recall - b.prev.recall) * 100) : null;
  return (
    <span>
      {b.found} de {b.manual} encontrados
      {!!b.in_pool && <span title="No salieron arriba, pero están en «Descartados por la IA» y se rescatan con un clic"> · {b.in_pool} más en descartados</span>}
      {delta !== null && delta !== 0 && <span className={delta > 0 ? "ok-text" : "error-text"} title={`Prueba anterior: ${b.prev?.found} de ${b.prev?.manual}`}> · {delta > 0 ? "+" : ""}{delta} pts</span>}
      <span className="muted"> · {timeAgo(b.at)}</span>
    </span>
  );
}

/** Cuánto acierta la IA eligiendo momentos, según lo que hiciste con sus propuestas y frente a tus clips a mano. */
export default function MomentAccuracy() {
  const acc = usePoll(() => api.momentAccuracy(), 5000);
  const [error, setError] = useState("");
  const a = acc.data;
  if (!a) return null;
  const decided = a.kept + a.discarded;
  if (!a.proposed && !a.candidates.length) return null;

  async function bench(id: number) {
    setError("");
    try {
      await api.startBenchmark(id);
      await acc.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="card">
      <h2>Acierto de la IA eligiendo momentos</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Sale de lo que haces con sus propuestas: aprobar cuenta como acierto y descartar,
        como fallo. Los clips que marcas tú en un vídeo que la IA ya repasó son momentos que no vio.
      </p>
      <div className="stat-row">
        <div className="stat"><span className="stat-value">{pct(a.hit_rate)}</span>
          <span className="stat-label">Acierto ({a.kept} de {decided} decididos{a.pending ? `, ${a.pending} sin decidir` : ""})</span></div>
        <div className="stat"><span className="stat-value">{a.score_kept ?? "—"} / {a.score_discarded ?? "—"}</span>
          <span className="stat-label">Nota media de la IA: aprobados / descartados</span></div>
        <div className="stat"><span className="stat-value">{a.score_corr === null ? "—" : a.score_corr.toFixed(2)}</span>
          <span className="stat-label" title="Correlación de Spearman: 1 = sus notas altas son las que apruebas; 0 = al azar">¿Su nota ordena bien? (1 = perfecto)</span></div>
        <div className="stat"><span className="stat-value">{a.missed}</span>
          <span className="stat-label">Momentos que marcaste tú y no vio</span></div>
      </div>

      {a.candidates.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <b className="small">Probar con tus clips marcados a mano</b>
          <p className="small muted" style={{ margin: "2px 0 6px" }}>
            La IA busca momentos en el vídeo como si fuera la primera vez (sin crear clips) y se cuenta cuántos de los tuyos
            encuentra. Gasta IA: unas pocas llamadas por vídeo.
            {a.bench_recall !== null ? ` Hasta ahora encontró ${a.bench_found} de ${a.bench_manual} (${pct(a.bench_recall)}).` : ""}
          </p>
          <table className="table compact">
            <tbody>
              {a.candidates.map((c) => (
                <tr key={c.source_id}>
                  <td className="ellipsis" style={{ maxWidth: 360 }}>{c.title}</td>
                  <td className="small">{c.manual} clips tuyos</td>
                  <td className="small"><Bench b={c.benchmark} /></td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn small" disabled={c.benchmark?.status === "running"} onClick={() => bench(c.source_id)}>
                      {c.benchmark ? "Repetir" : "Probar"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
