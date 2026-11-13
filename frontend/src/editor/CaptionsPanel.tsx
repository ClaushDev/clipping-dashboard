import { useState } from "react";
import { ANIMATIONS, PUNCTUATION_MODES } from "../remotion/Captions";
import type { CaptionPunctuation, CaptionWord, Composition } from "../remotion/schema";
import WordStylePanel, { mergeWordStyle } from "./WordStylePanel";
import type { Template } from "../types";
import { captionWordsTimeline, type CompUpdate, styleFromTemplate } from "./ops";
import { useAsk } from "../project/StepKit";

interface Props {
  comp: Composition;
  templates: Template[];
  selectedWord: number | null;
  /** Último índice de un rango (Mayús+clic) o null si solo hay una palabra elegida. */
  selectedEnd?: number | null;
  onSelectWord: (idx: number, extend: boolean) => void;
  onChange: (c: CompUpdate) => void;
  onSeek: (t: number) => void;
  /** Relee la transcripción del original para los tramos actuales (solo subtítulos con tiempos del original). */
  onRegenerate?: () => Promise<Composition["captions"]["words"]>;
  /** Pone los signos que faltan con un modelo barato (solo signos y mayúsculas). */
  onPunctuate?: () => Promise<{ words: CaptionWord[]; changed: number }>;
}

const PUNCT = /[.,!?;:…¿¡]/;

/** Palabras en tramos de 22 o más seguidas sin ningún signo (como punctuation.missing_runs del backend). */
export function missingPunctuation(words: CaptionWord[]): number {
  let run = 0, total = 0;
  for (const w of [...words, { w: "." } as CaptionWord]) {
    if (PUNCT.test(w.w)) { if (run >= 22) total += run; run = 0; } else run++;
  }
  return total;
}

