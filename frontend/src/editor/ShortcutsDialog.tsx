import { useEffect, useState } from "react";
import { comboLabel, comboOf, defaultKeyMap, type KeyMap, saveKeyMap, type ShortcutAction, SHORTCUTS } from "./shortcuts";

/** Tabla de atajos. «Cambiar» espera la siguiente pulsación; si ya la usaba otra acción, se le quita a esa. */
export default function ShortcutsDialog({ map, onChange, onClose }: { map: KeyMap; onChange: (m: KeyMap) => void; onClose: () => void }) {
  const [listening, setListening] = useState<ShortcutAction | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const c = comboOf(e);
      if (!c) return;
      if (c === "escape" && listening !== "deselect") { setListening(null); return; }
      const next = { ...map };
      const other = SHORTCUTS.find((s) => s.action !== listening && next[s.action].includes(c));
      if (other) next[other.action] = next[other.action].filter((k) => k !== c);
      next[listening] = [c];
      setNote(other ? `${comboLabel(c)} ya no hace «${other.label}».` : "");
      saveKeyMap(next);
      onChange(next);
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, map, onChange]);

  // Esc cierra el diálogo (cuando no está esperando una tecla)
  useEffect(() => {
    if (listening) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listening, onClose]);

  const reset = () => {
    const def = defaultKeyMap();
    saveKeyMap(def);
    onChange(def);
    setNote("Atajos restaurados.");
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card stack shortcuts-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Atajos de teclado">
        <div className="row">
          <strong className="grow">Atajos de teclado</strong>
          <button className="btn small" onClick={reset}>Restaurar los de siempre</button>
          <button className="btn small" onClick={onClose}>Cerrar</button>
        </div>
        <div className="small muted">Pulsa «Cambiar» y luego la tecla o combinación nueva (Esc cancela). Se guardan en este navegador.</div>
        {note && <div className="small">{note}</div>}
        <div className="shortcut-list">
          {SHORTCUTS.map((s) => (
            <div key={s.action} className={`shortcut-row ${listening === s.action ? "on" : ""}`}>
              <span className="grow">{s.label}</span>
              <span className="shortcut-keys">
                {listening === s.action ? <em className="small muted">Pulsa una tecla…</em>
                  : map[s.action].length ? map[s.action].map((k) => <kbd key={k}>{comboLabel(k)}</kbd>) : <span className="faint small">sin atajo</span>}
              </span>
              <button className="btn small" onClick={() => setListening(listening === s.action ? null : s.action)}>{listening === s.action ? "Cancelar" : "Cambiar"}</button>
              <button className="btn small icon ghost" title="Quitar el atajo" aria-label={`Quitar el atajo de ${s.label}`}
                disabled={!map[s.action].length} onClick={() => { const next = { ...map, [s.action]: [] }; saveKeyMap(next); onChange(next); }}>×</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
