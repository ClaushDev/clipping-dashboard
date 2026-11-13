import { useEffect, useRef } from "react";
import { api, type LiveStep } from "../api";
import { usePoll } from "../hooks";
import { NAV } from "../nav";

/** Color de barra de un paso: amarillo IA · cian modelo local · verde render · magenta audio. */
export function kindClass(st: Pick<LiveStep, "kind" | "label" | "model">): string {
  if (st.kind === "llm" || st.kind === "agent") return "k-ia";
  if (st.kind === "render" || st.kind === "ffmpeg") return "k-render";
  if (st.kind === "whisper" || st.kind === "api") return "k-audio";
  if (st.kind === "ml" && /voz|timbre|m[uú]sica|separar/i.test(st.label)) return "k-audio";
  return "k-gpu";
}

const ORDER = ["k-idle", "k-ia", "k-gpu", "k-render", "k-audio", "k-need", "k-queue"];

/** La banda de colores de arriba del todo: cada barra se enciende cuando hay algo de ese tipo. */
export function Signal({ reviewCount }: { reviewCount: number }) {
  const act = usePoll(api.activity, 3000);
  const d = act.data;
  const live = [...(d?.jobs.flatMap((j) => j.current) ?? []), ...(d?.direct ?? [])];
  const on = new Set(live.map(kindClass));
  if (reviewCount > 0) on.add("k-need");
  if ((d?.queued ?? 0) > 0) on.add("k-queue");
  if (!live.length) on.add("k-idle");
  const names: Record<string, string> = {
    "k-idle": "en reposo", "k-ia": "IA trabajando", "k-gpu": "modelo local trabajando", "k-render": "render en marcha",
    "k-audio": "audio en marcha", "k-need": "hay vídeos por revisar", "k-queue": "hay trabajos en cola",
  };
  const title = `Señal: ${ORDER.filter((k) => on.has(k)).map((k) => names[k]).join(" · ")}`;
  return (
    <div className="ca-signal" title={title} aria-hidden>
      {ORDER.map((k) => <i key={k} className={on.has(k) ? "on" : ""} />)}
    </div>
  );
}

/** Hora local en código de tiempo (HH:MM:SS:FF a 25 fps). Escribe en el DOM sin volver a pintar React. */
function Clock() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    let raf = 0;
    let timer = 0;
    const tick = () => {
      const t = new Date();
      if (ref.current) {
        ref.current.textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}:${pad(Math.floor(t.getMilliseconds() / 40))}`;
      }
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      tick();
      timer = window.setInterval(tick, 1000);
    } else {
      const loop = () => { tick(); raf = requestAnimationFrame(loop); };
      loop();
    }
    return () => { cancelAnimationFrame(raf); window.clearInterval(timer); };
  }, []);
  return <span ref={ref} className="ca-clock" title="Hora local en código de tiempo (horas:minutos:segundos:fotogramas a 25 fps)">00:00:00:00</span>;
}

/** Barra superior: dónde estás, qué significa cada color y el reloj. */
export function TopBar({ path }: { path: string }) {
  let group = "";
  let label = "";
  for (const n of NAV) {
    if (n.group) group = n.group;
    if (n.path === path || n.also?.includes(path)) { label = n.label; break; }
  }
  if (!label) group = "";
  if (label === "Vídeos") group = "";
  return (
    <header className="ca-top">
      <div className="where">
        {group && <><span>{group}</span><span>/</span></>}
        <b>{label}</b>
      </div>
      <div className="ca-legend" aria-label="Qué significa cada color">
        <span><i style={{ background: "var(--yellow)" }} />IA</span>
        <span><i style={{ background: "var(--cyan)" }} />Modelo local</span>
        <span><i style={{ background: "var(--green)" }} />Render</span>
        <span><i style={{ background: "var(--magenta)" }} />Audio</span>
        <span><i style={{ background: "var(--red)" }} />Te necesita</span>
        <span><i style={{ background: "var(--blue)" }} />Cola</span>
      </div>
      <Clock />
    </header>
  );
}
