import { Fragment, useState } from "react";
import { api, type VideoBrief } from "../api";
import { usePoll } from "../hooks";

const FIELDS: { key: keyof VideoBrief; label: string; hint: string }[] = [
  { key: "topic", label: "De qué va", hint: "Tema del vídeo en una o dos frases" },
  { key: "tone", label: "Tono y formato", hint: "Entrevista, tutorial, humor, debate…" },
  { key: "audience", label: "Público", hint: "Quién lo ve y qué busca" },
  { key: "good_moment", label: "Un buen clip aquí es…", hint: "Qué historia, frase o reacción funciona en este vídeo" },
  { key: "avoid", label: "Evitar", hint: "Relleno, bromas internas, anuncios…" },
];
const EMPTY: VideoBrief = { topic: "", tone: "", audience: "", good_moment: "", avoid: "" };

/** La idea general del vídeo con la que la IA elige y puntúa los momentos. */
export default function SourceIdea({ sourceId, onRedo }: { sourceId: number; onRedo?: () => void }) {
  const idea = usePoll(() => api.sourceIdea(sourceId), 4000, [sourceId]);
  const [draft, setDraft] = useState<VideoBrief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const d = idea.data;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await idea.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!d) return <div className="small muted">{idea.error || "Cargando la idea del vídeo…"}</div>;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <b>Idea del vídeo</b>
          <div className="small muted">
            La IA la escribe leyendo todo el vídeo antes de buscar momentos, y puntúa todos los candidatos juntos con ella.
            {d.edited ? " Esta la has corregido tú." : ""}
          </div>
        </div>
        {!draft && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small" disabled={busy} onClick={() => { setSaved(false); setDraft(d.brief ?? EMPTY); }}>
              {d.brief ? "Corregir" : "Escribirla yo"}</button>
            {d.brief && (
              <button className="btn small ghost" disabled={busy} title="La IA la vuelve a escribir en la próxima búsqueda"
                onClick={() => { if (confirm("¿Borrar la idea? La IA escribirá otra al volver a buscar momentos.")) act(() => api.resetBrief(sourceId)); }}>
                Que la rehaga la IA</button>
            )}
          </div>
        )}
      </div>

      {!draft && !d.brief && <div className="small muted">Aún no hay idea: se escribe al buscar momentos.</div>}
      {!draft && d.brief && (
        <dl className="kv">
          {FIELDS.map((f) => d.brief?.[f.key] ? <Fragment key={f.key}><dt>{f.label}</dt><dd>{d.brief[f.key]}</dd></Fragment> : null)}
        </dl>
      )}
      {draft && (
        <div className="stack" style={{ gap: 8 }}>
          {FIELDS.map((f) => (
            <label className="field" key={f.key}>
              {f.label}
              <textarea rows={f.key === "good_moment" ? 3 : 2} value={draft[f.key]} placeholder={f.hint}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
            </label>
          ))}
          <div className="row">
            <button className="btn primary small" disabled={busy}
              onClick={() => act(async () => { await api.saveBrief(sourceId, draft); setDraft(null); setSaved(true); })}>Guardar</button>
            <button className="btn small ghost" disabled={busy} onClick={() => setDraft(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {saved && (
        <div className="notice small row" style={{ justifyContent: "space-between" }}>
          Guardada. Se usa la próxima vez que se busquen momentos.
          {onRedo && <button className="btn small" onClick={() => { setSaved(false); onRedo(); }}>Volver a buscar ahora</button>}
        </div>
      )}

      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
