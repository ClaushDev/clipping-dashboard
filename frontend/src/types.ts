import type { Aspect, Composition, WordAnimation } from "./remotion/schema";

export interface Health {
  ffmpeg: boolean;
  nvenc: boolean;
  node: boolean;
  claude_cli: boolean;
  ollama: boolean;
  ollama_models: string[];
  ollama_model_ready: boolean;
  /** Entorno opcional de IA visual (ml/): recortar sujeto, seguir un punto, buscar objetos. */
  ml?: boolean;
}

export interface Settings {
  llm_provider: "claude" | "ollama";
  claude_model: string;
  llm_task_models: Record<string, LlmRoute>;
  llm_task_effort: Record<string, LlmEffort>;
  llm_cache: boolean;
  llm_cache_days: number;
  ollama_url: string;
  ollama_model: string;
  ollama_vision_model: string;
  whisper_model: string;
  whisper_device: string;
  whisper_compute_type: string;
  language: string;
  encoder: string;
  render_speed: "fast" | "balanced" | "quality";
  master_export: string;
  source_max_height: number;
  clips_per_source: number;
  min_duration: number;
  max_duration: number;
  default_template_id: number | null;
  guidance: string;
  sfx_pack_dir: string;
  fx_auto: boolean;
  fx_speaker_zoom: boolean;
  fx_punch_in: boolean;
  fx_numbers: boolean;
  fx_stickers: boolean;
  fx_transitions: "none" | "some" | "many";
  fx_camera: boolean;
  cold_open: "auto" | "off";
  cold_open_transition: "flash" | "glitch" | "text";
  cold_open_mode: "repeat" | "trim";
}

export interface Template {
  id: number;
  name: string;
  font: string;
  font_size: number;
  font_weight: number;
  primary_color: string;
  highlight_color: string;
  highlight_mode: "color" | "box" | "underline";
  box_color: string;
  outline_color: string;
  outline_width: number;
  shadow: number;
  uppercase: boolean;
  words_per_chunk: number;
  margin_v: number;
  animation: WordAnimation;
  chunk_bg_color: string;
  chunk_bg_opacity: number;
  hook_enabled: boolean;
  hook_font_size: number;
  hook_text_color: string;
  hook_bg_color: string;
  hook_duration: number;
}

export type SourceLayout = "auto" | "face" | "center" | "duo" | "gaming" | "fit_black" | "fit_blur" | "fit_color";

export interface SourceOptions {
  permission_note: string;
  requested_clips: number;
  llm_provider: string;
  layout: SourceLayout;
  bg_color: string;
  aspect: Aspect;
  template_id: number | null;
  hook_enabled: boolean;
  min_duration: number;
  max_duration: number;
  instructions: string;
  caption_style?: Record<string, unknown>;
  selection: "auto" | "manual";
  typology?: string;
  /** Calidad de descarga: 0 = automática según la duración; 1080, 1440 o 2160 */
  max_height?: number;
}

export interface Source extends Omit<SourceOptions, "caption_style"> {
  id: number;
  url: string;
  title: string;
  status: string;
  progress: number;
  stage_detail: string;
  error: string;
  duration: number;
  /** Ruta de la transcripción ("" hasta que Whisper termina). */
  transcript_path?: string;
  language?: string;
  created_at: string;
  clip_counts: Record<string, number>;
  thumb_url?: string;
}

export interface Word {
  w: string;
  s: number;
  e: number;
}

export interface Clip {
  id: number;
  source_id: number;
  start: number;
  end: number;
  hook_start: number;
  hook_end: number;
  duration: number;
  aspect: string;
  title: string;
  hook: string;
  reason: string;
  score: number;
  tags: string[];
  template_id: number | null;
  resolved_mode: string;
  /** Queued, scoring, rendering, review, approved, rejected, error */
  status: string;
  origin: "ai" | "manual" | "rescued";
  /** Desglose de la nota (solo en los clips propuestos por la IA o rescatados). */
  breakdown?: ScoreBreakdown | null;
  progress: number;
  error: string;
  version: number;
  video_url: string;
  thumb_url: string;
  /** Tiene palabras de subtítulo (se pueden bajar como SRT/VTT). */
  has_captions?: boolean;
  /** Resumen de los filtros de calidad del último render (en el detalle, el informe completo). */
  quality: QualitySummary | null;
  created_at?: string;
}

