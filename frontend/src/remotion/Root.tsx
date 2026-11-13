import React from "react";
import { Composition as RemotionComposition } from "remotion";
import { Main } from "./Main";
import { canvasSize, type Composition, compositionDuration } from "./schema";
import { EMPTY_COMPOSITION } from "./defaults";

export const Root: React.FC = () => (
  <>
    <RemotionComposition
      id="Main"
      component={Main}
      defaultProps={{ composition: EMPTY_COMPOSITION as Composition }}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={30}
      calculateMetadata={({ props }) => {
        const c = props.composition;
        const [width, height] = canvasSize(c);
        return {
          width,
          height,
          fps: c.fps,
          durationInFrames: Math.max(1, Math.round(compositionDuration(c) * c.fps)),
        };
      }}
    />
  </>
);
