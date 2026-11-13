import { useCallback, useEffect, useRef, useState } from "react";

/** Carga datos y los refresca cada `intervalMs` (0 = sin refresco). */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string>("");
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(async () => {
    try {
      setData(await fetcherRef.current());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    reload();
    if (!intervalMs) return;
    const id = window.setInterval(reload, intervalMs);
    return () => window.clearInterval(id);
    // Eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, reload, ...deps]);

  return { data, error, reload, setData };
}

export function useHashRoute(): [string, URLSearchParams] {
  const read = () => {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const [path, query = ""] = raw.split("?");
    return [path || "videos", new URLSearchParams(query)] as [string, URLSearchParams];
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
