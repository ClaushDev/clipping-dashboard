import { useCallback, useRef, useState } from "react";

/** Estado con deshacer/rehacer. Sin `merge`, los cambios seguidos en <400 ms (escribir, deslizadores) cuentan como uno
 *  solo. Los arrastres lo dicen explícitamente: el primer movimiento abre un paso de deshacer (`merge: false`) y
 *  los siguientes se funden en él (`merge: true`), por despacio que se arrastre. */
export function useHistory<T>(initial: T) {
  const [state, setState] = useState({ past: [] as T[], present: initial, future: [] as T[] });
  const lastPush = useRef(0);

  const set = useCallback((next: T | ((prev: T) => T), merge?: boolean) => {
    // Se decide fuera del actualizador (React puede ejecutarlo dos veces y la segunda fundía el cambio con el anterior)
    const now = Date.now();
    const join = merge ?? now - lastPush.current < 400;
    lastPush.current = now;
    setState((s) => {
      const value = typeof next === "function" ? (next as (p: T) => T)(s.present) : next;
      if (value === s.present) return s;
      return { past: join ? s.past : [...s.past.slice(-80), s.present], present: value, future: [] };
    });
  }, []);

  const reset = useCallback((value: T) => setState({ past: [], present: value, future: [] }), []);

  const undo = useCallback(() => {
    lastPush.current = 0;
    setState((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s));
  }, []);

  const redo = useCallback(() => {
    lastPush.current = 0;
    setState((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s));
  }, []);

  return { value: state.present, set, reset, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}