export default function CaptionsPanel({ comp, templates, selectedWord, selectedEnd, onSelectWord, onChange, onSeek, onRegenerate, onPunctuate }: Props) {
  const [regen, setRegen] = useState(false);
  const [punct, setPunct] = useState<"" | "busy" | string>("");
  const [regenErr, setRegenErr] = useState("");
  const q = useAsk();
  const cap = comp.captions;
  const words = captionWordsTimeline(comp);
  const word = selectedWord !== null ? cap.words[selectedWord] : null;
  const [lo, hi] = selectedWord === null ? [-1, -1]
    : selectedEnd == null ? [selectedWord, selectedWord] : [Math.min(selectedWord, selectedEnd), Math.max(selectedWord, selectedEnd)];
  const ranged = cap.words.slice(lo, hi + 1);
  const missing = missingPunctuation(cap.words);

  const setCaptions = (patch: Partial<Composition["captions"]>) => onChange({ ...comp, captions: { ...cap, ...patch } });
  const setStyle = (patch: Partial<Composition["captions"]["style"]>) => setCaptions({ style: { ...cap.style, ...patch } });
  const setWord = (patch: Partial<(typeof cap.words)[number]> | null) => {
    if (selectedWord === null) return;
    const next = [...cap.words];
    if (patch === null) next.splice(selectedWord, 1);
    else next[selectedWord] = { ...next[selectedWord], ...patch };
    setCaptions({ words: next });
  };
  const setRangeStyle = (patch: Parameters<typeof mergeWordStyle>[1]) => {
    if (lo < 0) return;
    setCaptions({ words: cap.words.map((w, i) => (i >= lo && i <= hi ? mergeWordStyle(w, patch) : w)) });
  };

  return (
    <div className="stack">
      <label className="check">
        <input type="checkbox" checked={cap.enabled} onChange={(e) => setCaptions({ enabled: e.target.checked })} /> Mostrar subtítulos
      </label>
      {onRegenerate && cap.time_base === "source" && (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn small" disabled={regen || q.open} onClick={() => q.ask("regen", [{
            text: "¿Regenerar los subtítulos desde la transcripción del vídeo original? Se pierden los textos que hayas retocado a mano (las palabras destacadas se conservan).",
            yes: "Regenerar",
          }], async () => {
            setRegen(true);
            setRegenErr("");
            try {
              const words = await onRegenerate();
              // Sobre la composición de ahora (lo editado mientras tanto no se pierde)
              onChange((c) => ({ ...c, captions: { ...c.captions, words, enabled: true } }));
            } catch (e) {
              setRegenErr(e instanceof Error ? e.message : String(e)); // Antes, alert()
            } finally {
              setRegen(false);
            }
          })}>{regen ? "Regenerando…" : "Regenerar subtítulos"}</button>
          <span className="small muted">Tras alargar, duplicar o borrar tramos: vuelve a poner las palabras de cada tramo.</span>
        </div>
      )}
      {q.view("regen")}
      {regenErr && <div className="notice error" role="alert">{regenErr}</div>}
      <label className="field">
        Aplicar plantilla
        <select value="" onChange={(e) => {
          const t = templates.find((x) => x.id === Number(e.target.value));
          if (t) setCaptions({ style: styleFromTemplate(t) });
        }}>
          <option value="">Elige una plantilla…</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <div className="grid-2">
        <label className="field">
          Altura: {cap.style.margin_v}px
          <input type="range" min={60} max={1500} step={10} value={cap.style.margin_v} onChange={(e) => setStyle({ margin_v: Number(e.target.value) })} />
        </label>
        <label className="field">
          Tamaño: {cap.style.font_size}
          <input type="range" min={30} max={200} value={cap.style.font_size} onChange={(e) => setStyle({ font_size: Number(e.target.value) })} />
        </label>
        <label className="field">
          Palabras por bloque
          <input type="number" min={1} max={8} value={cap.style.words_per_chunk} onChange={(e) => setStyle({ words_per_chunk: Math.min(8, Math.max(1, Math.round(Number(e.target.value)) || 1)) })} />
        </label>
        <label className="field">
          Animación
          <select value={cap.style.animation} onChange={(e) => setStyle({ animation: e.target.value as Composition["captions"]["style"]["animation"] })}>
            {(["Gancho", "Serio / minimalista"] as const).map((g) => (
              <optgroup key={g} label={g}>
                {ANIMATIONS.filter((a) => a.group === g).map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field">
          Color resaltado
          <input type="color" value={cap.style.highlight_color} onChange={(e) => setStyle({ highlight_color: e.target.value.toUpperCase() })} />
        </label>
        <label className="field">
          Color resaltado 2 (cifras, nombres)
          <input type="color" value={cap.style.highlight_color2 ?? cap.style.highlight_color}
            onChange={(e) => setStyle({ highlight_color2: e.target.value.toUpperCase() })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={cap.style.active_highlight !== false} onChange={(e) => setStyle({ active_highlight: e.target.checked })} />
        Resaltar la palabra que se está diciendo
      </label>
      <label className="check">
        <input type="checkbox" checked={cap.style.placement === "below_video"}
          onChange={(e) => setStyle({ placement: e.target.checked ? "below_video" : "bottom" })} />
        Debajo del vídeo en los tramos con vídeo completo (bandas o fondo)
      </label>
      <div className="grid-2">
        <label className="field">
          Signos en pantalla
          <select value={cap.style.punctuation ?? "all"} onChange={(e) => setStyle({ punctuation: e.target.value as CaptionPunctuation })}>
            {PUNCTUATION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        {onPunctuate && (
          <div className="field">
            {missing ? `${missing} palabras seguidas sin signos` : "Puntuación completa"}
            <button className="btn small" disabled={!missing || punct === "busy"} title="Un modelo barato (Ollama o, si no está, Haiku) pone puntos, comas e interrogaciones. No cambia ninguna palabra ni tiempo."
              onClick={async () => {
                setPunct("busy");
                try {
                  const r = await onPunctuate();
                  onChange((c) => ({ ...c, captions: { ...c.captions, words: r.words } }));
                  setPunct(r.changed ? `${r.changed} palabras con signos nuevos` : "El modelo no añadió signos");
                } catch (e) {
                  setPunct(e instanceof Error ? e.message : String(e));
                }
              }}>{punct === "busy" ? "Poniendo signos…" : "Poner los signos que faltan"}</button>
          </div>
        )}
      </div>
      {punct && punct !== "busy" && <div className="small muted">{punct}</div>}
      <label className="check">
        <input type="checkbox" checked={cap.style.hook_enabled} onChange={(e) => setStyle({ hook_enabled: e.target.checked })} /> Mostrar el gancho arriba
      </label>

      <div className="field">
        Palabras · clic para editar, Mayús+clic para elegir un rango
        <div className="word-chips">
          {words.map((w) => (
            <button key={w.idx} type="button" className={`chip ${w.idx >= lo && w.idx <= hi ? "on" : ""} ${w.hl ? "hl" : w.hl2 ? "hl2" : ""} ${w.st ? "styled" : ""}`}
              onClick={(e) => { onSelectWord(w.idx, e.shiftKey); if (!e.shiftKey) onSeek(w.s); }}>{w.w}</button>
          ))}
        </div>
      </div>
      {word && ranged.length > 1 && (
        <div className="card inset stack">
          <div className="small muted">«{ranged.map((w) => w.w).join(" ").slice(0, 120)}»</div>
          <WordStylePanel words={ranged} style={cap.style} onChange={setRangeStyle} />
        </div>
      )}
      {word && ranged.length <= 1 && (
        <div className="card inset stack">
          <label className="field">
            Texto de la palabra
            <input type="text" value={word.w} onChange={(e) => setWord({ w: e.target.value })} />
          </label>
          <div className="row">
            <label className="check"><input type="checkbox" checked={!!word.hl} onChange={(e) => setWord({ hl: e.target.checked, hl2: false })} /> Destacar siempre</label>
            <label className="check"><input type="checkbox" checked={!!word.hl2} onChange={(e) => setWord({ hl2: e.target.checked, hl: false })} /> Con el color 2</label>
            <span className="spacer" />
            <button className="btn small danger" onClick={() => setWord(null)}>Quitar palabra</button>
          </div>
          <WordStylePanel words={[word]} style={cap.style} onChange={setRangeStyle} />
        </div>
      )}
    </div>
  );
}
