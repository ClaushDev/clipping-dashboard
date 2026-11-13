import { useEffect, useState } from "react";
import { ATTR_LABEL, type AttrGroup } from "./attributes";

/** Qué atributos se pegan (todos marcados al abrir). */
export default function PasteAttrsDialog({ groups, from, onPaste, onClose }: {
  groups: AttrGroup[];
  from: string;
  onPaste: (groups: AttrGroup[]) => void;
  onClose: () => void;
}) {
  const [on, setOn] = useState<Set<AttrGroup>>(new Set(groups));
  useEffect(() => { // Esc cierra
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal card stack" role="dialog" aria-label="Pegar atributos" style={{ maxWidth: 440 }}>
        <strong>Pegar atributos de {from}</strong>
        {groups.map((g) => (
          <label key={g} className="row small">
            <input type="checkbox" checked={on.has(g)}
              onChange={(e) => setOn((s) => { const n = new Set(s); if (e.target.checked) n.add(g); else n.delete(g); return n; })} />
            {ATTR_LABEL[g]}
          </label>
        ))}
        <div className="row">
          <span className="grow" />
          <button className="btn small" onClick={onClose}>Cancelar</button>
          <button className="btn small primary" disabled={!on.size} onClick={() => onPaste(groups.filter((g) => on.has(g)))}>Pegar</button>
        </div>
      </div>
    </div>
  );
}