export interface QualityIssue {
  level: "error" | "warn" | "info";
  code: string;
  text: string;
  fix: string;
  /** Segundo de la timeline al que se refiere (null = todo el vídeo). */
  at: number | null;
}

export interface QualityTargets { avg_shot: number | null; wpm: number | null; count: number; name: string }

export interface QualitySummary {
  score: number;
  verdict: "bien" | "revisar" | "problema";
  counts: { error: number; warn: number; info: number };
  version: number;
}

export interface QualityReport extends QualitySummary {
  issues: QualityIssue[];
  metrics: Record<string, number | null>;
  checked_at: string;
  /** False = solo se revisó la composición (aún sin MP4). */
  rendered: boolean;
  /** Tira de fotogramas del MP4. */
  sheet: string;
  targets: QualityTargets | null;
  /** Arranque en tres capas (backend/clipping/opening.py). */
  opening?: Opening;
}

export interface ClipDetail extends Omit<Clip, "quality"> {
  quality: QualityReport | null;
  composition: Composition | null;
  source: { id: number; title: string; duration: number; width: number; height: number; video_url: string } | null;
  source_words: Word[];
}

export interface ExportOptions {
  aspect: "" | Aspect;
  short_side: number;
  fps: number;
  codec: "h264" | "h265";
  crf: number;
  audio_bitrate: string;
  loudness: number;
  filename: string;
}

export interface ExportJob {
  id: number;
  clip_ids: string;
  options: string;
  status: string;
  progress: number;
  detail: string;
  error: string;
  path: string;
  created_at: string;
}

export interface Asset {
  name: string;
  kind: "image" | "audio" | "video";
  url: string;
}

export interface MarkingData {
  source: { id: number; title: string; duration: number; width: number; height: number; status: string;
    video_url: string };
  segments: { s: number; e: number; text: string }[];
  words: Word[];
  clips: { id: number; start: number; end: number; title: string; score: number; origin: string; status: string }[];
}

// ---------- Sonidos ----------

export interface SoundEffect {
  id: string;
  name: string;
  category: string;
  file: string;
  duration: number;
  license: string;
  source: string; // Synth, own, pack, kenney:<paquete>, import:<paquete>
  url: string;
  /** Para qué sirve: transicion, revelacion, impacto… (las de su carpeta si no tiene propias). */
  intents: string[];
  /** Nombre, carpeta o intenciones cambiados por ti. */
  edited?: boolean;
}

/** Carpeta de sonidos (su categoría), con sus intenciones por defecto y si la usa la IA. */
export interface SfxFolder {
  category: string;
  count: number;
  intents: string[];
  ai: boolean;
  use: string;
  sources: string[];
}

export interface SfxLibrary {
  items: SoundEffect[];
  folders: SfxFolder[];
  intents: Record<string, string>;
  gallery: SfxGallery;
}

export interface SfxFindResult {
  /** Library = ya estaba; synth = hecho aquí al momento; none = no hay */
  how: "library" | "synth" | "none";
  sound: (SoundEffect & { score?: number }) | null;
  candidates: (SoundEffect & { score: number })[];
}

export interface SfxBundleResult {
  added: number;
  skipped: number;
  category: string;
  license: string;
}

/** Tu galería de sonidos, importada a data/sfx/pack. */
export interface SfxGallery {
  dir: string;
  count: number;
  categories: { category: string; count: number; use: string }[];
}

export interface SfxImportResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
  errors: string[];
  gallery: SfxGallery;
}

// ---------- Agente del editor ----------

export interface AgentMessage {
  role: "user" | "assistant";
  text: string;
  changes?: string[];
}

export interface AgentReply {
  reply: string;
  composition: import("./remotion/schema").Composition | null;
  changes: string[];
}

// ---------- Línea de tiempo ----------

/** Miniaturas de un tramo del original en rejilla (para la línea de tiempo del editor). */
export interface Filmstrip {
  url: string;
  start: number;
  end: number;
  step: number;
  count: number;
  cols: number;
  tile_w: number;
  tile_h: number;
}

// ---------- Gancho ----------

export interface HookScore {
  text: string;
  properties: Record<"specificity" | "address" | "stakes" | "curiosity" | "brevity", number>;
  verdict: number;
  band: "strong" | "workable" | "weak";
  formula: string;
  formula_name: string;
  weakest: string;
  fix: string;
  lang?: "en" | "es";
}

