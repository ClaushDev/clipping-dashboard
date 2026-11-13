import type { Composition, SourceCut, WordStyle } from "./remotion/schema";

/** Trabajo de la cola (página «Cola de trabajos»). */
export interface JobRow {
  id: number; kind: string; label: string; ref_id: number; title: string;
  status: "queued" | "running" | "done" | "error" | "cancelled"; error: string; link: string;
  progress: number; stage: string; created_at: string; started_at: string | null; finished_at: string | null;
  stopping: boolean;
}
export interface JobQueue { paused: boolean; running: JobRow[]; queued: JobRow[]; recent: JobRow[] }


/** Un paso en marcha (proceso local o llamada a la IA) con su modelo y tiempos. */
export interface LiveStep {
  id: number; job_id: number; kind: string; kind_label: string; label: string; model: string; detail: string; task: string;
  typical: number | null; limit: number | null; progress: number | null; started_at: string; elapsed: number;
}
/** Un paso ya terminado de un trabajo. */
export interface StepEvent {
  id: number; job_id: number; kind: string; kind_label: string; label: string; model: string; detail: string; task: string;
  ok: boolean; error: string; secs: number; tokens_in: number; tokens_out: number; started_at: string;
}
export interface ActivityJob extends JobRow {
  steps: StepEvent[]; current: LiveStep[]; typical: number | null; step_count: number; tokens: number;
}
/** Lo que ha corrido y corre para un vídeo (sus trabajos, con pasos y modelos). */
export interface VideoActivity {
  jobs: { id: number; kind: string; label: string; status: JobRow["status"]; error: string; created_at: string;
    started_at: string | null; finished_at: string | null }[];
  events: StepEvent[]; live: LiveStep[]; tokens: number; secs: number;
}
export interface Activity {
  paused: boolean; jobs: ActivityJob[]; queued: number; next: JobRow[]; direct: LiveStep[]; recent_direct: StepEvent[];
}

/** Idea general de un vídeo (la escribe la IA antes de buscar momentos; se puede corregir). */
export interface VideoBrief { topic: string; tone: string; audience: string; good_moment: string; avoid: string }
export interface BenchSummary {
  at: string; manual: number; found: number; proposed: number; recall: number | null; status: string; error?: string;
  /** Tus clips que no salieron arriba pero están en la bolsa de descartados, y el alcance total (arriba + bolsa). */
  in_pool?: number; reach?: number | null;
  /** La prueba anterior. */
  prev?: { at: string; manual: number; found: number; recall: number | null; in_pool?: number; reach?: number | null } | null;
}
export interface Benchmark extends BenchSummary {
  matches?: { manual: number; start: number; end: number; rank: number; overlap: number; in_pool?: boolean }[];
  /** Pruebas anteriores, para ver si la nota sube. */
  history?: { at: string; manual: number; found: number; recall: number | null; in_pool?: number; reach?: number | null }[];
  proposals?: { start: number; end: number; title: string; score: number; reason: string }[];
}
export interface SourceIdea {
  brief: VideoBrief | null; edited: boolean; at: string; duration: number;
  benchmark: Benchmark | null;
}
export interface MomentAccuracyRow {
  source_id: number; title: string; proposed: number; kept: number; discarded: number; pending: number;
  manual: number; missed: number; score_kept: number | null; score_discarded: number | null; has_brief: boolean;
  benchmark: BenchSummary | null;
}
export interface MomentAccuracy {
  proposed: number; kept: number; discarded: number; pending: number; manual: number; missed: number;
  hit_rate: number | null; score_kept: number | null; score_discarded: number | null; score_corr: number | null;
  bench_recall: number | null; bench_found: number; bench_manual: number;
  sources: MomentAccuracyRow[];
  candidates: { source_id: number; title: string; manual: number; duration: number; benchmark: BenchSummary | null }[];
}
import type {
  AgentMessage, AgentReply, Asset, BlockCatalog, BlockItem, Clip, ClipDetail, ClipTypeCatalog,
  ExportJob, ExportOptions, Filmstrip, Health, LlmInfo, LlmUsage, MarkingData, MomentCandidate,
  QualityReport, Settings, SfxBundleResult, SfxFindResult, SfxFolder, SfxImportResult, SfxLibrary, SoundEffect,
  Source, SourceOptions, Template,
} from "./types";
import type { HeatPoint } from "./components/heat";

