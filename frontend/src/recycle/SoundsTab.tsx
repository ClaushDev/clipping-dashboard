import { PencilSimple, Play, Plus, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { StepTabs, useAsk } from "../project/StepKit";
import type { SfxFolder, SoundEffect } from "../types";
import SfxFindPanel from "./SfxFindPanel";

const SOURCE: Record<string, string> = { synth: "Generado aquí", own: "Propio", pack: "Tu galería", gen: "Hecho a medida" };

function sourceName(source: string) {
  if (SOURCE[source]) return SOURCE[source];
  if (source.startsWith("kenney:")) return "Kenney";
  if (source === "web:myinstants") return "Myinstants";
  if (source === "web") return "Web";
  return source.startsWith("import:") ? "Paquete importado" : source;
}

/** Chips para elegir intenciones (para qué sirve un sonido o una carpeta). */
function IntentChips({ all, value, onChange }: { all: Record<string, string>; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chips">
      {Object.entries(all).map(([k, l]) => (
        <button key={k} type="button" className={`chip ${value.includes(k) ? "on" : ""}`}
          onClick={() => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])}>{l}</button>
      ))}
    </div>
  );
}

/** Ajustes de una carpeta: nombre, intenciones por defecto y si la usa la IA. */
function FolderPanel({ folder, intents, onSave }: {
  folder: SfxFolder; intents: Record<string, string>; onSave: (p: { rename?: string; intents?: string[]; ai?: boolean }) => Promise<void>;
}) {
  const [name, setName] = useState(folder.category);
  const [chosen, setChosen] = useState(folder.intents);
  useEffect(() => {
    setName(folder.category);
    setChosen(folder.intents);
  }, [folder.category, folder.intents.join(",")]);
  const dirty = name.trim() !== folder.category || chosen.join(",") !== folder.intents.join(",");
  return (
    <div className="ca-make" style={{ gap: 8, padding: "12px 16px" }}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="field" style={{ flex: 1, minWidth: 200 }}>Carpeta
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="row small" style={{ gap: 6 }} title="Si está activada, la IA del editor puede elegir sonidos de esta carpeta">
          <input type="checkbox" checked={folder.ai} onChange={(e) => onSave({ ai: e.target.checked })} />
          La IA puede usar esta carpeta
        </label>
      </div>
      <div className="small">Intenciones de la carpeta <span className="muted">(para qué sirven sus sonidos; cada sonido puede tener las suyas)</span></div>
      <IntentChips all={intents} value={chosen} onChange={setChosen} />
      <div className="row">
        <button className="btn small primary" disabled={!dirty || !name.trim()}
          onClick={() => onSave({ rename: name.trim() !== folder.category ? name.trim() : undefined, intents: chosen })}>Guardar carpeta</button>
      </div>
    </div>
  );
}

