import { Desktop, Moon, SidebarSimple, Sun, type Icon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "./api";
import ActivityDock from "./components/ActivityDock";
import LlmNotice from "./components/LlmNotice";
import { Signal, TopBar } from "./components/Signal";
import { useHashRoute, usePoll } from "./hooks";
import { NAV } from "./nav";
import Ajustes from "./pages/Ajustes";
import Cola from "./pages/Cola";
import Editor from "./pages/Editor";
import EditorVideos from "./pages/EditorVideos";
import Exportar from "./pages/Exportar";
import Marcar from "./pages/Marcar";
import Nuevo from "./pages/Nuevo";
import Plantillas from "./pages/Plantillas";
import Sonidos from "./pages/Sonidos";
import Video from "./pages/Video";
import Videos from "./pages/Videos";
import { effectiveTheme, savedTheme, setTheme, type ThemeChoice, watchSystemTheme } from "./theme";

const THEMES: { value: ThemeChoice; label: string; icon: Icon }[] = [
  { value: "dark", label: "Oscuro", icon: Moon },
  { value: "light", label: "Claro", icon: Sun },
  { value: "system", label: "Auto", icon: Desktop },
];

function readRail(): boolean {
  try {
    return localStorage.getItem("cs-rail") === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const [path, query] = useHashRoute();
  const health = usePoll(api.health, 15000);
  const pending = usePoll(() => api.clips({ status: "review" }), 5000);
  const jobs = usePoll(api.jobQueue, 5000);
  const jobCount = (jobs.data?.running.length ?? 0) + (jobs.data?.queued.length ?? 0);
  const [theme, setThemeState] = useState<ThemeChoice>(savedTheme);
  const [railPref, setRailPref] = useState(readRail);
  const h = health.data;
  // El editor y el marcado necesitan todo el ancho: el menú se queda en iconos.
  const workspace = (path === "editor" && !!query.get("clip")) || path === "marcar";
  const rail = railPref || workspace;
  const wide = ["videos", "video", "editor", "exportar"].includes(path);

  useEffect(() => watchSystemTheme(theme), [theme]);

  // Atajo «N»: Nuevo vídeo (salvo escribiendo en un campo o en el editor, que tiene sus propios atajos)
  useEffect(() => {
    if (workspace) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key.toLowerCase() !== "n" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable) return;
      window.location.hash = "#/nuevo";
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspace]);

  // Cada página nueva empieza arriba (cambiar de pestaña dentro de una página no mueve el scroll).
  const pageKey = `${path}?${[...query].filter(([k]) => k !== "tab").map(([k, v]) => `${k}=${v}`).join("&")}`;
  useEffect(() => { window.scrollTo(0, 0); }, [pageKey]);

  const toggleRail = () => {
    const next = !railPref;
    setRailPref(next);
    try {
      localStorage.setItem("cs-rail", next ? "1" : "0");
    } catch {
      /* Sin almacenamiento */
    }
  };
  const pickTheme = (t: ThemeChoice) => {
    setTheme(t);
    setThemeState(t);
  };
  const reviewCount = pending.data?.length ?? 0;
  const known = NAV.some((n) => n.path === path || n.also?.includes(path));

  return (
    <div className={`app ${rail ? "rail" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <a href="#/videos" className="brand-card" aria-label="Clipping Studio, ir a Vídeos">
            <span className="b7"><i /><i /><i /><i /><i /><i /><i /></span>
            <span className="rev"><i /><i /><i /><i /><i /><i /><i /></span>
            <span className="pl"><i /><i /><i /><i /><i /></span>
          </a>
          <span className="brand-name">Clipping Studio</span>
          {!workspace && (
            <button className="rail-toggle" onClick={toggleRail} title={rail ? "Mostrar el menú" : "Plegar el menú"} aria-label="Plegar el menú">
              <SidebarSimple size={17} />
            </button>
          )}
        </div>
        <nav className="nav" aria-label="Menú">
          {NAV.map((n) => {
            const Ico = n.icon;
            const active = path === n.path || !!n.also?.includes(path);
            const count = n.path === "videos" ? reviewCount : n.path === "actividad" ? jobCount : 0;
            const kind = n.path === "videos" ? "need" : "q";
            return (
              <div key={n.path} className="nav-item" data-g={n.g ?? 0}>
                {n.group && <div className="nav-group">{n.group}</div>}
                <a href={`#/${n.path}`} className={active ? "active" : ""} title={rail ? n.label : undefined} aria-current={active ? "page" : undefined}>
                  <Ico size={18} weight={active ? "fill" : "regular"} />
                  <span className="label">{n.label}</span>
                  {n.path === "nuevo" && !rail && <kbd>N</kbd>}
                  {count > 0 && (
                    <>
                      <span className={`count ${kind}`}>{count}</span>
                      {rail && <span className={`rail-dot ${kind}`} aria-label={n.path === "videos" ? `${count} por revisar` : `${count} trabajos`} />}
                    </>
                  )}
                </a>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="status-list" aria-label="Estado del sistema">
            {health.error ? (
              <div><span className="dot" /> Backend sin conexión</div>
            ) : h ? (
              <>
                <div><span className={`dot ${h.ffmpeg && h.node ? "ok" : ""}`} /> Render{h.nvenc ? " + NVENC" : ""}</div>
                <div><span className={`dot ${h.claude_cli ? "ok" : ""}`} /> Claude Code</div>
                <div>
                  <span className={`dot ${h.ollama ? (h.ollama_model_ready ? "ok" : "warn") : ""}`} /> Ollama
                  {h.ollama && !h.ollama_model_ready ? " (sin modelo)" : ""}
                </div>
                <div title="Entorno opcional ml/: recortar el sujeto, seguir un punto y buscar objetos en el editor">
                  <span className={`dot ${h.ml ? "ok" : ""}`} /> IA visual{h.ml ? "" : " (opcional)"}
                </div>
              </>
            ) : null}
          </div>
          <div className="theme-switch" role="radiogroup" aria-label="Tema">
            {THEMES.map((t) => {
              const Ico = t.icon;
              return (
                <button key={t.value} className={theme === t.value ? "on" : ""} onClick={() => pickTheme(t.value)}
                  title={t.value === "system" ? "Como el sistema operativo" : `Modo ${t.label.toLowerCase()}`} role="radio" aria-checked={theme === t.value}>
                  <Ico size={14} /> {t.label}
                </button>
              );
            })}
          </div>
          <button className="theme-toggle" onClick={() => pickTheme(effectiveTheme(theme) === "dark" ? "light" : "dark")}
            title={effectiveTheme(theme) === "dark" ? "Pasar a modo claro" : "Pasar a modo oscuro"} aria-label="Cambiar tema">
            {effectiveTheme(theme) === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </aside>
      <LlmNotice />
      <Signal reviewCount={reviewCount} />
      <ActivityDock home={path === "videos"} />
      <main className={`main ${wide ? "wide" : ""} ${workspace ? "bleed" : ""}`} key={pageKey}>
        {!workspace && <TopBar path={path} />}
        {path === "videos" && <Videos />}
        {path === "nuevo" && <Nuevo />}
        {path === "video" && <Video key={query.get("id")} id={Number(query.get("id"))} />}
        {path === "marcar" && <Marcar key={query.get("source")} sourceId={Number(query.get("source"))} />}
        {path === "editor" && (query.get("clip") ? <Editor key={query.get("clip")} clipId={Number(query.get("clip"))} volver={query.get("volver") ?? ""} /> : <EditorVideos />)}
        {path === "exportar" && <Exportar key={query.get("source") ?? ""} sourceId={Number(query.get("source") ?? 0)} />}
        {path === "plantillas" && <Plantillas />}
        {path === "sonidos" && <Sonidos />}
        {(path === "cola" || path === "actividad") && <Cola />}
        {path === "ajustes" && <Ajustes key={query.get("tab") ?? ""} health={h} initialTab={query.get("tab") ?? ""} />}
        {!known && (
          <div className="card empty"><strong>Esta página no existe</strong><a href="#/videos">Volver a Vídeos</a></div>
        )}
      </main>
    </div>
  );
}
