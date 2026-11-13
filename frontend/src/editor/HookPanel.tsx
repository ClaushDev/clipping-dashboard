import { hookProps } from "../remotion/Captions";
import { GOOGLE_FONTS, SYSTEM_FONTS } from "../remotion/fonts";
import type { Composition, Hook, HookAnim } from "../remotion/schema";

const ANIMS: { value: HookAnim; label: string }[] = [
  { value: "pop", label: "Aparece creciendo" },
  { value: "fade", label: "Fundido" },
  { value: "slide", label: "Baja desde arriba" },
  { value: "drop", label: "Aterriza (grande → normal)" },
  { value: "none", label: "Sin animación" },
];

/** Gancho en pantalla como una capa más: texto, posición, tamaño, fuente, colores, animación y tiempos. */
export default function HookPanel({ comp, duration, onChange }: { comp: Composition; duration: number; onChange: (c: Composition) => void }) {
  const style = comp.captions.style;
  const p = hookProps(comp.hook, style);
  const set = (patch: Partial<Hook>) => onChange({ ...comp, hook: { ...comp.hook, ...patch } });
  const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0));
  return (
    <div className="stack">
      <label className="field">
        Texto
        <textarea rows={2} value={comp.hook.text} maxLength={100} placeholder="Sin gancho" onChange={(e) => set({ text: e.target.value })} />
      </label>
      {!style.hook_enabled && comp.hook.text.trim() && (
        <div className="small muted">
          La plantilla de subtítulos tiene el gancho apagado.{" "}
          <button className="btn small" onClick={() => onChange({ ...comp, hook: comp.hook, captions: { ...comp.captions, style: { ...style, hook_enabled: true } } })}>
            Mostrarlo</button>
        </div>
      )}
      <div className="grid-2">
        <label className="field">
          Fuente
          <select value={p.font} onChange={(e) => set({ font: e.target.value })}>
            {[...GOOGLE_FONTS, ...SYSTEM_FONTS].map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label className="field">
          Grosor
          <select value={p.weight} onChange={(e) => set({ weight: Number(e.target.value) })}>
            {[400, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        <label className="field">Tamaño<input type="number" min={24} max={200} step={1} value={p.size} onChange={(e) => set({ size: num(e.target.value, 24, 200) })} /></label>
        <label className="field">
          Animación
          <select value={p.anim} onChange={(e) => set({ anim: e.target.value as HookAnim })}>
            {ANIMS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
        <label className="field">Color del texto<input type="color" value={p.color} onChange={(e) => set({ color: e.target.value })} /></label>
        <label className="field">
          Caja de fondo
          <span className="row" style={{ gap: 6 }}>
            <input type="color" value={p.bg || "#ffffff"} disabled={!p.bg} onChange={(e) => set({ bg: e.target.value })} />
            <label className="row small" style={{ gap: 4 }}>
              <input type="checkbox" checked={!!p.bg} onChange={(e) => set({ bg: e.target.checked ? style.hook_bg_color || "#ffffff" : "" })} /> Con caja
            </label>
          </span>
        </label>
        <label className="field">Horizontal (%)<input type="number" min={0} max={100} step={1} value={Math.round(p.x * 100)} onChange={(e) => set({ x: num(e.target.value, 0, 100) / 100 })} /></label>
        <label className="field">Vertical (%)<input type="number" min={0} max={95} step={1} value={Math.round(p.y * 100)} onChange={(e) => set({ y: num(e.target.value, 0, 95) / 100 })} /></label>
        <label className="field">Empieza (s)<input type="number" min={0} max={Math.max(0, duration - 0.5)} step={0.1} value={p.start} onChange={(e) => set({ start: num(e.target.value, 0, Math.max(0, duration - 0.5)) })} /></label>
        <label className="field">Dura (s)<input type="number" min={0.5} max={Math.max(0.5, duration)} step={0.1} value={p.duration} onChange={(e) => set({ duration: num(e.target.value, 0.5, Math.max(0.5, duration)) })} /></label>
      </div>
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={p.uppercase} onChange={(e) => set({ uppercase: e.target.checked })} /> En mayúsculas
      </label>
      <div className="small muted">Arrastra el gancho sobre la vista previa para moverlo. Los números también se arrastran: pulsa en su nombre y mueve a los lados.</div>
      <button className="btn small ghost" style={{ alignSelf: "start" }} onClick={() => onChange({ ...comp, hook: { text: comp.hook.text } })}>
        Volver al estilo de la plantilla</button>
    </div>
  );
}