/** Aviso de la IA para el dashboard: la respuesta salió de la caché (con «Regenerar») u Ollama falló y se usó Haiku. */
export interface LlmNotice {
  kind: "cached" | "note";
  text: string;
  regenerate?: () => Promise<unknown>;
}

type ReqInit = RequestInit & { json?: unknown; fresh?: boolean };

async function req<T>(path: string, init?: ReqInit): Promise<T> {
  const { json, fresh, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  if (fresh) headers.set("X-LLM-Fresh", "1"); // «Regenerar»: la IA no reutiliza la respuesta guardada
  const res = await fetch(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
      else if (Array.isArray(data.detail)) message = data.detail.map((d: { msg: string }) => d.msg).join("; ");
    } catch {
      /* Respuesta sin JSON */
    }
    throw new Error(message);
  }
  const note = res.headers.get("X-LLM-Note");
  if (note) notify({ kind: "note", text: decodeURIComponent(note) });
  if (res.headers.get("X-LLM-Cached") === "1") {
    notify({
      kind: "cached", text: "La IA ha reutilizado la respuesta de una petición idéntica (no ha gastado nada).",
      regenerate: () => req(path, { ...init, fresh: true }),
    });
  }
  return res.json() as Promise<T>;
}

function notify(n: LlmNotice) {
  window.dispatchEvent(new CustomEvent<LlmNotice>("llm-notice", { detail: n }));
}

