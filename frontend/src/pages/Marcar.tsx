import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { fmtTime, usePoll } from "../hooks";
import type { MarkingData, Word } from "../types";
import { drawHeat, type HeatPoint } from "../components/heat";

interface MarkT {
  id: string;
  start: number;
  end: number;
  title: string;
}

interface View {
  start: number;
  span: number;
}

type Range = { start: number; end: number };

const uid = () => Math.random().toString(36).slice(2, 9);
const storeKey = (id: number) => `clipping.marks.${id}`;
const MIN_SPAN = 5;

function parseTime(text: string): number | null {
  const parts = text.trim().split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function loadMarks(id: number): MarkT[] {
  try {
    return JSON.parse(localStorage.getItem(storeKey(id)) ?? "[]");
  } catch {
    return [];
  }
}

function saveMarks(id: number, marks: MarkT[]) {
  try {
    if (marks.length) localStorage.setItem(storeKey(id), JSON.stringify(marks));
    else localStorage.removeItem(storeKey(id));
  } catch {
    /* Sin almacenamiento: las marcas viven solo en esta sesión */
  }
}

/** Índice de la última palabra que empieza antes de t (búsqueda binaria). */
function wordAt(words: Word[], t: number): number {
  let lo = 0, hi = words.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export default function Marcar({ sourceId }: { sourceId: number }) {
  const data = usePoll(() => api.marking(sourceId), 0, [sourceId]);
  const peaks = usePoll(() => api.peaks(sourceId), 0, [sourceId]);
  const [marks, setMarks] = useState<MarkT[]>(() => loadMarks(sourceId));
  const [view, setView] = useState<View>({ start: 0, span: 120 });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pendingIn, setPendingIn] = useState<number | null>(null);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [follow, setFollow] = useState(true);
  const [snap, setSnap] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stopAt = useRef<number | null>(null);

  const d = data.data;
  const duration = d?.source.duration || 0;
  const words = d?.words ?? [];

  useEffect(() => saveMarks(sourceId, marks), [sourceId, marks]);
  useEffect(() => { if (duration) setView((v) => ({ start: 0, span: Math.min(v.span, duration) })); }, [duration]);

  // Reloj fluido mientras se reproduce (timeupdate solo llega ~4 veces por segundo).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        setTime(v.currentTime);
        if (stopAt.current !== null && v.currentTime >= stopAt.current) {
          v.pause();
          stopAt.current = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // La forma de onda sigue al cabezal mientras se reproduce.
  useEffect(() => {
    if (!playing || !duration) return;
    if (time > view.start + view.span * 0.95 || time < view.start) {
      setView((v) => ({ ...v, start: Math.max(0, Math.min(duration - v.span, time - v.span * 0.1)) }));
    }
  }, [time, playing, duration, view.start, view.span]);

  // Palabra actual resaltada en la transcripción (directo en el DOM: re-renderizar miles de palabras cada fotograma es caro).
  const current = wordAt(words, time);
  useEffect(() => {
    const box = transcriptRef.current;
    if (!box) return;
    box.querySelector(".now")?.classList.remove("now");
    const el = current >= 0 ? box.querySelector<HTMLElement>(`[data-i="${current}"]`) : null;
    if (!el) return;
    el.classList.add("now");
    if (follow && playing) {
      const top = el.offsetTop - box.offsetTop;
      if (top < box.scrollTop + 40 || top > box.scrollTop + box.clientHeight - 60) box.scrollTop = top - box.clientHeight / 3;
    }
  }, [current, follow, playing]);

  const seek = useCallback((t: number, play = false) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration || t, t));
    setTime(v.currentTime);
    if (play) void v.play();
  }, [duration]);

  const addMark = useCallback((start: number, end: number, title = "") => {
    const [a, b] = start < end ? [start, end] : [end, start];
    if (b - a < 1) return;
    setMarks((ms) => [...ms, { id: uid(), start: +a.toFixed(2), end: +b.toFixed(2), title }].sort((x, y) => x.start - y.start));
    setMessage(null);
  }, []);

  const updateMark = (id: string, patch: Partial<MarkT>) =>
    setMarks((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)).sort((x, y) => x.start - y.start));

  const addSelection = () => {
    if (!selection) return;
    addMark(words[selection[0]].s, words[selection[1]].e);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  function setOut() {
    if (pendingIn === null) {
      setPendingIn(time);
      return;
    }
    addMark(pendingIn, time);
    setPendingIn(null);
  }

  // Atajos: Espacio reproduce, I/O marcan entrada y salida, flechas mueven el cabezal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = videoRef.current;
      if (!v) return;
      if (e.code === "Space") {
        e.preventDefault();
        stopAt.current = null;
        if (v.paused) void v.play(); else v.pause();
      } else if (e.key === "i" || e.key === "I") {
        setPendingIn(v.currentTime);
      } else if (e.key === "o" || e.key === "O") {
        if (pendingIn !== null) {
          addMark(pendingIn, v.currentTime);
          setPendingIn(null);
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        seek(v.currentTime + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1));
      } else if (e.key === "Escape") {
        setPendingIn(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingIn, addMark, seek]);

  async function create() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.createMarks(sourceId, marks.map(({ start, end, title }) => ({ start, end, title })), snap);
      setMarks([]);
      data.reload();
      setMessage({ ok: true, text: `${r.clip_ids.length} clips creados. La IA los puntúa y después se renderizan.` });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  if (data.error) {
    return (
      <>
        <div className="page-head"><div><a className="btn small" href="#/videos">← Vídeos</a><h1 style={{ marginTop: 10 }}>Marcar clips</h1></div></div>
        <div className="notice error">{data.error}</div>
      </>
    );
  }
  if (!d) return <div className="muted">Cargando vídeo y transcripción…</div>;

  const selRange = selection ? { start: words[selection[0]].s, end: words[selection[1]].e } : null;
  const totalMarked = marks.reduce((a, m) => a + m.end - m.start, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <a className="btn small" href="#/videos">← Vídeos</a>
          <h1 style={{ marginTop: 10 }}>Marcar clips</h1>
          <p>{d.source.title} · {fmtTime(duration)}</p>
        </div>
        <div className="row small muted">
          <span><kbd>Espacio</kbd> reproducir</span><span><kbd>I</kbd> entrada</span><span><kbd>O</kbd> salida</span>
          <span><kbd>←</kbd><kbd>→</kbd> ±1 s (Mayús ±5 s)</span>
        </div>
      </div>

      <div className="mark-top">
        <div className="mark-video">
          <video ref={videoRef} src={d.source.video_url} preload="metadata" controls
            onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); setTime(videoRef.current?.currentTime ?? 0); }}
            onSeeked={() => setTime(videoRef.current?.currentTime ?? 0)} />
        </div>
        <div className="mark-transcript card">
          <div className="row" style={{ marginBottom: 8 }}>
            <strong className="small">Transcripción</strong>
            <span className="small muted">Selecciona frases arrastrando para marcar un clip · clic en una palabra para ir ahí</span>
            <span className="spacer" />
            <label className="check small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Seguir</label>
          </div>
          <Transcript ref={transcriptRef} segments={d.segments} words={words} marks={marks}
            onSeek={seek} onSelect={setSelection} />
          <div className="row" style={{ marginTop: 8, minHeight: 30 }}>
            {selRange ? (
              <button className="btn small primary" onClick={addSelection}>
                Marcar selección como clip ({fmtTime(selRange.start)} – {fmtTime(selRange.end)} · {(selRange.end - selRange.start).toFixed(0)} s)
              </button>
            ) : <span className="small muted">Sin selección</span>}
          </div>
        </div>
      </div>

      <div className="card mark-wave">
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="btn small" onClick={() => setPendingIn(time)}>Entrada aquí (I)</button>
          <button className="btn small" disabled={pendingIn === null} onClick={setOut}>Salida aquí (O)</button>
          {pendingIn !== null && <span className="small">Entrada en {fmtTime(pendingIn)} · {Math.max(0, time - pendingIn).toFixed(1)} s <button className="btn small" onClick={() => setPendingIn(null)}>✕</button></span>}
          <span className="spacer" />
          <span className="small muted">{fmtTime(time)}</span>
          <button className="btn small" aria-label="Alejar" onClick={() => setView((v) => zoom(v, 1.6, time, duration))}>−</button>
          <button className="btn small" aria-label="Acercar" onClick={() => setView((v) => zoom(v, 1 / 1.6, time, duration))}>+</button>
          <span className="small muted">{Math.round(view.span)} s visibles</span>
        </div>
        {peaks.error && <div className="notice error">No se pudo leer el audio: {peaks.error}</div>}
        <Waveform peaks={peaks.data?.peaks ?? []} heat={peaks.data?.heat} step={peaks.data?.step ?? 0.1} duration={duration} view={view}
          setView={setView} marks={marks} clips={d.clips} time={time} pendingIn={pendingIn} highlight={selRange}
          onSeek={seek} onCreate={addMark}
          onEdit={(id, edge, t) => setMarks((ms) => ms.map((m) => m.id !== id ? m
            : edge === "start" ? { ...m, start: Math.min(+t.toFixed(2), m.end - 1) } : { ...m, end: Math.max(+t.toFixed(2), m.start + 1) }))} />
        <div className="small muted" style={{ marginTop: 6 }}>
          Arrastra sobre la onda para marcar un tramo · arrastra los bordes para ajustarlo · rueda para hacer zoom, Mayús + rueda para desplazarte.
          En gris, los clips que ya existen de este vídeo.
          {peaks.data?.heat?.length ? <> En naranja, <b>lo más reproducido en YouTube</b>: las partes que la gente vuelve a ver.</> : null}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Tramos marcados</h2>
          <span className="small muted">{marks.length} · {Math.round(totalMarked)} s en total · se guardan en este navegador hasta que crees los clips</span>
        </div>
        {marks.length === 0 ? (
          <div className="small muted">Aún no has marcado nada. Selecciona texto en la transcripción, arrastra sobre la onda o usa I y O mientras lo escuchas.</div>
        ) : (
          <div className="marks">
            {marks.map((m, n) => {
              const len = m.end - m.start;
              return (
                <div className="mark-row" key={m.id}>
                  <span className="mark-n">{n + 1}</span>
                  <TimeInput value={m.start} onChange={(t) => t < m.end - 1 && updateMark(m.id, { start: t })} label="Inicio" />
                  <TimeInput value={m.end} onChange={(t) => t > m.start + 1 && t <= duration && updateMark(m.id, { end: t })} label="Fin" />
                  <span className={`small ${len < 10 || len > 90 ? "warn-text" : "muted"}`} title="Recomendado: 15–60 s">{len.toFixed(1)} s</span>
                  <input type="text" value={m.title} onChange={(e) => updateMark(m.id, { title: e.target.value })}
                    placeholder="Título (opcional: si lo dejas vacío lo propone la IA)" aria-label="Título" />
                  <button className="btn small" onClick={() => { stopAt.current = m.end; seek(m.start, true); }}>▶ Escuchar</button>
                  <button className="btn small danger" aria-label="Quitar tramo" onClick={() => setMarks((ms) => ms.filter((x) => x.id !== m.id))}>✕</button>
                </div>
              );
            })}
          </div>
        )}
        {message && <div className={`notice ${message.ok ? "" : "error"}`} style={{ marginTop: 12 }}>
          {message.text} {message.ok && <a href={`#/video?id=${sourceId}`}>Revisarlos en la ficha del vídeo</a>}
        </div>}
        <div className="row" style={{ marginTop: 12 }}>
          <label className="check small"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> No cortar palabras a medias</label>
          <span className="spacer" />
          <button className="btn primary" disabled={busy || marks.length === 0} onClick={create}>
            {busy ? "Creando…" : `Crear ${marks.length || ""} clip${marks.length === 1 ? "" : "s"} y puntuarlos`}
          </button>
        </div>
      </div>
    </>
  );
}

