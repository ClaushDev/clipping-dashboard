import { useState } from "react";
import { api } from "../api";
import type { SfxFindResult } from "../types";

/** Pedir un sonido con palabras. Se busca en tu biblioteca (galería y paquetes importados) y, si es algo simple
 *  (whoosh, pop, ding, riser…), se sintetiza al momento y queda en «Generados». Sin modelos de IA. */
export default function SfxFindPanel({ intents, onPlay, onChange }: {
  intents: Record<string, string>; onPlay: (url: string) => void; onChange: () => void;
}) {
  const [request, setRequest] = useState("");
  const [intent, setIntent] = useState("");
  const [duration, setDuration] = useState(0);
  const [found, setFound] = useState<SfxFindResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function find() {
    setBusy(true);
    setError("");
    try {
      const r = await api.sfxFind({ request: request.trim(), intent, duration });
      setFound(r);
      if (r.how === "synth") onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = found
    ? (found.sound ? [found.sound, ...found.candidates.filter((c) => c.id !== found.sound!.id)] : found.candidates).slice(0, 6)
    : [];
  return (
    <div className="stack">
      <div className="small muted">
        Descríbelo con tus palabras («cristal rompiéndose», «whoosh largo y grave»). Se busca en tu biblioteca y, si es algo
        simple (whoosh, pop, ding, riser, latido, tic tac…), se hace aquí al momento con la duración que pidas y queda en la
        carpeta «Generados». Lo concreto sale de los paquetes que importes. El chat de edición también busca así.
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input type="text" value={request} placeholder="Una puerta de madera que chirría" style={{ flex: 1, minWidth: 220 }}
          onChange={(e) => { setRequest(e.target.value); setFound(null); }}
          onKeyDown={(e) => e.key === "Enter" && request.trim() && find()} />
        <select value={intent} onChange={(e) => setIntent(e.target.value)} title="Para qué sirve">
          <option value="">Para qué sirve…</option>
          {Object.entries(intents).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="row small" title="0 = lo que dure el sonido">
          Duración
          <input type="number" min={0} max={20} step={0.5} value={duration} style={{ width: 64 }}
            onChange={(e) => setDuration(Math.max(0, Math.min(20, Number(e.target.value) || 0)))} /> s
        </label>
        <button className="btn small primary" disabled={busy || !request.trim()} onClick={find}>
          {busy ? "Buscando…" : "Buscar o hacer"}
        </button>
      </div>
      {found && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small">
            {found.how === "library" && "Ya lo tienes en la biblioteca:"}
            {found.how === "synth" && "Hecho aquí al momento y guardado en «Generados»:"}
            {found.how === "none" && (found.candidates.length
              ? "No hay uno claro. Lo más parecido:"
              : "No hay nada parecido en tu biblioteca: importa un paquete que lo tenga.")}
          </div>
          {shown.length > 0 && (
            <div className="sfx-grid">
              {shown.map((s) => (
                <div key={s.id} className="sfx-row">
                  <button className="btn small" onClick={() => onPlay(s.url)} title="Escuchar">▶</button>
                  <div className="stack" style={{ gap: 0, minWidth: 0, flex: 1 }}>
                    <strong className="ellipsis" title={s.name}>{s.name}</strong>
                    <span className="small muted ellipsis">
                      {s.category} · {s.duration.toFixed(1)} s{s.score !== undefined ? ` · parecido ${Math.round(s.score * 100)} %` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
