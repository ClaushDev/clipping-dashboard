import { X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import AgentPanel from "./AgentPanel";
import type { Composition } from "../remotion/schema";

interface Props {
  open: boolean;
  onClose: () => void;
  hint: string;
  clipId: number;
  comp: Composition;
  playhead: number;
  selection: string;
  onApply: (c: Composition) => void;
  onUndo: () => void;
  canUndo: boolean;
  onBusy: (busy: boolean) => void;
}

/** El agente de edición en una barra de comandos (Ctrl+K) sobre el visor, en vez de una pestaña del inspector.
 *  Se queda montada aunque esté cerrada: si la IA está pensando, su respuesta llega igual. */
export default function CommandBar({ open, onClose, hint, ...agent }: Props) {
  const [focus, setFocus] = useState(0);
  useEffect(() => { if (open) setFocus((n) => n + 1); }, [open]);
  return (
    <div className="ed-cmd-scrim" hidden={!open} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ed-cmd" role="dialog" aria-label="Pedir un cambio a la IA"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <div className="ed-cmd-head">
          <b>Pide un cambio con tus palabras</b>
          <span className="small muted">se aplica en la línea de tiempo y se deshace con Ctrl+Z · {hint} abre y cierra · Esc cierra</span>
          <span className="grow" />
          <button className="btn small icon ghost" onClick={onClose} aria-label="Cerrar"><X size={14} /></button>
        </div>
        <AgentPanel {...agent} focus={open ? focus : 0} />
      </div>
    </div>
  );
}
