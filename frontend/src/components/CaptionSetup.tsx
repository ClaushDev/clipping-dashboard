import { Player } from "@remotion/player";
import React, { useEffect, useMemo } from "react";
import { AbsoluteFill, Img, useVideoConfig } from "remotion";
import { Captions, Hook } from "../remotion/Captions";
import { ASPECT_SIZE, type Aspect, type CaptionStyle, type CaptionWord, type Layout, videoBandBottom } from "../remotion/schema";
import type { SourceLayout, Template } from "../types";

/** Campos de estilo que se pueden ajustar al procesar (se guardan como cambios sobre la plantilla). */
export type CaptionOverrides = Pick<CaptionStyle, "placement" | "margin_v" | "font_size" | "words_per_chunk" | "uppercase" | "highlight_color">;

const DEMO = "Nobody tells you this, but your salary is not your wealth.".split(" ");
const WORDS: CaptionWord[] = DEMO.map((w, i) => ({ w, s: 0.3 + i * 0.38, e: 0.3 + i * 0.38 + 0.32 }));
const DURATION = 0.3 + DEMO.length * 0.38 + 0.6;
// Fotograma 16:9 de ejemplo (degradado con una silueta) para ver dónde caen los subtítulos.
const FAKE_FRAME = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1920 1080'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#5b7bb5'/><stop offset='1' stop-color='#2a3350'/></linearGradient></defs><rect width='1920' height='1080' fill='url(#g)'/><circle cx='960' cy='430' r='150' fill='#e8c9a8'/><rect x='720' y='600' width='480' height='480' rx='200' fill='#d9603b'/></svg>`,
)}`;

export function sourceLayoutToLayout(l: SourceLayout): Layout {
  if (l === "duo" || l === "gaming") return "split";
  return l === "auto" || l === "face" || l === "center" ? "crop" : l;
}

