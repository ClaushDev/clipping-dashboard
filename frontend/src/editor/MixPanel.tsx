import { useMemo } from "react";
import {
  audioBus, busGain, type Composition, duckFactor, type Mix, MIX_BUSES, type MixBus, speechSpans, timelineWords,
} from "../remotion/schema";

const BUS_LABEL: Record<MixBus, string> = {
  original: "Vídeo original",
  voice: "Voz en off",
  music: "Música",
  sfx: "Efectos de sonido",
  clips: "Clips V2+",
};

const DUCK_DEFAULT = { level: 0.3, attack: 0.3, release: 0.5 };

interface Props {
  comp: Composition;
  duration: number;
  playhead: number;
  onChange: (c: Composition) => void;
}

const db = (g: number) => (g <= 0.001 ? "−∞ dB" : Math.abs(g - 1) < 0.005 ? "0 dB" : `${g > 1 ? "+" : ""}${(20 * Math.log10(g)).toFixed(1)} dB`);

/** Mezcla: volumen por grupo, silenciar y solo, y ducking automático de la música bajo la voz. */
export default function MixPanel({ comp, duration, playhead, onChange }: Props) {
  const mix: Mix = comp.mix ?? {};
  const set = (patch: Partial<Mix>) => onChange({ ...comp, mix: { ...mix, ...patch } });
  const present = new Set<MixBus>([
    ...(comp.segments.length ? ["original" as const] : []),
    ...comp.audio.map(audioBus),
    ...(comp.overlays.some((o) => o.kind === "video" && o.volume > 0) ? ["clips" as const] : []),
  ]);
  const speech = useMemo(() => speechSpans(timelineWords(comp)), [comp]);
  const toggle = (key: "mute" | "solo", bus: MixBus) => {
    const list = mix[key] ?? [];
    set({ [key]: list.includes(bus) ? list.filter((b) => b !== bus) : [...list, bus] });
  };
  const duck = mix.duck;
  const hasVoice = present.has("voice");

  // Curva del ducking a lo largo del vídeo (para ver dónde baja la música).
  const curve = useMemo(() => {
    if (!duck || duration <= 0) return "";
    const n = 240;
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = (i / n) * duration;
      return `${(i / n) * 100},${(1 - duckFactor(speech, t, duck.level, duck.attack, duck.release)) * 26 + 2}`;
    }).join(" ");
  }, [duck, speech, duration]);

  return (
    <div className="stack">
      <div className="small muted">
        Volumen de cada grupo de sonido sobre el de cada pista. «S» deja sonar solo los grupos marcados (para escuchar uno
        aislado); se oye igual en la vista previa y en el vídeo exportado.
      </div>
      <div className="mix-list">
        {MIX_BUSES.filter((b) => present.has(b)).map((b) => {
          const g = mix.gain?.[b] ?? 1;
          const live = busGain(mix, b) > 0;
          return (
            <div key={b} className={`mix-row${live ? "" : " off"}`}>
              <span className="mix-name">{BUS_LABEL[b]}</span>
              <input type="range" min={0} max={2} step={0.01} value={g} aria-label={`Volumen de ${BUS_LABEL[b]}`}
                onChange={(e) => set({ gain: { ...mix.gain, [b]: Number(e.target.value) } })}
                onDoubleClick={() => set({ gain: { ...mix.gain, [b]: 1 } })} title="Doble clic: 0 dB" />
              <span className="mix-db small">{db(g)}</span>
              <button className={`btn small mix-toggle${mix.mute?.includes(b) ? " on" : ""}`} title="Silenciar" aria-pressed={!!mix.mute?.includes(b)}
                onClick={() => toggle("mute", b)}>M</button>
              <button className={`btn small mix-toggle${mix.solo?.includes(b) ? " on" : ""}`} title="Solo" aria-pressed={!!mix.solo?.includes(b)}
                onClick={() => toggle("solo", b)}>S</button>
            </div>
          );
        })}
        <div className="mix-row master">
          <span className="mix-name">General</span>
          <input type="range" min={0} max={2} step={0.01} value={mix.master ?? 1} aria-label="Volumen general"
            onChange={(e) => set({ master: Number(e.target.value) })} onDoubleClick={() => set({ master: 1 })} title="Doble clic: 0 dB" />
          <span className="mix-db small">{db(mix.master ?? 1)}</span>
          <span />
          <span />
        </div>
      </div>

      <div className="card inset stack">
        <label className="row">
          <input type="checkbox" checked={!!duck} onChange={(e) => set({ duck: e.target.checked ? DUCK_DEFAULT : undefined })} />
          <strong>Ducking automático</strong>
          <span className="small muted grow">la música baja sola mientras se habla</span>
        </label>
        {duck && (
          <>
            <div className="grid-2">
              <label className="field">
                Baja hasta: {Math.round(duck.level * 100)} % ({db(duck.level)})
                <input type="range" min={0.05} max={0.8} step={0.05} value={duck.level} onChange={(e) => set({ duck: { ...duck, level: Number(e.target.value) } })} />
              </label>
              <label className="field">
                Baja en: {duck.attack.toFixed(2)} s
                <input type="range" min={0.05} max={1} step={0.05} value={duck.attack} onChange={(e) => set({ duck: { ...duck, attack: Number(e.target.value) } })} />
              </label>
              <label className="field">
                Vuelve en: {duck.release.toFixed(2)} s
                <input type="range" min={0.1} max={2} step={0.1} value={duck.release} onChange={(e) => set({ duck: { ...duck, release: Number(e.target.value) } })} />
              </label>
            </div>
            {hasVoice && present.has("original") && (
              <label className="row small">
                <input type="checkbox" checked={!!duck.original} onChange={(e) => set({ duck: { ...duck, original: e.target.checked } })} />
                Bajar también el sonido del vídeo original bajo la voz en off
              </label>
            )}
            {speech.length ? (
              <svg className="duck-curve" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Dónde baja la música">
                {speech.map(([s, e], i) => (
                  <rect key={i} x={(s / duration) * 100} y={0} width={Math.max(0.3, ((e - s) / duration) * 100)} height={30} className="duck-speech" />
                ))}
                <polyline points={curve} className="duck-line" />
                <line x1={(playhead / duration) * 100} x2={(playhead / duration) * 100} y1={0} y2={30} className="duck-head" />
              </svg>
            ) : (
              <div className="small muted">No hay subtítulos: el ducking sigue a las palabras transcritas, así que ahora no baja nada.</div>
            )}
            <div className="small muted">
              Afecta a la música y a los clips de V2+ con sonido. Una pista con su propio «Bajar bajo la voz» (en Capas) usa
              el suyo.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