/** Editar un sonido: nombre, carpeta e intenciones propias. */
function SoundEditor({ sound, intents, onSave, onReset, onCancel }: {
  sound: SoundEffect; intents: Record<string, string>;
  onSave: (p: { name: string; category: string; intents: string[] }) => void; onReset: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState(sound.name);
  const [category, setCategory] = useState(sound.category);
  const [chosen, setChosen] = useState(sound.intents);
  return (
    <div className="stack" style={{ gap: 6, width: "100%" }}>
      <div className="grid-3">
        <label className="field">Nombre
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">Carpeta <span className="hint">(escribe una nueva para crearla)</span>
          <input type="text" value={category} list="sfx-folders" onChange={(e) => setCategory(e.target.value)} />
        </label>
      </div>
      <div className="small">Intenciones</div>
      <IntentChips all={intents} value={chosen} onChange={setChosen} />
      <div className="row">
        <button className="btn small primary" disabled={!name.trim() || !category.trim()}
          onClick={() => onSave({ name: name.trim(), category: category.trim(), intents: chosen })}>Guardar</button>
        <button className="btn small ghost" onClick={onCancel}>Cancelar</button>
        {sound.edited && <button className="btn small ghost" onClick={onReset} title="Nombre, carpeta e intenciones originales">Volver al original</button>}
      </div>
    </div>
  );
}

type AddTab = "find" | "gallery" | "bundle" | "upload";

/** Librería de efectos de sonido: la librería, con sus carpetas, es la tarea principal; las formas de añadir sonidos
 * (pedir uno, tu galería, un paquete o un archivo) van en un panel con pestañas. */
export default function SoundsTab() {
  const lib = usePoll(api.sfx, 0);
  const [adding, setAdding] = useState<AddTab | null>(null);
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [upload, setUpload] = useState({ name: "", category: "Propios", license: "" });
  const [bundle, setBundle] = useState({ dir: "", category: "", license: "" });
  const [dir, setDir] = useState<string | null>(null);
  const [imported, setImported] = useState("");
  const [bundleMsg, setBundleMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const q = useAsk();
  useEffect(() => () => player.current?.pause(), []);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await fn();
      await lib.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  function play(url: string) {
    player.current?.pause();
    player.current = new Audio(url);
    player.current.play().catch(() => undefined);
  }

  const items = lib.data?.items ?? [];
  const folders = lib.data?.folders ?? [];
  const intents = lib.data?.intents ?? {};
  const needle = query.trim().toLowerCase();
  const shown = items.filter((s) => (!category || s.category === category) && (!needle || s.name.toLowerCase().includes(needle)));
  const gallery = lib.data?.gallery;
  const folder = dir ?? gallery?.dir ?? "";
  const current = folders.find((f) => f.category === category);
  const intentText = (s: SoundEffect) => s.intents.map((k) => intents[k] ?? k).join(", ");

  return (
    <>
      <section className="ca-sec" aria-label="Tus sonidos">
        <div className="ca-sec-head">
          <h2>Tus sonidos</h2><span className="ca-n">{items.length}</span>
          <button className="btn primary" style={{ marginLeft: "auto" }} aria-expanded={!!adding} onClick={() => setAdding(adding ? null : "find")}>
            <Plus size={15} /> Añadir sonidos</button>
        </div>

        {adding && (
          <section className="ca-make" aria-label="Añadir sonidos">
            <div className="ca-sec-head"><h2>Añadir sonidos</h2>
              <button className="btn small ghost more" onClick={() => setAdding(null)}>Cerrar</button></div>
            <StepTabs label="Formas de añadir sonidos" value={adding} onChange={setAdding} tabs={[
              { id: "find", label: "Pedir un sonido" },
              { id: "gallery", label: "Tu galería", count: gallery?.count || undefined },
              { id: "bundle", label: "Un paquete" }, { id: "upload", label: "Subir" },
            ]} />
            <div className="ca-tabpanel" role="tabpanel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {adding === "find" && <SfxFindPanel intents={intents} onPlay={play} onChange={() => lib.reload()} />}

              {adding === "gallery" && (
                <>
                  <span className="small muted">
                    Se copia a la carpeta del proyecto respetando tus carpetas. Con la galería importada, la IA del editor usa solo esta galería: whoosh en los cortes, riser justo antes de una revelación, drop o
                    impacto en el golpe y pops cuando aparece algo. Vuelve a importar cuando añadas o quites sonidos: tus
                    cambios de nombre, carpeta e intención se mantienen.
                  </span>
                  <div className="ca-tools">
                    <input type="text" value={folder} onChange={(e) => setDir(e.target.value)} aria-label="Carpeta de la galería" style={{ flex: 1, width: "auto" }} />
                    <button className="btn primary" disabled={!!busy || !folder.trim()} onClick={() => act("gallery", async () => {
                      const r = await api.importSfxGallery(folder.trim());
                      setImported(`${r.total} sonidos · ${r.added} nuevos, ${r.updated} actualizados, ${r.removed} quitados`
                        + (r.errors.length ? ` · ${r.errors.length} con error: ${r.errors.join("; ")}` : ""));
                    })}>{busy === "gallery" ? "Importando…" : gallery?.count ? "Volver a importar" : "Importar galería"}</button>
                  </div>
                  {imported && <div className="notice small">{imported}</div>}
                  {!!gallery?.count && <span className="small muted">Revisa la licencia de cada sonido de tu galería antes de usarlo en vídeos monetizados.</span>}
                </>
              )}

              {adding === "bundle" && (
                <>
                  <span className="small muted">
                    Por ejemplo los paquetes CC0 de <a href="https://kenney.nl/assets/category:Audio" target="_blank" rel="noreferrer">Kenney</a>
                    {" "}(uso libre en vídeos monetizados, sin atribución): descárgalos de su web y súbelos aquí. Los de Kenney se
                    reconocen solos por su License.txt; en el resto, la licencia es obligatoria. Sus subcarpetas pasan a ser carpetas.
                  </span>
                  <div className="grid-3">
                    <label className="field">Archivo .zip
                      <input ref={zipRef} type="file" accept=".zip,application/zip" />
                    </label>
                    <label className="field" style={{ gridColumn: "span 2" }}>…o la ruta de una carpeta de tu PC
                      <input type="text" value={bundle.dir} placeholder="C:\Users\…\Downloads\kenney_impact-sounds" onChange={(e) => setBundle({ ...bundle, dir: e.target.value })} />
                    </label>
                    <label className="field">Carpeta aquí <span className="hint">(opcional)</span>
                      <input type="text" value={bundle.category} placeholder="Del nombre del paquete" onChange={(e) => setBundle({ ...bundle, category: e.target.value })} />
                    </label>
                    <label className="field" style={{ gridColumn: "span 2" }}>Licencia <span className="hint">(no hace falta en los de Kenney)</span>
                      <input type="text" value={bundle.license} placeholder="CC0 · freesound.org/…" onChange={(e) => setBundle({ ...bundle, license: e.target.value })} />
                    </label>
                  </div>
                  <div className="ca-tools">
                    {bundleMsg && <span className="small">{bundleMsg}</span>}
                    <button className="btn primary push" disabled={!!busy} onClick={() => {
                      const file = zipRef.current?.files?.[0];
                      if (!file && !bundle.dir.trim()) return setError("Elige un .zip o escribe la ruta de una carpeta");
                      act("bundle", async () => {
                        const r = await api.importSfxBundle({ file, dir: file ? "" : bundle.dir.trim(), category: bundle.category.trim(), license: bundle.license.trim() });
                        setBundleMsg(`${r.added} sonidos nuevos en «${r.category}»${r.skipped ? ` · ${r.skipped} ya estaban` : ""} · ${r.license}`);
                        setBundle({ dir: "", category: "", license: "" });
                        if (zipRef.current) zipRef.current.value = "";
                      });
                    }}>{busy === "bundle" ? "Importando…" : "Importar"}</button>
                  </div>
                </>
              )}

              {adding === "upload" && (
                <>
                  <div className="grid-3">
                    <label className="field">Nombre
                      <input type="text" value={upload.name} onChange={(e) => setUpload({ ...upload, name: e.target.value })} placeholder="Golpe metálico" />
                    </label>
                    <label className="field">Carpeta
                      <input type="text" value={upload.category} list="sfx-folders" onChange={(e) => setUpload({ ...upload, category: e.target.value })} />
                    </label>
                    <label className="field">Licencia <span className="hint">(obligatoria)</span>
                      <input type="text" value={upload.license} onChange={(e) => setUpload({ ...upload, license: e.target.value })} placeholder="CC0 · freesound.org/s/12345" />
                    </label>
                  </div>
                  <div className="ca-tools">
                    <input ref={fileRef} type="file" accept="audio/*" />
                    <button className="btn primary push" disabled={!!busy || !upload.name.trim() || !upload.license.trim()}
                      onClick={() => {
                        const file = fileRef.current?.files?.[0];
                        if (!file) return setError("Elige un archivo de audio");
                        act("upload", async () => {
                          await api.uploadSfx(file, upload.name.trim(), upload.category.trim() || "Propios", upload.license.trim());
                          setUpload({ ...upload, name: "" });
                          if (fileRef.current) fileRef.current.value = "";
                        });
                      }}>{busy === "upload" ? "Subiendo…" : "Subir"}</button>
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        {error && <div className="notice error">{error}</div>}

        <div className="ca-tools" role="search">
          <input type="text" placeholder="Buscar por nombre…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar sonido" />
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Carpeta">
            <option value="">Todas las carpetas ({items.length})</option>
            {folders.map((f) => <option key={f.category} value={f.category}>{f.ai ? "✦ " : ""}{f.category} ({f.count})</option>)}
          </select>
          {shown.length !== items.length && <span className="small muted">{shown.length} de {items.length}</span>}
          <span className="small muted push">✦ = carpetas que puede usar la IA</span>
        </div>
        {current && (
          <FolderPanel folder={current} intents={intents}
            onSave={(p) => act("folder", async () => {
              const f = await api.editSfxFolder({ category: current.category, ...p });
              setCategory(f.category);
            })} />
        )}
        <div className="ca-lib">
          {shown.map((s) => {
            const asking = q.view(s.id);
            return (
              <div key={s.id} className={`ca-row ${editing === s.id ? "wide" : ""}`}>
                <button className="btn small ca-play" onClick={() => play(s.url)} aria-label={`Escuchar ${s.name}`} title="Escuchar">
                  <Play size={13} weight="fill" /></button>
                <span className="ca-row-what">
                  <b title={s.name}>{s.name}</b>
                  <small title={s.license}>{s.category} · {s.duration.toFixed(1)} s · {sourceName(s.source)}</small>
                  {s.intents.length > 0 && <small title="Intenciones">Para: {intentText(s)}</small>}
                </span>
                <span className="ca-lib-acts">
                  <button className="btn small ghost" title="Editar nombre, carpeta e intenciones" aria-label="Editar"
                    aria-expanded={editing === s.id} onClick={() => setEditing(editing === s.id ? "" : s.id)}><PencilSimple size={14} /></button>
                  {s.source !== "synth" && (
                    <button className="btn small ghost" disabled={!!busy} title="Borrar" aria-label="Borrar"
                      onClick={() => q.ask(s.id, [{ text: `¿Borrar «${s.name}»? Se borra su archivo.`, yes: "Borrar" }],
                        () => void act("del", () => api.deleteSfx(s.id)))}><X size={14} /></button>
                  )}
                </span>
                {asking && <div className="ca-row-edit">{asking}</div>}
                {editing === s.id && (
                  <div className="ca-row-edit">
                    <SoundEditor sound={s} intents={intents} onCancel={() => setEditing("")}
                      onSave={(p) => act("edit", async () => { await api.editSfx(s.id, p); setEditing(""); })}
                      onReset={() => act("edit", async () => { await api.editSfx(s.id, { reset: true }); setEditing(""); })} />
                  </div>
                )}
              </div>
            );
          })}
          {shown.length === 0 && <div className="ca-lib-none">{items.length ? "Nada con esos filtros." : "Aún no tienes sonidos: añade tu galería, un paquete o pide uno."}</div>}
        </div>
      </section>
      <datalist id="sfx-folders">{folders.map((f) => <option key={f.category} value={f.category} />)}</datalist>
    </>
  );
}
