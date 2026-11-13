import { CaretRight } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "../api";
import CaptionSetup, { type CaptionOverrides } from "../components/CaptionSetup";
import LayoutPicker, { LAYOUT_OPTIONS } from "../components/LayoutPicker";
import { PageHead } from "../components/ui";
import { usePoll } from "../hooks";
import type { Aspect } from "../remotion/schema";
import type { Source, SourceOptions } from "../types";

const ASPECTS: { value: Aspect; label: string }[] = [
  { value: "9:16", label: "9:16 vertical" },
  { value: "1:1", label: "1:1 cuadrado" },
  { value: "4:5", label: "4:5 feed" },
  { value: "16:9", label: "16:9 horizontal" },
];

const EMPTY: SourceOptions = {
  permission_note: "", requested_clips: 5, llm_provider: "", layout: "auto", bg_color: "#111111", aspect: "9:16",
  template_id: null, hook_enabled: true, min_duration: 0, max_duration: 0, instructions: "", selection: "auto", typology: "clips", max_height: 0,
};

/** Calidad de descarga (download.resolve_height). */
export const QUALITY_OPTIONS: [number, string, string][] = [
  [0, "Automática · recomendada", "Hasta 15 min: 4K · hasta 45 min: 1440p · más largo: 1080p. Los directos y podcasts largos bajan rápido y ocupan poco."],
  [1080, "Rápida · 1080p", "La más rápida: YouTube la da en H.264 y no hace falta convertirla. Al recortar a vertical se ve algo más blanda."],
  [1440, "Alta · 1440p", "Buen equilibrio para recortes verticales. Hay que convertirla para editar (unos minutos con la gráfica)."],
  [2160, "Máxima · 4K", "La más nítida en vertical, pero tarda y ocupa mucho más. Úsala solo en vídeos cortos."],
];

export default function Nuevo() {
  return (
    <>
      <PageHead title="Nuevo vídeo"
        subtitle="Pega un vídeo largo y la herramienta lo descarga, lo transcribe, elige los mejores momentos y los deja listos para revisar." />
      <SourceForm onCreated={(s) => { window.location.hash = `#/video?id=${s.id}`; }} />
    </>
  );
}

