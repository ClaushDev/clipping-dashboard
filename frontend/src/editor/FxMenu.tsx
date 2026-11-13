/** Menú de efectos con vista previa al pasar el ratón. La vista previa usa CameraFx y FlashFx, los mismos
 *  componentes que el visor y el render, sobre dos planos de prueba con un corte en medio. */
import { Player } from "@remotion/player";
import React, { Fragment, useState } from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { CameraFx, FlashFx } from "../remotion/effects";
import { type Fx, type FxKind, TRANSITION_FX } from "../remotion/schema";
import { FX_GROUPS, FX_LABEL, newFx } from "./ops";

const FPS = 30;
const LEN = 2; // S; el corte en el segundo 1
const CAMERA_LEN = 1.6;

const Shot: React.FC<{ b?: boolean }> = ({ b }) => (
  <AbsoluteFill style={{
    background: b
      ? "repeating-linear-gradient(45deg, #2f6fd6 0 60px, #1f4f9f 60px 120px)"
      : "repeating-linear-gradient(-45deg, #e0a030 0 60px, #b77a14 60px 120px)",
    display: "flex", alignItems: "center", justifyContent: "center",
  }}>
    <div style={{ fontSize: 520, fontWeight: 800, color: "white", fontFamily: "system-ui, sans-serif", textShadow: "0 12px 40px rgba(0,0,0,.45)" }}>
      {b ? "B" : "A"}
    </div>
  </AbsoluteFill>
);

const Demo: React.FC<{ fx: Fx[]; cut: boolean }> = ({ fx, cut }) => (
  <AbsoluteFill style={{ backgroundColor: "black" }}>
    <CameraFx fx={fx}>
      {cut ? (
        <>
          <Sequence durationInFrames={LEN * FPS / 2}><Shot /></Sequence>
          <Sequence from={LEN * FPS / 2}><Shot b /></Sequence>
        </>
      ) : <Shot />}
    </CameraFx>
    <FlashFx fx={fx} />
  </AbsoluteFill>
);

export function FxPreview({ kind, width = 120 }: { kind: FxKind; width?: number }) {
  const trans = TRANSITION_FX.includes(kind);
  const f = newFx(kind, trans ? LEN / 2 : 0.2, trans ? LEN : CAMERA_LEN);
  // Los efectos de cámara largos se acortan para que se vea entero en la vista previa.
  const fx = trans ? f : { ...f, end: Math.min(f.end, CAMERA_LEN - 0.1) };
  return (
    <Player component={Demo} inputProps={{ fx: [fx], cut: trans }} durationInFrames={Math.round((trans ? LEN : CAMERA_LEN) * FPS)} fps={FPS}
      compositionWidth={1080} compositionHeight={1920} style={{ width, aspectRatio: "9 / 16", borderRadius: 8, overflow: "hidden" }}
      autoPlay loop acknowledgeRemotionLicense />
  );
}

interface Props {
  onPick: (k: FxKind) => void;
  /** Texto extra junto al título de cada grupo. */
  groupNote?: (group: string) => string;
  /** Más opciones al final del menú (p. ej. los presets). */
  extra?: React.ReactNode;
  style?: React.CSSProperties;
}

export default function FxMenu({ onPick, groupNote, extra, style }: Props) {
  const [hover, setHover] = useState<{ kind: FxKind; top: number } | null>(null);
  return (
    <div className="menu fx-menu" onPointerDown={(e) => e.stopPropagation()} style={style} onMouseLeave={() => setHover(null)}>
      {FX_GROUPS.map(([group, kinds]) => (
        <Fragment key={group}>
          <div className="menu-label">{group}{groupNote?.(group) ?? ""}</div>
          {kinds.map((k) => (
            <button key={k} onClick={() => onPick(k)}
              onMouseEnter={(e) => setHover({ kind: k, top: (e.currentTarget as HTMLElement).offsetTop })}
              onFocus={(e) => setHover({ kind: k, top: (e.currentTarget as HTMLElement).offsetTop })}>
              {FX_LABEL[k]}
            </button>
          ))}
        </Fragment>
      ))}
      {extra}
      {hover && (
        <div className="fx-preview" style={{ top: Math.max(0, hover.top - 80) }} aria-hidden>
          <FxPreview key={hover.kind} kind={hover.kind} />
          <span>{FX_LABEL[hover.kind]}</span>
        </div>
      )}
    </div>
  );
}
