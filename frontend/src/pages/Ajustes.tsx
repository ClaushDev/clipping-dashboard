import { useEffect, useState } from "react";
import { api } from "../api";
import LlmPanel from "../components/LlmPanel";
import { usePoll } from "../hooks";
import { PageHead } from "../components/ui";
import { StepTabs } from "../project/StepKit";
import type { Health, Settings } from "../types";

// IDs exactos (los mismos que llm/router.py MODELS)
const CLAUDE_MODELS: [string, string][] = [
  ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"],
];

type CfgTab = "ia" | "clips" | "video" | "sistema";
const CFG_TABS: { id: CfgTab; label: string }[] = [
  { id: "ia", label: "IA" }, { id: "clips", label: "Clips" }, { id: "video", label: "Vídeo y render" }, { id: "sistema", label: "Estado del sistema" },
];

/** Ajustes: un solo formulario en pestañas; «Guardar» guarda todas a la vez. `#/ajustes?tab=…` abre una. */
export default function Ajustes({ health, initialTab = "" }: { health: Health | null; initialTab?: string }) {
  const [tab, setTab] = useState<CfgTab>(CFG_TABS.some((t) => t.id === initialTab) ? initialTab as CfgTab : "ia");
  const presets = usePoll(api.exportPresets, 0);
  const templates = usePoll(api.templates, 0);
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then(setS).catch((e) => setError(String(e)));
  }, []);

  if (!s) return <div className="muted">{error || "Cargando…"}</div>;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    setError("");
    try {
      setS(await api.saveSettings(s!));
      setMsg("Ajustes guardados.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }


  return (
    <div className="ca-page">
      <PageHead title="Ajustes" subtitle="Todo se ejecuta en este PC. Ninguna opción añade costes." />
      <div className="ca-sec">
      <StepTabs label="Secciones de la configuración" value={tab} onChange={(t) => { setTab(t); setMsg(""); }} tabs={CFG_TABS} />

      {tab === "sistema" && health && (
        <section className="ca-sec">
          <div className="grid-2 small">
            <div><span className={`dot ${health.ffmpeg ? "ok" : ""}`} style={{ display: "inline-block" }} /> FFmpeg {health.ffmpeg ? "instalado" : "no encontrado"}{health.nvenc ? " · codificación por GPU (NVENC) disponible" : ""}</div>
            <div><span className={`dot ${health.claude_cli ? "ok" : ""}`} style={{ display: "inline-block" }} /> Claude Code {health.claude_cli ? "instalado" : "no encontrado"}</div>
            <div><span className={`dot ${health.ollama ? "ok" : ""}`} style={{ display: "inline-block" }} /> Ollama {health.ollama ? "activo" : "no responde"}</div>
            <div className="muted">Modelos en Ollama: {health.ollama_models.join(", ") || "ninguno"}</div>
            <div><span className={`dot ${health.ml ? "ok" : ""}`} style={{ display: "inline-block" }} /> IA visual (opcional) {health.ml ? "instalada" : "sin instalar: ejecuta ml/setup.ps1 para recortar el sujeto, seguir un punto y buscar objetos"}</div>
          </div>
          {health.claude_cli && (
            <div className="notice">
              Claude Code necesita haber iniciado sesión una vez en este PC: abre una terminal, ejecuta <code>claude.cmd</code> y
              sigue los pasos. Usa tu suscripción y cuenta para sus límites de uso.
            </div>
          )}
          {health.ollama && !health.ollama_model_ready && (
            <div className="notice">El modelo <code>{s.ollama_model}</code> no está descargado. Ejecuta <code>ollama pull {s.ollama_model}</code>.</div>
          )}
        </section>
      )}

      <form className="ca-cfg" onSubmit={save}>
        <section className="ca-sec" hidden={tab !== "ia"}>
          <div className="ca-sec-head"><h2>IA</h2></div>
        <div className="grid-3">
          <label className="field">
            Proveedor por defecto
            <select value={s.llm_provider} onChange={(e) => set("llm_provider", e.target.value as Settings["llm_provider"])}>
              <option value="claude">Claude Code (mejor calidad)</option>
              <option value="ollama">Ollama (local, sin límites)</option>
            </select>
          </label>
          <label className="field">
            Modelo de Claude <span className="hint">(para las tareas en «modelo de arriba»)</span>
            <select value={s.claude_model} onChange={(e) => set("claude_model", e.target.value)}>
              <option value="">El de tu plan (por defecto)</option>
              {CLAUDE_MODELS.map(([id, label]) => <option key={id} value={id}>{label} · {id}</option>)}
              {s.claude_model && !CLAUDE_MODELS.some(([id]) => id === s.claude_model) && <option value={s.claude_model}>{s.claude_model}</option>}
            </select>
          </label>
          <label className="field">
            Modelo de Ollama
            <input type="text" list="ollama-models" value={s.ollama_model} onChange={(e) => set("ollama_model", e.target.value)} />
            <datalist id="ollama-models">{health?.ollama_models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <label className="field">URL de Ollama<input type="text" value={s.ollama_url} onChange={(e) => set("ollama_url", e.target.value)} /></label>
        </div>

        <LlmPanel s={s} set={set} />

        </section>
        <section className="ca-sec" hidden={tab !== "clips"}>
          <div className="ca-sec-head"><h2>Clips por defecto</h2></div>
        <p className="small muted">Lo que se usa al procesar un vídeo si no lo cambias en «Nuevo vídeo».</p>
        <div className="grid-3">
          <label className="field">
            Clips por vídeo
            <input type="number" min={1} max={20} value={s.clips_per_source} onChange={(e) => set("clips_per_source", Number(e.target.value))} />
          </label>
          <label className="field">
            Duración mínima (s)
            <input type="number" min={5} max={180} value={s.min_duration} onChange={(e) => set("min_duration", Number(e.target.value))} />
          </label>
          <label className="field">
            Duración máxima (s)
            <input type="number" min={5} max={180} value={s.max_duration} onChange={(e) => set("max_duration", Number(e.target.value))} />
          </label>
          <label className="field">
            Plantilla de subtítulos
            <select value={s.default_template_id ?? ""} onChange={(e) => set("default_template_id", e.target.value ? Number(e.target.value) : null)}>
              <option value="">La primera de la lista</option>
              {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          Instrucciones fijas para la IA <span className="hint">(en inglés; se suman a las de cada vídeo · máx. 2000 caracteres)</span>
          <textarea maxLength={2000} value={s.guidance} onChange={(e) => set("guidance", e.target.value)}
            placeholder="Niche: personal finance. Prefer clips with a concrete tip or a surprising number. Avoid sponsor reads." />
        </label>
        </section>
        <section className="ca-sec" hidden={tab !== "video"}>
          <div className="ca-sec-head"><h2>Transcripción (Whisper)</h2></div>
        <div className="grid-3">
          <label className="field">
            Modelo
            <select value={s.whisper_model} onChange={(e) => set("whisper_model", e.target.value)}>
              <option value="large-v3-turbo">large-v3-turbo (recomendado)</option>
              <option value="large-v3">large-v3 (más preciso, más lento)</option>
              <option value="medium.en">medium.en</option>
              <option value="small.en">small.en (rápido)</option>
            </select>
          </label>
          <label className="field">
            Dispositivo
            <select value={s.whisper_device} onChange={(e) => set("whisper_device", e.target.value)}>
              <option value="cuda">GPU (CUDA)</option>
              <option value="cpu">CPU</option>
            </select>
          </label>
          <label className="field">
            Idioma del audio
            <select value={s.language} onChange={(e) => set("language", e.target.value)}>
              <option value="">Detectar automáticamente (recomendado)</option>
              <option value="es">Español</option>
              <option value="en">Inglés</option>
              <option value="pt">Portugués</option>
            </select>
          </label>
        </div>

        </section>
        <section className="ca-sec" hidden={tab !== "video"}>
          <div className="ca-sec-head"><h2>Render de revisión</h2></div>
        <div className="grid-3">
          <label className="field">
            Calidad de la versión de revisión
            <select value={s.master_export} onChange={(e) => set("master_export", e.target.value)}>
              {presets.data && Object.entries(presets.data).map(([k, p]) => (
                <option key={k} value={k}>{p.label} · {p.options.short_side}p · {p.options.fps} fps</option>
              ))}
            </select>
            <span className="hint">Se mantiene el formato de cada clip. Para otros formatos usa Exportar.</span>
          </label>
          <label className="field">
            Calidad al descargar vídeos
            <select value={s.source_max_height} onChange={(e) => set("source_max_height", Number(e.target.value))}>
              <option value={0}>Automática según la duración · recomendada</option>
              <option value={2160}>Máxima (hasta 4K)</option>
              <option value={1440}>Alta (hasta 1440p)</option>
              <option value={1080}>Rápida (hasta 1080p) · ocupa menos</option>
            </select>
            <span className="hint">Automática: hasta 15 min, 4K; hasta 45 min, 1440p; más largo, 1080p. Por encima de 1080p
              YouTube da AV1/VP9 y hay que convertirlo para editar: un directo de 2 h a 1440p llegó a ocupar 36 GB. Nitidez al
              recortar a vertical, medida: 1080p → 67/100, 1440p → 82, 4K → 97. Se puede cambiar para cada vídeo al procesarlo.</span>
          </label>
          <label className="field">
            Velocidad de render
            <select value={s.render_speed ?? "balanced"} onChange={(e) => set("render_speed", e.target.value as typeof s.render_speed)}>
              <option value="fast">Rápido · 3/4 de los núcleos, códec veryfast</option>
              <option value="balanced">Equilibrado · recomendado</option>
              <option value="quality">Máxima calidad · lo de antes, el más lento</option>
            </select>
            <span className="hint">Afecta a todos los renders (revisión y exportación). La diferencia de calidad entre
              Equilibrado y Máxima apenas se ve en el móvil; lo que más acelera es descargar en 1080p.</span>
          </label>
        </div>

        </section>
        <section className="ca-sec" hidden={tab !== "video"}>
          <div className="ca-sec-head"><h2 id="efectos">Efectos automáticos</h2></div>
        <p className="small muted">
          Al crear cada clip la IA coloca estos efectos; todos se retocan o se borran en el
          editor, y el botón «Efectos automáticos» del editor los vuelve a colocar con estos ajustes.
        </p>
        <label className="check small">
          <input type="checkbox" checked={s.fx_auto} onChange={(e) => set("fx_auto", e.target.checked)} />
          Colocar efectos automáticos al crear los vídeos
        </label>
        <div className="grid-3" style={{ opacity: s.fx_auto ? 1 : 0.5 }}>
          <label className="check small">
            <input type="checkbox" disabled={!s.fx_auto} checked={s.fx_speaker_zoom} onChange={(e) => set("fx_speaker_zoom", e.target.checked)} />
            Zoom suave mientras alguien habla (clips)
          </label>
          <label className="check small">
            <input type="checkbox" disabled={!s.fx_auto} checked={s.fx_punch_in} onChange={(e) => set("fx_punch_in", e.target.checked)} />
            Punch-in en los momentos fuertes (clips)
          </label>
          <label className="check small">
            <input type="checkbox" disabled={!s.fx_auto} checked={s.fx_numbers} onChange={(e) => set("fx_numbers", e.target.checked)} />
            Cifras grandes que cuentan desde 0
          </label>
          <label className="check small">
            <input type="checkbox" disabled={!s.fx_auto} checked={s.fx_stickers} onChange={(e) => set("fx_stickers", e.target.checked)} />
            Stickers y emojis flotando
          </label>
          <label className="check small">
            <input type="checkbox" disabled={!s.fx_auto} checked={s.fx_camera} onChange={(e) => set("fx_camera", e.target.checked)} />
            Cámara en mano sobre las imágenes fijas
          </label>
          <label className="field">
            Transiciones
            <select disabled={!s.fx_auto} value={s.fx_transitions} onChange={(e) => set("fx_transitions", e.target.value as typeof s.fx_transitions)}>
              <option value="none">Ninguna (solo cortes)</option>
              <option value="some">Pocas (una cada 7 s como mucho)</option>
              <option value="many">Muchas</option>
            </select>
            <span className="hint">Barrido, zoom, destello o glitch en los cambios de escena.</span>
          </label>
        </div>
        <h3 style={{ margin: "18px 0 6px" }}>Gancho adelantado</h3>
        <p className="small muted" style={{ marginTop: 0 }}>Si el inicio natural de un clip es flojo, la IA elige un tramo de 2-4 s más fuerte (la frase clave, un grito, la reacción) y lo pone delante con una transición de salto; luego el clip empieza desde el principio. En el editor es un tramo más («Gancho adelantado»): lo mueves, recortas o borras.</p>
        <div className="grid-3">
          <label className="field">
            Gancho adelantado
            <select value={s.cold_open} onChange={(e) => set("cold_open", e.target.value as typeof s.cold_open)}>
              <option value="auto">Cuando la IA lo vea claro</option>
              <option value="off">Nunca</option>
            </select>
          </label>
          <label className="field">
            Transición
            <select disabled={s.cold_open === "off"} value={s.cold_open_transition} onChange={(e) => set("cold_open_transition", e.target.value as typeof s.cold_open_transition)}>
              <option value="flash">Destello</option>
              <option value="glitch">Rebobinado (glitch)</option>
              <option value="text">Texto «Unos segundos antes…»</option>
            </select>
          </label>
          <label className="field">
            El tramo del gancho
            <select disabled={s.cold_open === "off"} value={s.cold_open_mode} onChange={(e) => set("cold_open_mode", e.target.value as typeof s.cold_open_mode)}>
              <option value="repeat">Se vuelve a ver en su sitio</option>
              <option value="trim">Se quita del cuerpo (no se repite)</option>
            </select>
          </label>
        </div>

        </section>
        {error &&<div className="notice error">{error}</div>}
        <div className="row" hidden={tab === "sistema"}>
          <button className="btn primary">Guardar ajustes</button>
          {msg && <span className="small muted">{msg}</span>}
        </div>
      </form>
      </div>
    </div>
  );
}