/** Formulario del vídeo largo: de dónde sale, qué tipo de clips, encuadre, subtítulos y permiso. */
export function SourceForm({ onCreated }: { onCreated: (s: Source) => void }) {
  const templates = usePoll(api.templates, 0);
  const catalog = usePoll(api.clipTypes, 0);
  const settings = usePoll(api.settings, 0);
  const [mode, setMode] = useState<"url" | "file">("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [opts, setOpts] = useState<SourceOptions>(EMPTY);
  const [captions, setCaptions] = useState<CaptionOverrides>({
    placement: "bottom", margin_v: 560, font_size: 86, words_per_chunk: 3, uppercase: true, highlight_color: "#FFD400",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const st = settings.data;

  const set = <K extends keyof SourceOptions>(k: K, v: SourceOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));
  // Número de clips y calidad de descarga parten de Ajustes; aquí se cambian solo para este vídeo
  useEffect(() => {
    if (st) setOpts((o) => ({ ...o, requested_clips: st.clips_per_source, max_height: st.source_max_height ?? 0 }));
  }, [st]);

  const types = catalog.data?.types ?? [];
  const presets = catalog.data?.presets ?? [];
  const type = types.find((t) => t.id === opts.typology);
  const typePresets = presets.filter((p) => type?.presets.includes(p.id));
  const preset = typePresets.find((p) => p.layout === opts.layout && p.aspect === opts.aspect);
  const template = templates.data?.find((t) => t.id === (opts.template_id ?? st?.default_template_id)) ?? templates.data?.[0];

  function pickType(id: string) {
    const t = types.find((x) => x.id === id);
    const p = presets.find((x) => x.id === t?.presets[0]);
    setOpts((o) => ({ ...o, typology: id, ...(p ? { layout: p.layout, aspect: p.aspect } : {}) }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body: SourceOptions = { ...opts, caption_style: { ...captions } };
      let created: Source;
      if (mode === "url") {
        created = await api.createSource({ ...body, url });
        setUrl("");
      } else {
        if (!file) throw new Error("Elige un archivo de vídeo");
        created = await api.uploadSource(file, body);
        setFile(null);
      }
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <div className="row">
        <div className="tabs" role="tablist">
          <button type="button" className={mode === "url" ? "on" : ""} onClick={() => setMode("url")}>URL o ruta local</button>
          <button type="button" className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>Subir archivo</button>
        </div>
      </div>
      {mode === "url" ? (
        <label className="field">
          URL del vídeo o ruta de un archivo en este PC
          <input type="text" required value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="Enlace de YouTube o TikTok…  o  C:\Videos\episodio.mp4" />
        </label>
      ) : (
        <label className="field">
          Archivo de vídeo
          <input type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      )}

      {types.length > 0 && (
        <div className="field stack" style={{ gap: 6 }}>
          Tipo de clips
          <div className="tabs" role="tablist" style={{ alignSelf: "flex-start" }}>
            {types.map((t) => (
              <button key={t.id} type="button" className={opts.typology === t.id ? "on" : ""} onClick={() => pickType(t.id)}>{t.label}</button>
            ))}
          </div>
          {type && <span className="hint">{type.desc}</span>}
        </div>
      )}

      <div className="field stack" style={{ gap: 6 }}>
        ¿Quién elige los clips?
        <div className="tabs" role="tablist" style={{ alignSelf: "flex-start" }}>
          <button type="button" className={opts.selection === "auto" ? "on" : ""} onClick={() => set("selection", "auto")}>La IA propone los mejores</button>
          <button type="button" className={opts.selection === "manual" ? "on" : ""} onClick={() => set("selection", "manual")}>Los marco yo</button>
        </div>
        <span className="hint">
          {opts.selection === "auto"
            ? "Al terminar puedes añadir más clips a mano con «Marcar clips»."
            : "Solo se descarga y transcribe; después marcas los tramos en la onda o en la transcripción y la IA los puntúa."}
        </span>
      </div>

      {typePresets.length > 0 && (
        <label className="field">
          Preset de encuadre
          <select value={preset?.id ?? ""} onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value);
            if (p) setOpts((o) => ({ ...o, layout: p.layout, aspect: p.aspect }));
          }}>
            {!preset && <option value="">Personalizado</option>}
            {typePresets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {preset && <span className="hint">{preset.desc}</span>}
        </label>
      )}

      <div className="field">
        Encuadre
        <LayoutPicker value={opts.layout} color={opts.bg_color} onChange={(v) => set("layout", v)} />
        <span className="hint">{LAYOUT_OPTIONS.find((o) => o.value === opts.layout)?.hint}. Podrás cambiarlo por tramos en el editor.</span>
      </div>

      <details className="ca-adv">
        <summary><CaretRight size={13} weight="bold" aria-hidden />Avanzado: calidad, número de clips, IA, formato, subtítulos e instrucciones<small>{opts.selection === "auto" ? `${opts.requested_clips} clips · ` : ""}{opts.aspect}</small></summary>
        <div className="ca-adv-body">
          {mode === "url" && (
            <label className="field">
              Calidad de descarga
              <select value={opts.max_height ?? 0} onChange={(e) => set("max_height", Number(e.target.value))}>
                {QUALITY_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
              <span className="hint">{QUALITY_OPTIONS.find(([v]) => v === (opts.max_height ?? 0))?.[2]}</span>
            </label>
          )}
          <div className="grid-3">
            {opts.selection === "auto" ? (
              <label className="field">
                Número de clips
                <input type="number" min={1} max={20} value={opts.requested_clips} onChange={(e) => set("requested_clips", Number(e.target.value))} />
              </label>
            ) : <div />}
            <label className="field">
              {opts.selection === "auto" ? "IA para elegir momentos" : "IA para puntuar tus clips"}
              <select value={opts.llm_provider} onChange={(e) => set("llm_provider", e.target.value)}>
                <option value="">La de Ajustes</option>
                <option value="claude">Claude Code</option>
                <option value="ollama">Ollama (local)</option>
              </select>
            </label>
          </div>

          <div className="grid-3">
            <label className="field">
              Formato de salida
              <select value={opts.aspect} onChange={(e) => set("aspect", e.target.value as Aspect)}>
                {ASPECTS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
            <label className="field">
              Plantilla de subtítulos
              <select value={opts.template_id ?? ""} onChange={(e) => set("template_id", e.target.value ? Number(e.target.value) : null)}>
                <option value="">La de Ajustes</option>
                {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            {opts.layout === "fit_color" ? (
              <label className="field">
                Color de fondo
                <input type="color" value={opts.bg_color} onChange={(e) => set("bg_color", e.target.value)} />
              </label>
            ) : (
              <label className="check" style={{ alignSelf: "end", paddingBottom: 8 }}>
                <input type="checkbox" checked={opts.hook_enabled} onChange={(e) => set("hook_enabled", e.target.checked)} />
                Gancho en pantalla al empezar
              </label>
            )}
          </div>

          <div className="field">
            Subtítulos
            <CaptionSetup aspect={opts.aspect} layout={opts.layout} bgColor={opts.bg_color} hookEnabled={opts.hook_enabled}
              template={template} value={captions} onChange={setCaptions} />
          </div>

          <div className="grid-3">
            <label className="field">
              Duración mínima (s)
              <input type="number" min={0} max={180} value={opts.min_duration || ""} placeholder={`${st?.min_duration ?? 30} (Ajustes)`}
                onChange={(e) => set("min_duration", Number(e.target.value))} />
            </label>
            <label className="field">
              Duración máxima (s)
              <input type="number" min={0} max={180} value={opts.max_duration || ""} placeholder={`${st?.max_duration ?? 60} (Ajustes)`}
                onChange={(e) => set("max_duration", Number(e.target.value))} />
            </label>
            {opts.layout === "fit_color" && (
              <label className="check" style={{ alignSelf: "end", paddingBottom: 8 }}>
                <input type="checkbox" checked={opts.hook_enabled} onChange={(e) => set("hook_enabled", e.target.checked)} />
                Gancho en pantalla
              </label>
            )}
          </div>
          <label className="field">
            Instrucciones para la IA en este vídeo <span className="hint">(en inglés; se suman a las de Ajustes)</span>
            <textarea value={opts.instructions} onChange={(e) => set("instructions", e.target.value)}
              placeholder="Focus on the funniest moments · Only clips about investing · Avoid the sponsor segment" />
          </label>
        </div>
      </details>

      <label className="field">
        Permiso para usar este vídeo <span className="hint">(obligatorio: sin permiso no se procesa)</span>
        <textarea required value={opts.permission_note} onChange={(e) => set("permission_note", e.target.value)}
          placeholder="Ej.: es mi propio vídeo · campaña de clipping del creador · licencia CC BY 4.0 · autorización por escrito (fecha)" />
      </label>
      {error && <div className="notice error">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? "Enviando…" : "Procesar"}</button>
      </div>
    </form>
  );
}