function zoom(v: View, factor: number, center: number, duration: number): View {
  const span = Math.max(MIN_SPAN, Math.min(duration || v.span, v.span * factor));
  const rel = v.span ? (center - v.start) / v.span : 0.5;
  const start = Math.max(0, Math.min((duration || span) - span, center - rel * span));
  return { start, span };
}

export function TimeInput({ value, onChange, label }: { value: number; onChange: (t: number) => void; label: string }) {
  const [text, setText] = useState(fmtTime(value));
  useEffect(() => setText(fmtTime(value)), [value]);
  return (
    <input type="text" className="time-input" value={text} aria-label={label} onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = parseTime(text);
        if (t === null) setText(fmtTime(value));
        else onChange(t);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

const Transcript = memo(function Transcript({ ref, segments, words, marks, onSeek, onSelect }: {
  ref: React.Ref<HTMLDivElement>;
  segments: MarkingData["segments"];
  words: Word[];
  marks: MarkT[];
  onSeek: (t: number) => void;
  onSelect: (sel: [number, number] | null) => void;
}) {
  // Párrafos por segmento de Whisper, con el índice global de cada palabra.
  const paragraphs = useMemo(() => {
    const out: { start: number; idx: number[] }[] = [];
    let i = 0;
    segments.forEach((seg, n) => {
      const next = segments[n + 1]?.s ?? Infinity;
      const idx: number[] = [];
      while (i < words.length && words[i].s < next - 0.05) idx.push(i++);
      if (idx.length) out.push({ start: seg.s, idx });
    });
    while (i < words.length) out[out.length - 1]?.idx.push(i++);
    return out;
  }, [segments, words]);

  const marked = useMemo(() => {
    const set = new Set<number>();
    marks.forEach((m) => words.forEach((w, i) => { if (w.s >= m.start - 0.05 && w.e <= m.end + 0.05) set.add(i); }));
    return set;
  }, [marks, words]);

  function indexOf(node: Node | null): number | null {
    const el = node instanceof Element ? node : node?.parentElement;
    const span = el?.closest<HTMLElement>("[data-i]");
    return span ? Number(span.dataset.i) : null;
  }

  function onMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      onSelect(null);
      return;
    }
    const a = indexOf(sel.anchorNode), b = indexOf(sel.focusNode);
    if (a === null || b === null) return onSelect(null);
    onSelect(a <= b ? [a, b] : [b, a]);
  }

  function onClick(e: React.MouseEvent) {
    if (!window.getSelection()?.isCollapsed) return;
    const i = indexOf(e.target as Node);
    if (i !== null) onSeek(words[i].s);
  }

  return (
    <div className="mark-text" ref={ref} onMouseUp={onMouseUp} onClick={onClick}>
      {paragraphs.map((p) => (
        <p key={p.idx[0]}>
          <button className="ts" onClick={(e) => { e.stopPropagation(); onSeek(p.start); }}>{fmtTime(p.start).replace(/\.\d$/, "")}</button>
          {p.idx.map((i) => <span key={i} data-i={i} className={marked.has(i) ? "in" : undefined}>{words[i].w} </span>)}
        </p>
      ))}
    </div>
  );
});

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function Waveform({ peaks, heat, step, duration, view, setView, marks, clips, time, pendingIn, highlight, onSeek, onCreate, onEdit }: {
  peaks: number[]; heat?: HeatPoint[]; step: number; duration: number; view: View; setView: React.Dispatch<React.SetStateAction<View>>;
  marks: MarkT[]; clips: MarkingData["clips"]; time: number; pendingIn: number | null; highlight: Range | null;
  onSeek: (t: number) => void; onCreate: (a: number, b: number) => void;
  onEdit: (id: string, edge: "start" | "end", t: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [ghost, setGhost] = useState<Range | null>(null);
  const H = 130, OH = 30;

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)));
    ro.observe(wrapRef.current!);
    return () => ro.disconnect();
  }, []);

  const tx = useCallback((t: number) => ((t - view.start) / view.span) * width, [view, width]);
  const xt = useCallback((x: number) => view.start + (x / width) * view.span, [view, width]);

  // Rueda: zoom alrededor del cursor; con Mayús (o rueda horizontal), desplazamiento.
  useEffect(() => {
    const c = canvasRef.current!;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const x = e.offsetX;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const delta = (e.shiftKey ? e.deltaY : e.deltaX) > 0 ? 1 : -1;
        setView((v) => ({ ...v, start: Math.max(0, Math.min(duration - v.span, v.start + delta * v.span * 0.12)) }));
      } else {
        setView((v) => zoom(v, e.deltaY > 0 ? 1.25 : 0.8, v.start + (x / width) * v.span, duration));
      }
    }
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [duration, width, setView]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const text = cssVar("--text"), muted = cssVar("--muted"), accent = cssVar("--accent"), info = cssVar("--info");
    ctx.clearRect(0, 0, width, H);
    const top = 18, h = H - top - 4, mid = top + h / 2;

    // Marcas de tiempo
    const tick = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200].find((s) => view.span / s <= 12) ?? 1800;
    ctx.fillStyle = muted;
    ctx.font = "11px system-ui, sans-serif";
    ctx.globalAlpha = 0.8;
    for (let t = Math.ceil(view.start / tick) * tick; t <= view.start + view.span; t += tick) {
      const x = tx(t);
      ctx.fillRect(x, top - 4, 1, 4);
      ctx.fillText(fmtTime(t).replace(/\.0$/, ""), x + 3, 11);
    }
    ctx.globalAlpha = 1;

    const band = (r: Range, color: string, alpha: number) => {
      const x0 = Math.max(0, tx(r.start)), x1 = Math.min(width, tx(r.end));
      if (x1 <= 0 || x0 >= width) return;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(x0, top, x1 - x0, h);
      ctx.globalAlpha = 1;
    };
    clips.forEach((c) => band(c, muted, 0.16));
    if (highlight) band(highlight, info, 0.18);
    marks.forEach((m) => band(m, accent, 0.22));
    if (ghost) band(ghost, accent, 0.3);
    drawHeat(ctx, heat, tx, top, h, cssVar("--warn"));

    // Forma de onda: el máximo de cada píxel.
    if (peaks.length) {
      for (let x = 0; x < width; x++) {
        const t0 = xt(x), t1 = xt(x + 1);
        const i0 = Math.max(0, Math.floor(t0 / step)), i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil(t1 / step)));
        let v = 0;
        for (let i = i0; i < i1; i++) if (peaks[i] > v) v = peaks[i];
        const bh = Math.max(1, Math.pow(v / 255, 1.8) * h); // Curva: más contraste entre voz y silencios
        const inMark = marks.some((m) => t0 >= m.start && t0 <= m.end);
        ctx.fillStyle = inMark ? accent : text;
        ctx.globalAlpha = inMark ? 0.95 : 0.45;
        ctx.fillRect(x, mid - bh / 2, 1, bh);
      }
      ctx.globalAlpha = 1;
    }

    // Bordes y números de las marcas, y puntuación de los clips existentes
    marks.forEach((m, n) => {
      ctx.fillStyle = accent;
      [m.start, m.end].forEach((t) => ctx.fillRect(tx(t) - 1, top, 2, h));
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.fillText(String(n + 1), tx(m.start) + 4, top + 12);
    });
    clips.forEach((c) => {
      const x = tx(c.start);
      if (x > -40 && x < width) {
        ctx.fillStyle = muted;
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText(`${c.origin === "manual" ? "manual" : "IA"} ${c.score || ""}`, x + 4, H - 8);
      }
    });
    if (pendingIn !== null) {
      ctx.fillStyle = info;
      ctx.fillRect(tx(pendingIn) - 1, top, 2, h);
    }
    ctx.fillStyle = text;
    ctx.fillRect(tx(time) - 1, 0, 2, H);
  }, [peaks, heat, step, view, width, marks, clips, time, pendingIn, ghost, highlight, tx, xt]);

  // Vista general del vídeo completo con la ventana visible.
  useEffect(() => {
    const c = overRef.current;
    if (!c || !duration) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = OH * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, OH);
    const sx = (t: number) => (t / duration) * width;
    const text = cssVar("--text"), accent = cssVar("--accent"), muted = cssVar("--muted");
    if (peaks.length) {
      const per = peaks.length / width;
      ctx.fillStyle = text;
      ctx.globalAlpha = 0.3;
      for (let x = 0; x < width; x++) {
        let v = 0;
        for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) if (peaks[i] > v) v = peaks[i];
        const bh = Math.max(1, (v / 255) * (OH - 6));
        ctx.fillRect(x, OH / 2 - bh / 2, 1, bh);
      }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = muted;
    clips.forEach((cl) => ctx.fillRect(sx(cl.start), OH - 4, Math.max(2, sx(cl.end) - sx(cl.start)), 4));
    ctx.fillStyle = accent;
    marks.forEach((m) => ctx.fillRect(sx(m.start), 0, Math.max(2, sx(m.end) - sx(m.start)), 4));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx(view.start) + 0.5, 0.5, Math.max(3, sx(view.span) - 1), OH - 1);
    ctx.fillStyle = text;
    ctx.fillRect(sx(time), 0, 1, OH);
  }, [peaks, duration, width, view, marks, clips, time]);

  function onDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const t0 = xt(x0);
    const edge = marks.flatMap((m) => [
      { id: m.id, edge: "start" as const, d: Math.abs(tx(m.start) - x0) },
      { id: m.id, edge: "end" as const, d: Math.abs(tx(m.end) - x0) },
    ]).filter((m) => m.d < 7).sort((a, b) => a.d - b.d)[0];
    let moved = false;
    let range: Range | null = null;
    const toT = (ev: MouseEvent) => Math.max(0, Math.min(duration, xt(Math.max(0, Math.min(width, ev.clientX - rect.left)))));
    function move(ev: MouseEvent) {
      if (Math.abs(ev.clientX - rect.left - x0) > 4) moved = true;
      if (!moved) return;
      const t = toT(ev);
      if (edge) onEdit(edge.id, edge.edge, t);
      else {
        range = { start: Math.min(t0, t), end: Math.max(t0, t) };
        setGhost(range);
      }
    }
    function up() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setGhost(null);
      if (!moved) onSeek(t0);
      else if (range && !edge) onCreate(range.start, range.end);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function onOverview(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const center = (ev: { clientX: number }) => {
      const t = ((ev.clientX - rect.left) / rect.width) * duration;
      setView((v) => ({ ...v, start: Math.max(0, Math.min(duration - v.span, t - v.span / 2)) }));
    };
    center(e);
    const move = (ev: MouseEvent) => center(ev);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const hoverCursor = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const nearEdge = marks.some((m) => Math.abs(tx(m.start) - x) < 7 || Math.abs(tx(m.end) - x) < 7);
    e.currentTarget.style.cursor = nearEdge ? "ew-resize" : "crosshair";
  };

  return (
    <div ref={wrapRef} className="wave">
      <canvas ref={canvasRef} style={{ width, height: H }} onMouseDown={onDown} onMouseMove={hoverCursor}
        aria-label="Forma de onda del vídeo" />
      <canvas ref={overRef} className="wave-overview" style={{ width, height: OH }} onMouseDown={onOverview}
        aria-label="Vista general del vídeo completo" />
    </div>
  );
}