export const api = {
  health: () => req<Health>("/api/health"),
  settings: () => req<Settings>("/api/settings"),
  clipTypes: () => req<ClipTypeCatalog>("/api/clip-types"),
  llmInfo: () => req<LlmInfo>("/api/llm"),
  llmUsage: (days = 7) => req<LlmUsage>(`/api/llm/usage?days=${days}`),
  clearLlmCache: () => req<{ removed: number }>("/api/llm/cache", { method: "DELETE" }),
  testLlmModel: (model: string) => req<{ model: string; ok: boolean; detail: string; secs: number }>("/api/llm/test", { method: "POST", json: { model } }),
  saveSettings: (s: Settings) => req<Settings>("/api/settings", { method: "PUT", json: s }),

  templates: () => req<Template[]>("/api/templates"),
  createTemplate: (t: Omit<Template, "id">) => req<Template>("/api/templates", { method: "POST", json: t }),
  updateTemplate: (id: number, t: Omit<Template, "id">) =>
    req<Template>(`/api/templates/${id}`, { method: "PUT", json: t }),
  deleteTemplate: (id: number) => req(`/api/templates/${id}`, { method: "DELETE" }),

  sources: () => req<Source[]>("/api/sources"),
  createSource: (body: SourceOptions & { url: string }) => req<Source>("/api/sources", { method: "POST", json: body }),
  uploadSource: (file: File, options: SourceOptions) => {
    const form = new FormData();
    form.append("file", file);
    form.append("options", JSON.stringify(options));
    return req<Source>("/api/sources/upload", { method: "POST", body: form });
  },
  retrySource: (id: number, fresh = false) => req(`/api/sources/${id}/retry`, { method: "POST", fresh }),
  sourceActivity: (id: number) => req<VideoActivity>(`/api/sources/${id}/activity`),
  deleteSource: (id: number) => req(`/api/sources/${id}`, { method: "DELETE" }),
  sourceIdea: (id: number) => req<SourceIdea>(`/api/moments/sources/${id}`),
  saveBrief: (id: number, brief: VideoBrief) => req<SourceIdea>(`/api/moments/sources/${id}/brief`, { method: "PUT", json: brief }),
  resetBrief: (id: number) => req<SourceIdea>(`/api/moments/sources/${id}/brief`, { method: "DELETE" }),
  momentAccuracy: () => req<MomentAccuracy>("/api/moments/accuracy"),
  startBenchmark: (id: number) => req(`/api/moments/sources/${id}/benchmark`, { method: "POST" }),
  momentCandidates: (id: number) => req<{ at: string | null; items: MomentCandidate[] }>(`/api/moments/sources/${id}/candidates`),
  rescueMoment: (id: number, cand: number) =>
    req<{ clip_id: number; already: boolean }>(`/api/moments/sources/${id}/candidates/${cand}/rescue`, { method: "POST" }),

  clips: (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return req<Clip[]>(`/api/clips?${q}`);
  },
  clip: (id: number) => req<ClipDetail>(`/api/clips/${id}`),
  patchClip: (id: number, body: { title?: string; status?: "review" | "approved" | "rejected" }) =>
    req<Clip>(`/api/clips/${id}`, { method: "PATCH", json: body }),
  saveComposition: (id: number, body: { composition: Composition; title?: string; hook?: string }) =>
    req(`/api/clips/${id}/composition`, { method: "PUT", json: body }),
  renderClip: (id: number, reset = false) => req(`/api/clips/${id}/render?reset=${reset}`, { method: "POST" }),
  autoframe: (id: number, src_in: number, src_out: number, mode: string, aspect: string, src = "") =>
    req<{ mode: string; keys: Composition["segments"][number]["keys"]; panels: Composition["segments"][number]["panels"] | null; note: string; face_ratio: number;
      source_cuts?: SourceCut[]; speakers?: number; how?: string;
      parts: { t0: number; t1: number; layout: "crop" | "split"; keys: Composition["segments"][number]["keys"]; panels?: Composition["segments"][number]["panels"]; note: string }[] | null }>(
      `/api/clips/${id}/autoframe`, { method: "POST", json: { src_in, src_out, mode, aspect, src } }),

  /** Sigue un punto (SAM 2.1) desde el segundo t del tramo; devuelve puntos clave de encuadre. */
  trackPoint: (id: number, p: { src_in: number; src_out: number; t: number; x: number; y: number; aspect: string; zoom: number; margin: number; smooth: number; src: string }) =>
    req<{ keys: Composition["segments"][number]["keys"]; lost: number; until: number }>(`/api/clips/${id}/track-point`, { method: "POST", json: p }),

  /** Voz limpia (RNNoise local) del archivo de un tramo. */
  enhanceVoice: (id: number, src: string, level: string) =>
    req<{ src: string; level: string }>(`/api/clips/${id}/enhance-voice`, { method: "POST", json: { src, level } }),

  matte: (id: number, composition: Composition, at: number, query: string) =>
    req<{ target: "segment" | "scene"; id: string; matte: { src: string; src_in: number }; partial: boolean }>(
      `/api/clips/${id}/matte`, { method: "POST", json: { composition, at, query } }),
  track: (id: number, body: { composition: Composition; start: number; end: number; mode: "face" | "point"; x: number; y: number }) =>
    req<{ follow: { t: number; x: number; y: number }[] }>(`/api/clips/${id}/track`, { method: "POST", json: body }),

  agent: (id: number, body: { composition: Composition; message: string; history: AgentMessage[]; playhead: number; selection: string }) =>
    req<AgentReply>(`/api/clips/${id}/agent`, { method: "POST", json: body }),

  sfx: () => req<SfxLibrary>("/api/sfx"),
  uploadSfx: (file: File, name: string, category: string, license: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("name", name);
    form.append("category", category);
    form.append("license", license);
    return req<SoundEffect>("/api/sfx", { method: "POST", body: form });
  },
  deleteSfx: (id: string) => req(`/api/sfx/${encodeURIComponent(id)}`, { method: "DELETE" }),
  importSfxBundle: (f: { file?: File; dir?: string; category: string; license: string }) => {
    const form = new FormData();
    if (f.file) form.append("file", f.file);
    form.append("dir", f.dir ?? "");
    form.append("category", f.category);
    form.append("license", f.license);
    return req<SfxBundleResult>("/api/sfx/import", { method: "POST", body: form });
  },
  editSfx: (id: string, patch: { name?: string; category?: string; intents?: string[]; reset?: boolean }) =>
    req<SoundEffect>(`/api/sfx/${encodeURIComponent(id)}`, { method: "PATCH", json: patch }),
  editSfxFolder: (patch: { category: string; rename?: string; intents?: string[]; ai?: boolean }) =>
    req<SfxFolder>("/api/sfx-folders", { method: "PATCH", json: patch }),
  importSfxGallery: (dir: string) => req<SfxImportResult>("/api/sfx/gallery", { method: "POST", json: { dir } }),

  assets: () => req<Asset[]>("/api/assets"),
  uploadAsset: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return req<Asset>("/api/assets", { method: "POST", body: form });
  },

  marking: (sourceId: number) => req<MarkingData>(`/api/sources/${sourceId}/transcript`),
  peaks: (sourceId: number) => req<{ step: number; peaks: number[]; heat?: HeatPoint[] }>(`/api/sources/${sourceId}/peaks`),
  filmstrip: (sourceId: number, start: number, end: number) =>
    req<Filmstrip>(`/api/sources/${sourceId}/filmstrip?start=${Math.floor(start)}&end=${Math.ceil(end)}`),
  createMarks: (sourceId: number, marks: { start: number; end: number; title: string }[], snap: boolean) =>
    req<{ clip_ids: number[] }>(`/api/sources/${sourceId}/marks`, { method: "POST", json: { marks, snap } }),

  sfxFind: (d: { request: string; intent?: string; duration?: number }) =>
    req<SfxFindResult>("/api/sfx/find", { method: "POST", json: d }),
  subtitlesUrl: (clipId: number, fmt: "srt" | "vtt") => `/api/clips/${clipId}/subtitles.${fmt}`,

  regenerateCaptions: (id: number, composition: Composition) =>
    req<{ words: Composition["captions"]["words"] }>(`/api/clips/${id}/captions/regenerate`, { method: "POST", json: { composition } }),
  jobQueue: () => req<JobQueue>("/api/jobs/queue"),
  activity: () => req<Activity>("/api/activity"),
  jobEvents: (id: number) => req<{ events: StepEvent[]; steps: number; tokens: number }>(`/api/jobs/${id}/events`),
  cancelJob: (id: number) => req<{ status: string }>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  moveJob: (id: number, to: "top" | "up" | "down" | "bottom") =>
    req<{ order: number[] }>(`/api/jobs/${id}/move`, { method: "POST", json: { to } }),
  pauseJobs: (paused: boolean) => req<{ paused: boolean }>("/api/jobs/pause", { method: "POST", json: { paused } }),
  punctuateCaptions: (id: number, composition: Composition) =>
    req<{ words: Composition["captions"]["words"]; changed: number }>(`/api/clips/${id}/captions/punctuate`, { method: "POST", json: { composition } }),
  wordPresets: () => req<{ name: string; style: WordStyle }[]>("/api/caption-word-presets"),
  saveWordPreset: (name: string, style: WordStyle) =>
    req<{ name: string; style: WordStyle }[]>("/api/caption-word-presets", { method: "POST", json: { name, style } }),
  deleteWordPreset: (name: string) =>
    req<{ name: string; style: WordStyle }[]>(`/api/caption-word-presets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  openExport: (id: number) => req(`/api/exports/${id}/open`, { method: "POST" }),
  exportPresets: () => req<Record<string, { label: string; options: ExportOptions }>>("/api/export-presets"),
  exports: () => req<ExportJob[]>("/api/exports"),
  createExport: (clip_ids: number[], options: ExportOptions) =>
    req<ExportJob>("/api/exports", { method: "POST", json: { clip_ids, options } }),
  exportDownloadUrl: (id: number) => `/api/exports/${id}/download`,
  deleteClip: (id: number) => req(`/api/clips/${id}`, { method: "DELETE" }),
  source: (id: number) => req<Source>(`/api/sources/${id}`),
  blockCatalog: () => req<BlockCatalog>("/api/blocks/catalog"),
  refreshBlockCatalog: () => req<{ ok: boolean }>("/api/blocks/catalog/refresh", { method: "POST" }),
  block: (name: string) => req<BlockItem>(`/api/blocks/${name}`),
  installBlock: (name: string) => req<BlockItem>(`/api/blocks/${name}/install`, { method: "POST" }),

  checkQuality: (clip_id: number) => req<QualityReport>(`/api/clips/${clip_id}/quality`, { method: "POST" }),
  autoFx: (composition: Composition) =>
    req<{ composition: Composition; summary: Record<string, number> }>("/api/fx/auto", { method: "POST", json: { composition } }),
  planQuality: (composition: Composition) =>
    req<QualityReport>("/api/quality/plan", { method: "POST", json: { composition } }),
};
