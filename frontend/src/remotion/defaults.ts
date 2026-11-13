import type { CaptionStyle, Composition } from "./schema";

export const DEFAULT_STYLE: CaptionStyle = {
  font: "Montserrat",
  font_size: 86,
  font_weight: 900,
  primary_color: "#FFFFFF",
  highlight_color: "#FFD400",
  highlight_mode: "color",
  box_color: "#7C3AED",
  outline_color: "#000000",
  outline_width: 6,
  shadow: 3,
  uppercase: true,
  words_per_chunk: 3,
  margin_v: 560,
  animation: "pop",
  hook_enabled: true,
  hook_font_size: 64,
  hook_text_color: "#000000",
  hook_bg_color: "#FFFFFF",
  hook_duration: 3,
};

export const EMPTY_COMPOSITION: Composition = {
  version: 1,
  aspect: "9:16",
  fps: 30,
  segments: [],
  scenes: [],
  captions: { enabled: true, time_base: "timeline", style: DEFAULT_STYLE, words: [] },
  hook: { text: "" },
  overlays: [],
  audio: [],
};
