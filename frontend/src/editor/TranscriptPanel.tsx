import { useEffect, useMemo, useState } from "react";
import { type Composition, sourceWordsOnTimeline } from "../remotion/schema";
import { cutPauses, cutWords, isFiller, longPauses, wordCutRanges } from "./ops";

interface Props {
  comp: Composition;
  playhead: number;
  onChange: (c: Composition) => void;
  onSeek: (t: number) => void;
}

/** Editar borrando palabras de la transcripción: seleccionas palabras y se cortan del vídeo, con su imagen y su
 *  sonido; lo de encima se va con ellas y lo de detrás se adelanta. */
export default function TranscriptPanel({ comp, playhead, onChange, onSeek }: Props) {
  const words = useMemo(() => sourceWordsOnTimeline(comp), [comp]);
  const [sel, setSel] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [pause, setPause] = useState(0.8);
  // Si las palabras cambian (deshacer, cortar un tramo…), la selección de antes apuntaría a otras: se suelta
  useEffect(() => { setSel([]); setAnchor(null); }, [words]);

  if (comp.captions.time_base !== "source" || !comp.segments.length) {
    return (
      <div className="small muted">
        La edición por texto corta el vídeo original y su sonido: solo está en los clips que salen de un vídeo con voz.
      </div>
    );
  }
  if (!words.length) return <div className="small muted">Este vídeo no tiene transcripción (activa o regenera los subtítulos).</div>;

  const picked = new Set(sel);
  const cutLen = wordCutRanges(comp, sel).reduce((s, [a, b]) => s + b - a, 0);
  const pauses = longPauses(comp, pause);
  const click = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor !== null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      setSel(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else if (e.ctrlKey || e.metaKey) {
      setSel(picked.has(i) ? sel.filter((x) => x !== i) : [...sel, i]);
      setAnchor(i);
    } else {
      setSel([i]);
      setAnchor(i);
      onSeek(words[i].s);
    }
  };
  const cut = () => {
    if (!sel.length) return;
    onChange(cutWords(comp, sel));
    setSel([]);
    setAnchor(null);
  };

  return (
    <div className="stack">
      <div className="small muted">
        Clic en una palabra para ir a ella; Mayús+clic selecciona hasta ahí y Ctrl+clic suelta palabras. Al borrar, se cortan
        del vídeo con su imagen y su sonido (Ctrl+Z lo deshace).
      </div>
      <div className="transcript" tabIndex={0} aria-label="Transcripción"
        onKeyDown={(e) => {
          e.stopPropagation(); // Los atajos del editor (borrar la capa seleccionada…) no actúan aquí
          if ((e.key === "Delete" || e.key === "Backspace") && sel.length) {
            e.preventDefault();
            cut();
          } else if (e.key === "Escape") setSel([]);
        }}>
        {words.map((w, i) => {
          const gap = i > 0 ? w.s - words[i - 1].e : 0;
          const now = playhead >= w.s && playhead < Math.max(w.e, w.s + 0.05);
          return (
            <span key={i}>
              {gap > pause && <span className="tr-pause" title={`Pausa de ${gap.toFixed(1)} s`}>· {gap.toFixed(1)} s ·</span>}
              <span className={`tr-word${picked.has(i) ? " sel" : ""}${now ? " now" : ""}${isFiller(w.w) ? " filler" : ""}`}
                onClick={(e) => click(i, e)} title={`${w.s.toFixed(2)} s`}>{w.w}</span>{" "}
            </span>
          );
        })}
      </div>
      <div className="row">
        <button className="btn small primary" disabled={!sel.length} onClick={cut}>
          Borrar del vídeo{sel.length ? ` (${sel.length} ${sel.length === 1 ? "palabra" : "palabras"} · ${cutLen.toFixed(1)} s)` : ""}
        </button>
        <button className="btn small" disabled={!sel.length} onClick={() => setSel([])}>Deseleccionar</button>
        <span className="grow" />
        <button className="btn small" title="Selecciona eh, em, um, uh… para revisarlas antes de borrar"
          onClick={() => setSel(words.map((w, i) => (isFiller(w.w) ? i : -1)).filter((i) => i >= 0))}>Seleccionar muletillas</button>
      </div>
      <div className="row small">
        <span>Pausas de más de</span>
        <select className="small-select" value={pause} onChange={(e) => setPause(Number(e.target.value))} aria-label="Pausa mínima">
          {[0.5, 0.8, 1.2, 2].map((v) => <option key={v} value={v}>{v} s</option>)}
        </select>
        <span className="grow muted">{pauses.length ? `${pauses.length} en el vídeo · se quitan ${pauses.reduce((s, [a, b]) => s + b - a, 0).toFixed(1)} s` : "ninguna"}</span>
        <button className="btn small" disabled={!pauses.length} title="Las deja en 0,25 s (ojo: también corta lo que se ve en esas pausas)"
          onClick={() => onChange(cutPauses(comp, pause))}>Acortar pausas</button>
      </div>
    </div>
  );
}
