import { DownloadSimple, Export, FolderOpen } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { PageHead, timeAgo } from "../components/ui";
import { usePoll } from "../hooks";
import { Adv, NoSignal } from "../project/StepKit";
import type { ExportOptions } from "../types";

const EXPORT_STATUS: Record<string, string> = { queued: "En cola", running: "Exportando", done: "Lista", error: "Error" };

/** Exportar: los clips aprobados, a la medida de cada plataforma, en un .zip con un metadata.csv. */
export default function Exportar({ sourceId }: { sourceId: number }) {
  const clips = usePoll(() => api.clips({ status: "approved", source_id: sourceId || undefined }), 0, [sourceId]);
  const sources = usePoll(api.sources, 0);
  const presets = usePoll(api.exportPresets, 0);
  const exports = usePoll(api.exports, 3000);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [preset, setPreset] = useState("youtube_shorts");
  const [opts, setOpts] = useState<ExportOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Por defecto van todos los aprobados
  useEffect(() => { if (clips.data) setPicked(new Set(clips.data.map((c) => c.id))); }, [clips.data]);
  useEffect(() => { const p = presets.data?.[preset]; if (p) setOpts({ ...p.options }); }, [presets.data, preset]);

  const list = clips.data ?? [];
  const sourceName = (id: number) => { const s = sources.data?.find((x) => x.id === id); return s ? s.title || s.url : `Vídeo ${id}`; };
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const set = <K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) => setOpts((o) => (o ? { ...o, [k]: v } : o));

  async function run() {
    if (!opts) return;
    setBusy(true);
    setError("");
    try {
      await api.createExport([...picked], opts);
      exports.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title="Exportar" back={sourceId ? { href: `#/video?id=${sourceId}`, label: sourceName(sourceId) } : undefined}
        subtitle="Los clips aprobados, renderizados a la medida de cada plataforma y empaquetados en un .zip con su metadata.csv." />

      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0 }} className="grow">Clips aprobados{sourceId ? " de este vídeo" : ""}</h2>
          {sourceId > 0 && <a className="btn small ghost" href="#/exportar">Ver los de todos los vídeos</a>}
        </div>
        {clips.data && list.length === 0 && <NoSignal title="No hay clips aprobados" text=" Apruébalos en la ficha de cada vídeo." />}
        {list.length > 0 && (
          <div className="ca-qrows">
            {list.map((c) => (
              <label key={c.id} className="ca-qrow" style={{ cursor: "pointer" }}>
                {c.thumb_url ? <img src={c.thumb_url} alt="" /> : <span className="noimg" />}
                <span>
                  <b>{c.title || `Clip ${c.id}`}</b>
                  <small>{c.duration.toFixed(0)} s · {c.aspect}{sourceId ? "" : ` · ${sourceName(c.source_id)}`}</small>
                </span>
                <span className="acts"><input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} /></span>
              </label>
            ))}
          </div>
        )}

        {opts && (
          <>
            <label className="field">
              Plataforma
              <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {Object.entries(presets.data ?? {}).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
              </select>
            </label>
            <Adv summary="Ajustes de la exportación" hint={`${opts.aspect || "formato del clip"} · ${opts.short_side}p · ${opts.fps} fps · ${opts.codec}`}>
              <div className="grid-3">
                <label className="field">Formato
                  <select value={opts.aspect} onChange={(e) => set("aspect", e.target.value as ExportOptions["aspect"])}>
                    <option value="">El del clip</option>
                    {["9:16", "1:1", "4:5", "16:9"].map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
                <label className="field">Resolución (lado corto)
                  <select value={opts.short_side} onChange={(e) => set("short_side", Number(e.target.value))}>
                    {[720, 1080, 1440, 2160].map((v) => <option key={v} value={v}>{v}p</option>)}
                  </select>
                </label>
                <label className="field">Fotogramas por segundo
                  <select value={opts.fps} onChange={(e) => set("fps", Number(e.target.value))}>
                    {[24, 25, 30, 50, 60].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
                <label className="field">Códec
                  <select value={opts.codec} onChange={(e) => set("codec", e.target.value as ExportOptions["codec"])}>
                    <option value="h264">H.264 (compatible con todo)</option>
                    <option value="h265">H.265 (ocupa menos)</option>
                  </select>
                </label>
                <label className="field">Calidad (CRF, menos = mejor)
                  <input type="number" min={12} max={35} value={opts.crf} onChange={(e) => set("crf", Number(e.target.value))} />
                </label>
                <label className="field">Volumen (LUFS, 0 = no normalizar)
                  <input type="number" min={-30} max={0} step={0.5} value={opts.loudness} onChange={(e) => set("loudness", Number(e.target.value))} />
                </label>
              </div>
              <label className="field">Nombre de los archivos
                <input type="text" value={opts.filename} onChange={(e) => set("filename", e.target.value)} />
                <span className="hint">{"{id}"} y {"{title}"} se cambian por los de cada clip.</span>
              </label>
            </Adv>
          </>
        )}
        {error && <div className="notice error">{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || !picked.size || !opts} onClick={run}>
            <Export size={15} /> {busy ? "Enviando…" : `Exportar ${picked.size} clip${picked.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Exportaciones</h2>
        {exports.data?.length === 0 && <div className="muted small">Aún no has exportado nada.</div>}
        {exports.data?.map((x) => {
          const n = (() => { try { return (JSON.parse(x.clip_ids) as number[]).length; } catch { return 0; } })();
          return (
            <div key={x.id} className="row" style={{ justifyContent: "space-between" }}>
              <span>
                <b>#{x.id}</b> · {n} clip{n === 1 ? "" : "s"} · {EXPORT_STATUS[x.status] ?? x.status}
                {x.status === "running" ? ` ${Math.round(x.progress * 100)} %` : ""} · <span className="muted">{timeAgo(x.created_at)}</span>
                {x.status === "error" && <span className="error-text"> {x.error}</span>}
              </span>
              {x.status === "done" && (
                <span className="row" style={{ gap: 6 }}>
                  <a className="btn small primary" href={api.exportDownloadUrl(x.id)} download><DownloadSimple size={14} /> Descargar .zip</a>
                  <button className="btn small" onClick={() => api.openExport(x.id).catch((e) => setError(String(e)))}><FolderOpen size={14} /> Abrir carpeta</button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
