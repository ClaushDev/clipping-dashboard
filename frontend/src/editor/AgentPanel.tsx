import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Composition } from "../remotion/schema";
import type { AgentMessage } from "../types";

interface Props {
  clipId: number;
  comp: Composition;
  playhead: number;
  selection: string;
  onApply: (c: Composition) => void;
  onUndo: () => void;
  canUndo: boolean;
  /** Cambia cada vez que se abre la barra de comandos: el cursor va al campo. */
  focus?: number;
  /** Avisa de si la IA está pensando (la barra puede estar cerrada mientras tanto). */
  onBusy?: (busy: boolean) => void;
}

const EXAMPLES = [
  "Pon un círculo rojo sobre la pelota cuando dice «ball» y un whoosh",
  "Congela la imagen al final del primer tramo y añade un rayado de disco",
  "Haz un punch-in en el segundo 3 y quita la música",
  "Los subtítulos más grandes y en amarillo",
];

/** Chat de edición: lo que pidas se convierte en cambios en la línea de tiempo (deshacer con Ctrl+Z). */
export default function AgentPanel({ clipId, comp, playhead, selection, onApply, onUndo, canUndo, focus, onBusy }: Props) {
  const key = `agent-chat-${clipId}`;
  const [messages, setMessages] = useState<AgentMessage[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "[]");
    } catch {
      return [];
    }
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focus) inputRef.current?.focus(); }, [focus]);
  useEffect(() => { onBusy?.(busy); }, [busy]); // Eslint-disable-line react-hooks/exhaustive-deps
  // Si editas mientras la IA piensa (10-40 s), su versión no pisa tus cambios sin preguntar
  const live = useRef(comp);
  live.current = comp;
  const [pending, setPending] = useState<Composition | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(messages.slice(-30)));
    } catch {
      /* Sin almacenamiento: el chat dura lo que la página */
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, key]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setError("");
    setBusy(true);
    const history = messages.map(({ role, text }) => ({ role, text }));
    setMessages((m) => [...m, { role: "user", text: message }]);
    setText("");
    try {
      const sent = comp;
      const r = await api.agent(clipId, { composition: sent, message, history, playhead, selection });
      if (r.composition) {
        if (live.current === sent) onApply(r.composition);
        else setPending(r.composition);
      }
      setMessages((m) => [...m, { role: "assistant", text: r.reply, changes: r.changes }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="agent">
      <div className="agent-list" ref={listRef}>
        {!messages.length && (
          <div className="small muted stack" style={{ gap: 6 }}>
            <span>Pide cambios como se los pedirías a un editor. La IA ve la línea de tiempo, los subtítulos y, si hace
              falta, los fotogramas; localiza objetos para colocar círculos y flechas encima.</span>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="agent-example" onClick={() => send(ex)} disabled={busy}>{ex}</button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`agent-msg ${m.role}`}>
            <div>{m.text}</div>
            {m.changes && m.changes.length > 0 && (
              <ul className="agent-changes">{m.changes.map((c, k) => <li key={k}>{c}</li>)}</ul>
            )}
          </div>
        ))}
        {busy && <div className="agent-msg assistant muted">Pensando y editando… (10-40 s)</div>}
      </div>
      {error && <div className="notice error">{error}</div>}
      {pending && (
        <div className="ca-ask" role="alertdialog" aria-label="Aplicar los cambios de la IA">
          <p>Has editado mientras la IA pensaba. Sus cambios parten de la versión de antes: si los aplicas, lo que tocaste mientras
            tanto se pierde (se recupera con Ctrl+Z).</p>
          <div className="ca-ask-acts">
            <button className="btn small ghost" onClick={() => setPending(null)}>Descartar los de la IA</button>
            <button className="btn small" onClick={() => { onApply(pending); setPending(null); }}>Aplicar igualmente</button>
          </div>
        </div>
      )}
      <form className="agent-input" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <textarea ref={inputRef} value={text} rows={2} placeholder={`Qué cambio quieres (cursor en ${playhead.toFixed(1)} s)…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
        <div className="row">
          <button className="btn primary small" disabled={busy || !text.trim() || !!pending}>Enviar</button>
          <button type="button" className="btn small" disabled={!canUndo || busy} onClick={onUndo} title="Ctrl+Z">Deshacer último cambio</button>
          {messages.length > 0 && <button type="button" className="btn small" disabled={busy} onClick={() => setMessages([])}>Nuevo chat</button>}
        </div>
      </form>
    </div>
  );
}