/** Fotograma de ejemplo con un patrón de "videojuego" para el panel de gameplay. */
const FAKE_GAME = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1920 1080'><rect width='1920' height='1080' fill='#2f5e39'/><g fill='#3f7a4a'>${Array.from({ length: 12 }, (_, i) => `<rect x='${i * 160}' y='${(i % 3) * 300 + 120}' width='120' height='120'/>`).join("")}</g><circle cx='960' cy='600' r='60' fill='#f5c518'/></svg>`,
)}`;

const SplitMock: React.FC<{ style: CaptionStyle; gaming: boolean; hook: boolean }> = ({ style, gaming, hook }) => {
  const { height } = useVideoConfig();
  const topH = gaming ? 0.4 : 0.5;
  const lineH = style.font_size * (height / 1920) * 1.18;
  const topPx = topH * height - lineH / 2 - 30 * (height / 1920);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: `${topH * 100}%`, overflow: "hidden" }}>
        <Img src={FAKE_FRAME} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: gaming ? "50% 35%" : "30% 40%" }} />
      </div>
      <div style={{ position: "absolute", top: `${topH * 100}%`, left: 0, right: 0, bottom: 0, overflow: "hidden", borderTop: "4px solid #000" }}>
        <Img src={gaming ? FAKE_GAME : FAKE_FRAME} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "70% 40%" }} />
      </div>
      <Captions words={WORDS} style={style} topPx={topPx} />
      {hook && <Hook hook={{ text: "The money mistake" }} style={style} />}
    </AbsoluteFill>
  );
};

const Mock: React.FC<{ style: CaptionStyle; layout: Layout; bg: string; hook: boolean; gaming: boolean }> = ({ style, layout, bg, hook, gaming }) => {
  if (layout === "split") return <SplitMock style={style} gaming={gaming} hook={hook} />;
  if (layout === "crop") {
    return (
      <AbsoluteFill style={{ backgroundColor: "black" }}>
        <Img src={FAKE_FRAME} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        <Captions words={WORDS} style={style} topPx={null} />
        {hook && <Hook hook={{ text: "The money mistake" }} style={style} />}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ backgroundColor: layout === "fit_color" ? bg : "black", overflow: "hidden" }}>
      {layout === "fit_blur" && (
        <Img src={FAKE_FRAME} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(40px) brightness(0.75)", transform: "scale(1.15)" }} />
      )}
      <Img src={FAKE_FRAME} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
      <BandCaptions style={style} layout={layout} />
      {hook && <Hook hook={{ text: "The money mistake" }} style={style} />}
    </AbsoluteFill>
  );
};

const BandCaptions: React.FC<{ style: CaptionStyle; layout: Layout }> = ({ style, layout }) => {
  const { width, height } = useVideoConfig();
  return <Captions words={WORDS} style={style} topPx={videoBandBottom(layout, 1920, 1080, width, height)} />;
};

interface Props {
  aspect: Aspect;
  layout: SourceLayout;
  bgColor: string;
  hookEnabled: boolean;
  template: Template | undefined;
  value: CaptionOverrides;
  onChange: (v: CaptionOverrides) => void;
}

/** Ajustes de subtítulos al procesar, con vista previa real (mismos componentes que el render). */
export default function CaptionSetup({ aspect, layout, bgColor, hookEnabled, template, value, onChange }: Props) {
  const [w, h] = ASPECT_SIZE[aspect];
  const lay = sourceLayoutToLayout(layout);
  const canGoBelow = lay === "split" || videoBandBottom(lay, 1920, 1080, w, h) !== null;

  // Al cambiar de plantilla, los ajustes parten de sus valores.
  useEffect(() => {
    if (!template) return;
    onChange({
      placement: canGoBelow ? "below_video" : "bottom",
      margin_v: template.margin_v, font_size: template.font_size, words_per_chunk: template.words_per_chunk,
      uppercase: template.uppercase, highlight_color: template.highlight_color,
    });
  }, [template?.id]); // Eslint-disable-line react-hooks/exhaustive-deps

  // Al cambiar a un encuadre con el vídeo completo, los subtítulos pasan debajo del vídeo; al recortar, a altura fija.
  useEffect(() => {
    const placement = canGoBelow ? "below_video" : "bottom";
    if (value.placement !== placement) onChange({ ...value, placement });
  }, [canGoBelow]); // Eslint-disable-line react-hooks/exhaustive-deps

  const style = useMemo<CaptionStyle | null>(() => {
    if (!template) return null;
    const { id: _id, name: _name, ...rest } = template;
    return { ...(rest as CaptionStyle), ...value, hook_enabled: hookEnabled };
  }, [template, value, hookEnabled]);

  const set = <K extends keyof CaptionOverrides>(k: K, v: CaptionOverrides[K]) => onChange({ ...value, [k]: v });
  if (!style) return null;
  const below = value.placement === "below_video" && canGoBelow;

  return (
    <div className="caption-setup">
      <div className="stack" style={{ flex: 1, minWidth: 260 }}>
        <label className="field">
          Posición
          <select value={below ? "below_video" : "bottom"} onChange={(e) => set("placement", e.target.value as CaptionOverrides["placement"])}>
            {canGoBelow && <option value="below_video">{lay === "split" ? "Sobre la línea de división (automático)" : "Debajo del vídeo (automático)"}</option>}
            <option value="bottom">Altura fija</option>
          </select>
        </label>
        {!below && (
          <label className="field">
            Altura desde abajo: {value.margin_v}px
            <input type="range" min={60} max={1500} step={10} value={value.margin_v} onChange={(e) => set("margin_v", Number(e.target.value))} />
          </label>
        )}
        <label className="field">
          Tamaño: {value.font_size}
          <input type="range" min={40} max={160} value={value.font_size} onChange={(e) => set("font_size", Number(e.target.value))} />
        </label>
        <div className="grid-2">
          <label className="field">
            Palabras por bloque
            <input type="number" min={1} max={8} value={value.words_per_chunk} onChange={(e) => set("words_per_chunk", Number(e.target.value))} />
          </label>
          <label className="field">
            Color resaltado
            <input type="color" value={value.highlight_color} onChange={(e) => set("highlight_color", e.target.value.toUpperCase())} />
          </label>
        </div>
        <label className="check"><input type="checkbox" checked={value.uppercase} onChange={(e) => set("uppercase", e.target.checked)} /> MAYÚSCULAS</label>
        <span className="hint">La vista previa usa un vídeo de ejemplo con tu formato y encuadre. Luego puedes afinar cada clip en el editor.</span>
      </div>
      <Player
        component={Mock}
        inputProps={{ style, layout: lay, bg: bgColor, hook: hookEnabled, gaming: layout === "gaming" }}
        durationInFrames={Math.round(DURATION * 30)}
        fps={30}
        compositionWidth={w}
        compositionHeight={h}
        style={{ width: aspect === "16:9" ? 360 : 220, aspectRatio: `${w} / ${h}`, borderRadius: 12, overflow: "hidden", flex: "none" }}
        autoPlay
        loop
        acknowledgeRemotionLicense
      />
    </div>
  );
}
