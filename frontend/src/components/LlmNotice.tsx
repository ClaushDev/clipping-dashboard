import { ArrowsClockwise, Info, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { LlmNotice as Notice } from "../api";

/** Aviso flotante de la IA: respuesta reutilizada de la caché (con «Regenerar») o respaldo de Ollama a Claude Haiku. */
export default function LlmNotice() {
  const [n, setN] = useState<Notice | null>(null);
  const [state, setState] = useState<"" | "busy" | "done" | "error">("");
  const [error, setError] = useState("");

  useEffect(() => {
    const on = (e: Event) => {
      setN((e as CustomEvent<Notice>).detail);
      setState("");
    };
    window.addEventListener("llm-notice", on);
    return () => window.removeEventListener("llm-notice", on);
  }, []);

  useEffect(() => {
    if (!n || state === "busy") return;
    const id = window.setTimeout(() => setN(null), state === "done" ? 15000 : 9000);
    return () => window.clearTimeout(id);
  }, [n, state]);

  if (!n) return null;

  async function regenerate() {
    setState("busy");
    try {
      await n!.regenerate!();
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  return (
    <div className={`llm-notice ${n.kind}`} role="status">
      <Info size={16} weight="fill" />
      <span className="grow">
        {state === "done" ? "Respuesta nueva guardada. Recarga la vista para verla."
          : state === "error" ? `No se pudo regenerar: ${error}`
          : state === "busy" ? "Pidiendo una respuesta nueva a la IA…" : n.text}
      </span>
      {n.regenerate && state === "" && (
        <button className="btn small" onClick={regenerate} title="Vuelve a pedirlo a la IA sin usar la respuesta guardada">
          <ArrowsClockwise size={14} /> Regenerar
        </button>
      )}
      {state === "done" && <button className="btn small" onClick={() => window.location.reload()}>Recargar</button>}
      <button className="btn icon ghost small" onClick={() => setN(null)} aria-label="Cerrar aviso"><X size={14} /></button>
    </div>
  );
}
