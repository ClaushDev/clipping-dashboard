import { Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { api } from "../api";
import TemplatePreview from "../components/TemplatePreview";
import { PageHead } from "../components/ui";
import { usePoll } from "../hooks";
import { useAsk } from "../project/StepKit";
import { ANIMATIONS } from "../remotion/Captions";
import { fontFamily, GOOGLE_FONTS, SYSTEM_FONTS } from "../remotion/fonts";
import type { Template } from "../types";

type Draft = Omit<Template, "id">;

const DEFAULTS: Draft = {
  name: "Nueva plantilla", font: "Montserrat", font_size: 86, font_weight: 900, primary_color: "#FFFFFF",
  highlight_color: "#FFD400", highlight_mode: "color", box_color: "#7C3AED", outline_color: "#000000",
  outline_width: 6, shadow: 3, uppercase: true, words_per_chunk: 3, margin_v: 560, animation: "pop",
  chunk_bg_color: "", chunk_bg_opacity: 0.6,
  hook_enabled: true, hook_font_size: 64, hook_text_color: "#000000", hook_bg_color: "#FFFFFF", hook_duration: 3,
};

/** Muestra estática del estilo para la galería (la vista previa animada se ve al editar). */
function Sample({ t }: { t: Template }) {
  const words = ["this", "changed", "everything"];
  const hl: React.CSSProperties =
    t.highlight_mode === "box"
      ? { background: t.box_color, color: t.highlight_color, borderRadius: 4, padding: "0 4px" }
      : t.highlight_mode === "underline"
        ? { textDecoration: "underline", textDecorationColor: t.highlight_color, textDecorationThickness: 3 }
        : { color: t.highlight_color };
  const box = t.chunk_bg_color ? { background: `${t.chunk_bg_color}${Math.round((t.chunk_bg_opacity ?? 0.6) * 255).toString(16).padStart(2, "0")}`, borderRadius: 6, padding: "2px 8px" } : {};
  return (
    <div className="tpl-sample" style={{
      fontFamily: fontFamily(t.font), fontWeight: t.font_weight, color: t.primary_color,
      WebkitTextStroke: t.outline_width ? `${Math.min(3, t.outline_width / 2)}px ${t.outline_color}` : undefined,
      paintOrder: "stroke fill",
    }}>
      <span style={{ display: "flex", gap: 7, ...box }}>
        {words.map((w, i) => (
          <span key={w} style={i === 1 ? hl : undefined}>{t.uppercase ? w.toUpperCase() : w}</span>
        ))}
      </span>
    </div>
  );
}

/** Biblioteca › Plantillas (rediseño): la galería de plantillas de subtítulos con su muestra; editar abre un panel con
 * la vista previa real al lado. */
export default function Plantillas() {
  const templates = usePoll(api.templates, 0);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(DEFAULTS);
  const [error, setError] = useState("");
  const q = useAsk();

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function edit(t: Template | null, copy = false) {
    setError("");
    if (t) {
      const { id, ...rest } = t;
      setDraft(copy ? { ...rest, name: `${rest.name} (copia)` } : rest);
      setEditingId(copy ? "new" : id);
    } else {
      setDraft(DEFAULTS);
      setEditingId("new");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (editingId === "new") await api.createTemplate(draft);
      else if (editingId) await api.updateTemplate(editingId, draft);
      setEditingId(null);
      templates.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function remove(t: Template) {
    q.ask(`t${t.id}`, [{ text: `¿Borrar la plantilla «${t.name}»? No se puede deshacer.`, yes: "Borrar" }], async () => {
      setError("");
      try {
        await api.deleteTemplate(t.id);
        if (editingId === t.id) setEditingId(null);
        templates.reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const color = (k: keyof Draft, label: string) => (
    <label className="field">
      {label}
      <div className="row">
        <input type="color" value={draft[k] as string} onChange={(e) => set(k, e.target.value.toUpperCase() as never)} />
        <input type="text" value={draft[k] as string} onChange={(e) => set(k, e.target.value as never)} style={{ width: 100 }} />
      </div>
    </label>
  );
  const num = (k: keyof Draft, label: string, min: number, max: number, step = 1) => (
    <label className="field">
      {label}
      <input type="number" min={min} max={max} step={step} value={draft[k] as number} onChange={(e) => set(k, Number(e.target.value) as never)} />
    </label>
  );

  return (
    <div className="ca-page">
      <PageHead title="Plantillas"
        subtitle="Subtítulos palabra a palabra, con la palabra activa resaltada. En Ajustes eliges la de por defecto y en el editor puedes cambiarla por clip.">
        <button className="btn primary" onClick={() => edit(null)}><Plus size={15} /> Nueva plantilla</button>
      </PageHead>

      {editingId !== null && (
        <form className="ca-make" onSubmit={save} aria-label={editingId === "new" ? "Nueva plantilla" : "Editar plantilla"}>
          <div className="ca-sec-head"><h2>{editingId === "new" ? "Nueva plantilla" : `Editar «${draft.name}»`}</h2>
            <button type="button" className="btn small ghost more" onClick={() => setEditingId(null)}>Cerrar</button></div>
          <div className="ca-tpl-edit">
            <div className="stack" style={{ minWidth: 0 }}>
              <div className="small muted strong">Texto</div>
              <div className="grid-3">
                <label className="field">Nombre<input type="text" required value={draft.name} onChange={(e) => set("name", e.target.value)} /></label>
                <label className="field">
                  Fuente
                  <select value={draft.font} onChange={(e) => set("font", e.target.value)}>
                    <optgroup label="Google Fonts">{GOOGLE_FONTS.map((f) => <option key={f}>{f}</option>)}</optgroup>
                    <optgroup label="Windows">{SYSTEM_FONTS.map((f) => <option key={f}>{f}</option>)}</optgroup>
                  </select>
                </label>
                <label className="field">
                  Grosor
                  <select value={draft.font_weight} onChange={(e) => set("font_weight", Number(e.target.value))}>
                    {[400, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                </label>
                {num("font_size", "Tamaño", 30, 200)}
                {num("words_per_chunk", "Palabras por bloque", 1, 8)}
                {num("margin_v", "Altura desde abajo (px)", 60, 1500, 10)}
              </div>
              <div className="small muted strong">Palabra activa y estilo</div>
              <div className="grid-3">
                <label className="field">
                  Resaltado de la palabra activa
                  <select value={draft.highlight_mode} onChange={(e) => set("highlight_mode", e.target.value as Draft["highlight_mode"])}>
                    <option value="color">Color</option>
                    <option value="box">Caja de color</option>
                    <option value="underline">Subrayado</option>
                  </select>
                </label>
                <label className="field">
                  Animación
                  <select value={draft.animation} onChange={(e) => set("animation", e.target.value as Draft["animation"])}>
                    {(["Gancho", "Serio / minimalista"] as const).map((g) => (
                      <optgroup key={g} label={g}>
                        {ANIMATIONS.filter((a) => a.group === g).map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="check" style={{ alignSelf: "end" }}>
                  <input type="checkbox" checked={draft.uppercase} onChange={(e) => set("uppercase", e.target.checked)} /> MAYÚSCULAS
                </label>
                {color("primary_color", "Texto")}
                {color("highlight_color", "Palabra activa")}
                {draft.highlight_mode === "box" ? color("box_color", "Caja") : <span />}
                {color("outline_color", "Contorno")}
                {num("outline_width", "Grosor contorno", 0, 20, 0.5)}
                {num("shadow", "Sombra", 0, 10, 0.5)}
              </div>
              <div className="grid-3">
                <label className="check" style={{ alignSelf: "end", paddingBottom: 8 }}>
                  <input type="checkbox" checked={!!draft.chunk_bg_color}
                    onChange={(e) => set("chunk_bg_color", e.target.checked ? "#000000" : "")} /> Caja detrás del texto
                </label>
                {draft.chunk_bg_color ? color("chunk_bg_color", "Color de la caja") : <span />}
                {draft.chunk_bg_color ? num("chunk_bg_opacity", "Opacidad de la caja", 0.1, 1, 0.05) : <span />}
              </div>
              <div className="small muted strong">Gancho</div>
              <label className="check"><input type="checkbox" checked={draft.hook_enabled} onChange={(e) => set("hook_enabled", e.target.checked)} /> Mostrar el gancho arriba al empezar</label>
              {draft.hook_enabled && (
                <div className="grid-3">
                  {num("hook_font_size", "Tamaño gancho", 30, 150)}
                  {num("hook_duration", "Duración gancho (s)", 1, 10, 0.5)}
                  <span />
                  {color("hook_text_color", "Texto gancho")}
                  {color("hook_bg_color", "Fondo gancho")}
                </div>
              )}
              {error && <div className="notice error">{error}</div>}
              <div className="row">
                <button className="btn primary">Guardar</button>
                <button type="button" className="btn" onClick={() => setEditingId(null)}>Cancelar</button>
              </div>
            </div>
            <div className="ca-tpl-preview">
              <TemplatePreview style={draft} />
              <span className="small muted">Vista previa real (mismo motor que el render)</span>
            </div>
          </div>
        </form>
      )}

      {error && editingId === null && <div className="notice error">{error}</div>}
      <section className="ca-sec" aria-label="Tus plantillas">
      <div className="ca-sec-head"><h2>Tus plantillas</h2><span className="ca-n">{templates.data?.length ?? 0}</span></div>
      <div className="ca-tpls">
        {templates.data?.map((t) => (
          <div className={`ca-tpl ${editingId === t.id ? "on" : ""}`} key={t.id}>
            <Sample t={t} />
            <div className="stack" style={{ gap: 2 }}>
              <b>{t.name}</b>
              <small>
                {t.font} · {t.words_per_chunk} palabras · {{ color: "color", box: "caja", underline: "subrayado" }[t.highlight_mode]}
                {` · ${ANIMATIONS.find((a) => a.value === t.animation)?.label.toLowerCase() ?? t.animation}`}
              </small>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn small" onClick={() => edit(t)}>Editar</button>
              <button className="btn small ghost" onClick={() => edit(t, true)}>Duplicar</button>
              <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={() => remove(t)}>Borrar</button>
            </div>
            {q.view(`t${t.id}`)}
          </div>
        ))}
      </div>
      </section>
    </div>
  );
}
