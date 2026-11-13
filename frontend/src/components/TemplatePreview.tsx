import { Player } from "@remotion/player";
import React from "react";
import { AbsoluteFill } from "remotion";
import { Captions, Hook } from "../remotion/Captions";
import type { CaptionStyle, CaptionWord } from "../remotion/schema";

const DEMO = "Nobody tells you this, but your salary is not your wealth.".split(" ");
const WORDS: CaptionWord[] = DEMO.map((w, i) => ({ w, s: 0.3 + i * 0.38, e: 0.3 + i * 0.38 + 0.32 }));
const DURATION = 0.3 + DEMO.length * 0.38 + 0.6;

const Demo: React.FC<{ style: CaptionStyle }> = ({ style }) => (
  <AbsoluteFill style={{ background: "linear-gradient(165deg, #3b4252 0%, #1b1d22 55%, #2c2416 100%)" }}>
    <Captions words={WORDS} style={style} />
    <Hook hook={{ text: "The money mistake" }} style={style} />
  </AbsoluteFill>
);

/** Vista previa en vivo de una plantilla: usa los mismos componentes que el render final. */
export default function TemplatePreview({ style, width = 270 }: { style: CaptionStyle; width?: number }) {
  return (
    <Player
      component={Demo}
      inputProps={{ style }}
      durationInFrames={Math.round(DURATION * 30)}
      fps={30}
      compositionWidth={1080}
      compositionHeight={1920}
      style={{ width, aspectRatio: "9 / 16", borderRadius: 14, overflow: "hidden" }}
      autoPlay
      loop
      acknowledgeRemotionLicense
    />
  );
}
