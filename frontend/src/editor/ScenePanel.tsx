import type { Composition, KenBurns, Scene } from "../remotion/schema";

interface Props {
  comp: Composition;
  playhead: number;
  onChange: (c: Composition) => void;
}

type Preset = "in" | "out" | "left" | "right" | "up" | "down" | "still";

const PRESET_LABEL: Record<Preset, string> = {
  in: "Acercarse", out: "Alejarse", left: "Paneo a la izquierda", right: "Paneo a la derecha", up: "Subir", down: "Bajar",
  still: "Casi quieta",
};

/** Movimiento de un preset con intensidad `k` (0.05-0.4), conservando suavizado y cámara en mano. */
function presetMotion(p: Preset, k: number, keep: Pick<KenBurns, "ease" | "drift">): KenBurns {
  const z = 1 + k;
  const d = Math.min(0.3, k * 1.5);
  const m: Record<Preset, KenBurns> = {
    in: { from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.5, y: 0.5, zoom: z } },
    out: { from: { x: 0.5, y: 0.5, zoom: z }, to: { x: 0.5, y: 0.5, zoom: 1 } },
    left: { from: { x: 0.5 + d, y: 0.5, zoom: z }, to: { x: 0.5 - d, y: 0.5, zoom: z } },
    right: { from: { x: 0.5 - d, y: 0.5, zoom: z }, to: { x: 0.5 + d, y: 0.5, zoom: z } },
    up: { from: { x: 0.5, y: 0.5 + d, zoom: z }, to: { x: 0.5, y: 0.5 - d, zoom: z } },
    down: { from: { x: 0.5, y: 0.5 - d, zoom: z }, to: { x: 0.5, y: 0.5 + d, zoom: z } },
    still: { from: { x: 0.5, y: 0.5, zoom: 1.04 }, to: { x: 0.5, y: 0.5, zoom: 1.04 + k / 5 } },
  };
  return { ...m[p], ...keep };
}

function guess(m: KenBurns): { preset: Preset; k: number } {
  const dz = m.to.zoom - m.from.zoom;
  const dx = m.to.x - m.from.x;
  const dy = m.to.y - m.from.y;
  if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) {
    const k = Math.max(m.from.zoom, m.to.zoom) - 1;
    if (Math.abs(dx) >= Math.abs(dy)) return { preset: dx < 0 ? "left" : "right", k };
    return { preset: dy < 0 ? "up" : "down", k };
  }
  if (Math.abs(dz) < 0.03) return { preset: "still", k: Math.abs(dz) * 5 };
  return { preset: dz > 0 ? "in" : "out", k: Math.abs(dz) };
}

const DEFAULT: KenBurns = { from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.5, y: 0.5, zoom: 1.12 } };

/** Cámara de la escena bajo el cursor (vídeos hechos de escenas): Ken Burns, paneos, suavizado, cámara en mano y entrada. */
export default function ScenePanel({ comp, playhead, onChange }: Props) {
  const scene = [...comp.scenes].reverse().find((s) => playhead >= s.start - 1e-3) ?? comp.scenes[0];
  if (!scene) return null;
  const setScene = (patch: Partial<Scene>) =>
    onChange({ ...comp, scenes: comp.scenes.map((s) => (s.id === scene.id ? { ...s, ...patch } : s)) });

  if (scene.kind === "graphic") {
    return (
      <div className="small muted">
        La escena {scene.id} es un gráfico animado ({scene.graphic?.component}): ya se mueve sola. Para añadir zooms,
        paneos o transiciones encima usa «+ Efecto…» en Capas.
      </div>
    );
  }
  const m = scene.motion ?? DEFAULT;
  const { preset, k } = guess(m);
  const keep = { ease: m.ease, drift: m.drift };
  const setMotion = (motion: KenBurns) => setScene({ motion });

  return (
    <div className="card inset stack">
      <div className="small muted">
        Escena <b>{scene.id}</b> · {scene.start.toFixed(1)}-{(scene.start + scene.duration).toFixed(1)} s ·
        {scene.kind === "video" ? " vídeo" : " imagen fija"}. Mueve el cursor para editar otra.
      </div>
      <label className="field">
        Movimiento de cámara
        <select value={preset} onChange={(e) => setMotion(presetMotion(e.target.value as Preset, Math.max(0.08, k), keep))}>
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
        </select>
      </label>
      <label className="field">
        Intensidad: {Math.round(k * 100)} %
        <input type="range" min={0.04} max={0.4} step={0.01} value={Math.min(0.4, Math.max(0.04, k))}
          onChange={(e) => setMotion(presetMotion(preset, Number(e.target.value), keep))} />
      </label>
      <label className="field">
        Cámara en mano: {Math.round((m.drift ?? 0) * 100)} %
        <input type="range" min={0} max={1} step={0.05} value={m.drift ?? 0} onChange={(e) => setMotion({ ...m, drift: Number(e.target.value) })} />
      </label>
      <div className="grid-2">
        <label className="field">
          Ritmo
          <select value={m.ease ?? "linear"} onChange={(e) => setMotion({ ...m, ease: e.target.value as KenBurns["ease"] })}>
            <option value="linear">Constante</option>
            <option value="smooth">Arranca y frena suave</option>
          </select>
        </label>
        <label className="field">
          Entrada de la escena
          <select value={scene.transition} onChange={(e) => setScene({ transition: e.target.value as Scene["transition"] })}>
            <option value="cut">Corte</option>
            <option value="fade">Fundido</option>
          </select>
        </label>
      </div>
      <div className="row">
        <button className="btn small" title="Copia el ritmo y la cámara en mano (no el movimiento) a todas las escenas"
          onClick={() => onChange({ ...comp, scenes: comp.scenes.map((s) => (s.kind === "graphic" ? s : { ...s, motion: { ...(s.motion ?? DEFAULT), ...keep } })) })}>
          Ritmo y cámara en mano a todas
        </button>
      </div>
      <div className="small muted">Las transiciones con estilo (barrido, zoom, destello, glitch) están en «+ Efecto…» → Transiciones.</div>
    </div>
  );
}
