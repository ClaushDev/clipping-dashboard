import { useEffect, useState } from "react";
import { api } from "../api";
import type { LlmEffort, LlmInfo, LlmRoute, LlmUsage, Settings } from "../types";

const usd = (n: number) => (n < 1 ? n.toFixed(2) : String(n));

interface Props {
  s: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
}

/** Modelo y esfuerzo por tarea, caché de respuestas y contador de llamadas de la última semana. */
export default function LlmPanel({ s, set }: Props) {
  const [info, setInfo] = useState<LlmInfo | null>(null);
  const [usage, setUsage] = useState<LlmUsage | null>(null);
  const [cleared, setCleared] = useState("");
  const [tests, setTests] = useState<Record<string, { ok?: boolean; text: string }>>({});

  const load = () => {
    api.llmInfo().then(setInfo).catch(() => undefined);
    api.llmUsage(7).then(setUsage).catch(() => undefined);
  };
  useEffect(load, []);

  const model = (id: string) => info?.models.find((m) => m.id === id);
  const routeLabel = (r: string) => (r === "ollama" ? "Ollama (local, gratis)" : r === "default" ? "Claude (modelo de arriba)" : model(r)?.label ?? r);
  const effortLabel = (e: string) => info?.efforts.find((x) => x.id === e)?.label ?? e;
  const route = (id: string): LlmRoute => s.llm_task_models[id] ?? "auto";
  const setRoute = (id: string, r: LlmRoute) => {
    const next = { ...s.llm_task_models };
    if (r === "auto") delete next[id];
    else next[id] = r;
    set("llm_task_models", next);
  };
  const effort = (id: string): LlmEffort | "" => s.llm_task_effort?.[id] ?? "";
  const setEffort = (id: string, e: LlmEffort | "") => {
    const next = { ...(s.llm_task_effort ?? {}) };
    if (!e) delete next[id];
    else next[id] = e;
    set("llm_task_effort", next);
  };
  const viaOllama = s.llm_provider === "ollama";

  async function probe(id: string) {
    setTests((t) => ({ ...t, [id]: { text: "Probando…" } }));
    try {
      const r = await api.testLlmModel(id);
      setTests((t) => ({ ...t, [id]: { ok: r.ok, text: r.ok ? `Disponible (${r.secs} s)` : r.detail } }));
    } catch (err) {
      setTests((t) => ({ ...t, [id]: { ok: false, text: err instanceof Error ? err.message : String(err) } }));
    }
  }

  async function clear() {
    const r = await api.clearLlmCache();
    setCleared(`Borradas ${r.removed} respuestas guardadas.`);
    load();
  }

  return (
    <>
      <h2 id="ia-tareas">Modelo y esfuerzo por tarea</h2>
      {viaOllama ? (
        <div className="notice">Con Ollama como proveedor todo va a Ollama y esta tabla no se usa.</div>
      ) : (
        <p className="small muted">
          Lo barato va a Ollama, que es gratis y no gasta tu límite de Claude; si Ollama no está abierto o falla, se usa
          Claude Haiku 5.5 y te avisa. El <b>esfuerzo</b> es cuánto piensa el modelo antes de responder: más esfuerzo da más
          calidad, pero gasta más y tarda más. Con tu suscripción se gasta cuota, no dinero, pero los modelos caros la agotan antes.
          {info && (info.ollama.available
            ? <> Ollama ahora: <b>disponible</b> ({info.ollama.model}).</>
            : <> Ollama ahora: <b>no responde o no tiene el modelo</b>, así que lo barato irá a Haiku.</>)}
        </p>
      )}
      {info && (
        <table className="llm-table" style={{ opacity: viaOllama ? 0.5 : 1 }}>
          <thead><tr><th>Tarea</th><th>Modelo</th><th>Esfuerzo</th></tr></thead>
          <tbody>
            {info.tasks.map((t) => {
              const r = route(t.id);
              const chosen = r === "auto" ? (t.recommended === "ollama" ? "ollama" : t.recommended_model) : r;
              const m = model(chosen === "default" ? s.claude_model : chosen);
              const noEffort = chosen === "ollama" || (m !== undefined && !m.effort);
              const e = effort(t.id) || t.recommended_effort;
              return (
                <tr key={t.id}>
                  <td>
                    {t.label}
                    <div className="hint">{t.why}</div>
                  </td>
                  <td>
                    <select disabled={viaOllama} value={r} onChange={(ev) => setRoute(t.id, ev.target.value)} aria-label={`Modelo para ${t.label}`}>
                      <option value="auto">Recomendado: {routeLabel(t.recommended)}</option>
                      <option value="ollama">Ollama (local, gratis)</option>
                      <optgroup label="Claude">
                        {info.models.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.label}{x.id === t.recommended_model ? " ★" : ""} · ${usd(x.price[0])}/${usd(x.price[1])}
                          </option>
                        ))}
                      </optgroup>
                      <option value="default">Claude (modelo de arriba)</option>
                    </select>
                    <div className="hint">{chosen === "ollama" ? "Gratis y local. Si no está abierto, Haiku 5.5." : m ? `${m.id} · ${m.why}` : "El modelo por defecto de tu plan."}</div>
                  </td>
                  <td>
                    <select disabled={viaOllama || noEffort} value={effort(t.id)} onChange={(ev) => setEffort(t.id, ev.target.value as LlmEffort | "")} aria-label={`Esfuerzo para ${t.label}`}>
                      <option value="">Recomendado: {effortLabel(t.recommended_effort)}</option>
                      {info.efforts.map((x) => <option key={x.id} value={x.id}>{x.label}{x.id === t.recommended_effort ? " ★" : ""}</option>)}
                    </select>
                    <div className="hint">{noEffort ? (chosen === "ollama" ? "Ollama no usa esfuerzo." : "Este modelo no tiene esfuerzo.") : info.efforts.find((x) => x.id === e)?.why}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {info && !viaOllama && <p className="small muted">★ = recomendado para esa tarea.</p>}

      {info && (
        <>
          <h2 id="ia-modelos">Modelos de Claude</h2>
          <p className="small muted">Precio de la API por millón de tokens (entrada / salida), para comparar. «Probar» hace una llamada mínima y dice si tu cuenta tiene el modelo.</p>
          <table className="llm-table">
            <thead><tr><th>Modelo</th><th>Para qué es mejor</th><th className="num">API $</th><th></th></tr></thead>
            <tbody>
              {info.models.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.label}</b><div className="hint"><code>{m.id}</code></div></td>
                  <td className="small">{m.why}</td>
                  <td className="num small">{usd(m.price[0])} / {usd(m.price[1])}</td>
                  <td>
                    <button type="button" className="btn small" disabled={tests[m.id]?.text === "Probando…"} onClick={() => probe(m.id)}>Probar</button>
                    {tests[m.id] && <div className={`hint ${tests[m.id].ok === false ? "warn-text" : ""}`}>{tests[m.id].ok ? "✓ " : ""}{tests[m.id].text}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="grid-3">
        <label className="check small">
          <input type="checkbox" checked={s.llm_cache} onChange={(e) => set("llm_cache", e.target.checked)} />
          Reutilizar la respuesta si repites la misma petición con el mismo modelo
        </label>
        <label className="field">
          Guardar las respuestas (días)
          <input type="number" min={1} max={365} value={s.llm_cache_days} onChange={(e) => set("llm_cache_days", Number(e.target.value))} />
          <span className="hint">El chat del editor siempre responde de nuevo. Lo demás muestra «Regenerar».</span>
        </label>
        <div className="field">
          Respuestas guardadas: {info?.cache.size ?? "…"}
          <div className="row">
            <button type="button" className="btn small" onClick={clear}>Vaciar</button>
            {cleared && <span className="small muted">{cleared}</span>}
          </div>
        </div>
      </div>

      <h2 id="ia-consumo">Consumo de IA (últimos 7 días)</h2>
      {!usage || !usage.total ? (
        <div className="small muted">Aún no hay llamadas apuntadas.</div>
      ) : (
        <>
          <div className="small muted">
            {usage.total} llamadas · {usage.cached} salieron de la caché (no gastaron nada).
          </div>
          <table className="llm-table">
            <thead><tr><th>Dónde</th><th>Tarea</th><th className="num">Llamadas</th><th className="num">Errores</th><th className="num">Tokens</th><th className="num">Tiempo</th></tr></thead>
            <tbody>
              {usage.rows.map((r) => (
                <tr key={`${r.provider}-${r.task}`}>
                  <td>{r.provider}</td>
                  <td>{r.label}</td>
                  <td className="num">{r.calls}</td>
                  <td className="num">{r.errors || ""}</td>
                  <td className="num">{r.tokens ? r.tokens.toLocaleString("es-ES") : ""}</td>
                  <td className="num">{r.seconds >= 60 ? `${Math.round(r.seconds / 60)} min` : `${r.seconds} s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {usage.notes.length > 0 && (
            <div className="notice small">
              <b>Últimos avisos:</b>
              {usage.notes.map((n, i) => <div key={i}>{new Date(n.ts).toLocaleString("es-ES")} · {n.note}</div>)}
            </div>
          )}
        </>
      )}
    </>
  );
}
