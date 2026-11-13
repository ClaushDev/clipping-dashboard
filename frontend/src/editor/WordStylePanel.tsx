import { useEffect, useState } from "react";
import { api } from "../api";
import { ANIMATIONS, WORD_OUTS } from "../remotion/Captions";
import { GOOGLE_FONTS, SYSTEM_FONTS } from "../remotion/fonts";
import type { CaptionStyle, CaptionWord, WordAnimation, WordOut, WordStyle } from "../remotion/schema";
import { useAsk } from "../project/StepKit";

type Preset = { name: string; style: WordStyle };

/** Estilo propio de una palabra o de un rango: color, peso, tamaño, fuente, cursiva, entrada y salida. Lo que
 *  se deja en «Como el resto» sale del estilo general. Los presets se guardan en el backend y valen en cualquier clip. */
export default function WordStylePanel({ words, style, onChange }: {
  /** Palabras seleccionadas (una o un rango). */
  words: CaptionWord[];
  style: CaptionStyle;
  /** Mezcla `patch` en el estilo de cada palabra (`null` = quitarles el estilo propio). */
  onChange: (patch: WordStyle | null) => void;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  // El nombre del preset se escribe en un campo (antes, prompt()) y borrar se confirma aquí (antes, confirm())
  const [naming, setNaming] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const q = useAsk();
  const savePreset = async () => {
    const name = naming?.trim();
    if (!name) return;
    const clean = Object.fromEntries(Object.entries(st).filter(([, v]) => v !== undefined)) as WordStyle;
    try { setPresets(await api.saveWordPreset(name, clean)); setNaming(null); setErr(""); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { api.wordPresets().then(setPresets).catch(() => setPresets([])); }, []);
  // Valor común a todas las seleccionadas (o undefined si difieren)
  const common = <K extends keyof WordStyle>(k: K): WordStyle[K] | undefined => {
    const v = words[0]?.st?.[k];
    return words.every((w) => w.st?.[k] === v) ? v : undefined;
  };
  const st: WordStyle = { color: common("color"), weight: common("weight"), scale: common("scale"), font: common("font"),
    italic: common("italic"), anim: common("anim"), out: common("out") };
  const has = words.some((w) => w.st && Object.keys(w.st).length);
  const n = words.length;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <strong className="small">Estilo {n > 1 ? `de ${n} palabras` : "de la palabra"}</strong>
        <span className="spacer" />
        {has && <button className="btn small ghost" onClick={() => onChange(null)}>Quitar estilo</button>}
      </div>
      <div className="grid-2">
        <label className="field">
          Color
          <span className="row" style={{ gap: 6 }}>
            <input type="color" value={st.color ?? style.primary_color} onChange={(e) => onChange({ color: e.target.value.toUpperCase() })} />
            {st.color && <button className="btn small ghost" title="Como el resto" onClick={() => onChange({ color: undefined })}>×</button>}
          </span>
        </label>
        <label className="field">
          Tamaño (%)
          <input type="number" min={40} max={300} step={5} value={Math.round((st.scale ?? 1) * 100)}
            onChange={(e) => onChange({ scale: Math.max(0.4, Math.min(3, Number(e.target.value) / 100)) })} />
        </label>
        <label className="field">
          Grosor
          <select value={st.weight ?? ""} onChange={(e) => onChange({ weight: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Como el resto ({style.font_weight})</option>
            {[300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        <label className="field">
          Fuente
          <select value={st.font ?? ""} onChange={(e) => onChange({ font: e.target.value || undefined })}>
            <option value="">Como el resto ({style.font})</option>
            {[...GOOGLE_FONTS, ...SYSTEM_FONTS].map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label className="field">
          Entrada
          <select value={st.anim ?? ""} onChange={(e) => onChange({ anim: (e.target.value || undefined) as WordAnimation | undefined })}>
            <option value="">Como el resto</option>
            {ANIMATIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
        <label className="field">
          Salida
          <select value={st.out ?? ""} onChange={(e) => onChange({ out: (e.target.value || undefined) as WordOut | undefined })}>
            <option value="">Como el resto</option>
            {WORD_OUTS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={!!st.italic} onChange={(e) => onChange({ italic: e.target.checked || undefined })} /> Cursiva
      </label>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <select value="" style={{ flex: 1, minWidth: 140 }} onChange={(e) => {
          const p = presets.find((x) => x.name === e.target.value);
          // El preset sustituye el estilo propio entero (no se mezcla con lo que hubiera)
          if (p) onChange({ color: undefined, weight: undefined, scale: undefined, font: undefined, italic: undefined,
            anim: undefined, out: undefined, ...p.style });
        }}>
          <option value="">{presets.length ? "Aplicar un preset…" : "Aún no hay presets"}</option>
          {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <button className="btn small" disabled={!has || naming !== null} title="Guarda este estilo para usarlo en otras palabras y clips"
          onClick={() => setNaming("")}>Guardar como preset</button>
        {presets.length > 0 && (
          <select value="" title="Borrar un preset" style={{ width: 90 }} onChange={(e) => {
            const name = e.target.value;
            if (name) q.ask("del", [{ text: `¿Borrar el preset «${name}»?`, yes: "Borrar" }], async () => {
              try { setPresets(await api.deleteWordPreset(name)); } catch (er) { setErr(er instanceof Error ? er.message : String(er)); }
            });
          }}>
            <option value="">Borrar…</option>
            {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        )}
      </div>
      {naming !== null && (
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void savePreset(); }}>
          <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Nombre (p. ej. «Cifra grande amarilla»)"
            aria-label="Nombre del preset" style={{ flex: 1, minWidth: 140 }} onKeyDown={(e) => { if (e.key === "Escape") setNaming(null); }} />
          <button type="button" className="btn small ghost" onClick={() => setNaming(null)}>Cancelar</button>
          <button className="btn small" disabled={!naming.trim()}>Guardar</button>
        </form>
      )}
      {q.view("del")}
      {err && <div className="notice error" role="alert">{err}</div>}
    </div>
  );
}

/** Mezcla un cambio de estilo en una palabra; las claves con undefined se quitan. */
export function mergeWordStyle(w: CaptionWord, patch: WordStyle | null): CaptionWord {
  if (patch === null) {
    const { st: _drop, ...rest } = w;
    return rest;
  }
  const st: WordStyle = { ...(w.st ?? {}), ...patch };
  for (const k of Object.keys(st) as (keyof WordStyle)[]) if (st[k] === undefined) delete st[k];
  if (!Object.keys(st).length) {
    const { st: _drop, ...rest } = w;
    return rest;
  }
  return { ...w, st };
}
