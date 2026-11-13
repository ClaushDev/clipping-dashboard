import { useEffect } from "react";

/** Valores que se arrastran, como en Premiere o After Effects: pulsar en el nombre de un campo numérico y mover el
 *  ratón a los lados cambia el número (Mayús = ×10, Alt = ÷10). Se aplica a todos los `label.field` con un
 *  `input[type=number]` dentro de `scope` (un selector), sin tocar cada panel. Escucha en el documento: el panel puede
 *  montarse después (el editor primero enseña «Cargando…»). */
export function useScrub(scope: string) {
  useEffect(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (!target.closest(scope) || target.closest("input, select, textarea, button")) return;
      const label = target.closest("label.field");
      const input = label?.querySelector<HTMLInputElement>("input[type=number]");
      if (!input || input.disabled) return;
      e.preventDefault();
      const step = Number(input.step) || 1;
      const min = input.min === "" ? -Infinity : Number(input.min);
      const max = input.max === "" ? Infinity : Number(input.max);
      const decimals = (String(step).split(".")[1] ?? "").length;
      const v0 = Number(input.value) || 0;
      const x0 = e.clientX;
      let last = v0;
      document.body.classList.add("scrubbing");
      const move = (ev: PointerEvent) => {
        const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
        const raw = v0 + Math.round((ev.clientX - x0) / 4) * step * k;
        const v = +Math.min(max, Math.max(min, raw)).toFixed(decimals + (ev.altKey ? 1 : 0));
        if (v === last) return;
        last = v;
        setter.call(input, String(v));
        input.dispatchEvent(new Event("input", { bubbles: true })); // React escucha «input» para su onChange
      };
      const up = () => {
        document.body.classList.remove("scrubbing");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [scope]);
}