// ---------- Engagement ----------

export interface OpeningIssue { layer: "spoken" | "text" | "visual"; level: "warn" | "info"; text: string; fix: string }

/** Los primeros segundos en tres capas: lo que se oye, lo que se lee y lo que se ve. */
export interface Opening {
  score: number;
  band: HookScore["band"];
  window: number;
  layers: {
    spoken: { score: number; text: string; start: number | null; hook: HookScore | null };
    text: { score: number; texts: string[] };
    visual: { score: number; first_change: number | null };
  };
  issues: OpeningIssue[];
}

export interface BlockVariable {
  id: string;
  type: "string" | "text" | "number" | "color" | "boolean" | "enum";
  label: string;
  description: string;
  default: string | number | boolean;
  css: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}

/** Bloque o componente del catálogo de HyperFrames. */
export interface BlockItem {
  name: string;
  type: "block" | "component";
  title: string;
  description: string;
  tags: string[];
  category: string;
  width: number;
  height: number;
  duration: number;
  poster: string;
  video: string;
  variables: BlockVariable[];
  editable: boolean;
  gpu: boolean;
  installed?: boolean;
  author: string;
  license: string;
  /** Solo después de descargarlo. */
  texts?: { i: number; text: string }[];
  colors?: { color: string; uses: number }[];
  images?: string[];
  warnings?: string[];
}

export interface BlockCatalog {
  status: { running: boolean; error: string; done: number; total: number };
  updated_at: string;
  source: string;
  items: BlockItem[];
  categories: { key: string; label: string; count: number }[];
}

/** "auto" | "ollama" | "default" | ID exacto de Claude ("claude-opus-5-5"…). */
export type LlmRoute = string;
export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmModel {
  id: string;
  label: string;
  price: [number, number]; // $ por millón de tokens (entrada, salida)
  effort: boolean; // Admite --effort
  why: string;
}

export interface LlmTask {
  id: string;
  label: string;
  tier: "cheap" | "mid" | "top" | "best";
  recommended: LlmRoute;
  recommended_model: string;
  recommended_effort: LlmEffort;
  why: string;
  route: LlmRoute;
  effort: LlmEffort | "";
  effective: [string, string, string]; // [proveedor, modelo, esfuerzo] con los ajustes guardados
}

export interface LlmInfo {
  provider: "claude" | "ollama";
  routes: LlmRoute[];
  models: LlmModel[];
  efforts: { id: LlmEffort; label: string; why: string }[];
  tasks: LlmTask[];
  ollama: { available: boolean; model: string; url: string };
  cache: { enabled: boolean; days: number; size: number };
}

export interface LlmUsage {
  days: number;
  total: number;
  cached: number;
  rows: { provider: string; task: string; label: string; calls: number; errors: number; seconds: number; tokens?: number }[];
  notes: { ts: string; task: string; note: string }[];
}

/** Rúbrica de punch (0-20 cada apartado). */
export type PunchKey = "hook" | "tension" | "emotion" | "standalone" | "quotable";

/** De dónde sale la nota de un momento. */
export interface ScoreBreakdown {
  /** Nota de la IA antes de sumar las señales. */
  ai: number;
  punch: Partial<Record<PunchKey, number>>;
  /** Señales sin IA: score 0-100, partes (audio 30, energía 20, giros 20, heatmap 30) y frases en español. */
  signals: { score?: number; parts?: Partial<Record<"audio" | "energy" | "turns" | "heat", number>>; notes?: string[] };
  /** "" = la IA · advocate = segunda pasada · signals = entra por sus señales · rescued = lo rescataste tú. */
  via: "" | "advocate" | "signals" | "rescued";
}

/** Un momento de la bolsa de descartados. */
export interface MomentCandidate {
  id: number;
  start: number;
  end: number;
  title: string;
  hook: string;
  reason: string;
  score: number;
  discard: string;
  breakdown: ScoreBreakdown;
  /** Clip que ya cubre este momento (0 = ninguno). */
  clip_id: number;
}


/** Tipos de clip y presets de encuadre de «Nuevo vídeo» (backend/clipping/clip_types.py). */
export interface ClipType { id: string; label: string; desc: string; presets: string[] }
export interface ClipPreset { id: string; label: string; desc: string; layout: SourceLayout; aspect: Aspect }
export interface ClipTypeCatalog { types: ClipType[]; presets: ClipPreset[] }
