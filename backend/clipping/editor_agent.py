"""Chat agéntico del editor: el usuario pide cambios en lenguaje natural («pon un círculo sobre la pelota cuando dice
"ball" y un whoosh») y la IA responde con acciones sobre la composición. Algunas acciones son consultas (localizar un
objeto, ver un fotograma) cuyo resultado vuelve a la IA en la siguiente vuelta; el resto edita la composición.

La composición nunca se guarda aquí: se devuelve al editor, que la mete en su historial (deshacer funciona igual).
"""
from __future__ import annotations

import copy
import json
import logging
import re
import uuid
from pathlib import Path
from urllib.parse import unquote

from sqlmodel import Session

from . import fxauto
from .config import DATA_DIR, load_settings
from . import sfx
from .db import Source, engine
from .frames import extract_frame, locate, source_to_canvas
from .llm import get_provider
from .pipeline import compose

log = logging.getLogger("clipping.agent")
MAX_TURNS = 4
WORK_DIR = DATA_DIR / "agent"

# Plantillas animadas que la IA puede poner como capa (frontend/src/remotion/templates.tsx, TEMPLATE_SPECS)
GRAPHIC_SPECS = {
    "checklist": '{"title": str, "items": [str, ...] (2-6), "tally": bool (counter 3/5)}',
    "headline_storm": '{"title": str (final verdict, 2-5 words), "headlines": [{"source": str, "text": str}, ...] (3-7)}',
    "growth_curve": ('{"title": str, "points": [number, ...] (3-12, in order), "prefix": str, "suffix": str, '
                     '"start_label": str, "end_label": str}'),
    "chat": '{"name": str (contact), "messages": [{"from": "me"|"them", "text": str}, ...] (2-8, short)}',
    "phone": '{"user": str (@handle), "text": str (post text), "likes": number}',
    "magazine": ('{"masthead": str (1 word), "headline": str, "lines": [str, ...] (2-4 cover lines), "issue": str}'),
    "liquid_glass": '{"icon": str (one emoji), "title": str, "text": str}',
}
TEMPLATES = tuple(GRAPHIC_SPECS)

PROMPT = """You are the video editor assistant inside a short-form video editor. The user (who writes in Spanish) asks for
changes to the current video; you apply them by returning actions. Reply to the user in SPANISH, briefly (1-2
sentences), saying what you changed or asking ONE question if the request is ambiguous. On-screen text, captions and
titles stay in ENGLISH unless the user says otherwise.

VIDEO (times in seconds on the final timeline; x, y, w, h are 0-1 fractions of the {cw}x{ch} canvas):
{summary}

CAPTION WORDS (index:word@time):
{words}

PLAYHEAD: {playhead:.2f}s   SELECTED: {selection}

SOUNDS (grouped by category, with what each category is for; id: name (seconds)). Prefer these:
{sounds}
If none of them fits what the moment needs (a specific object or action: glass breaking, a door creaking, a crowd
gasp…), ask for it with "want" instead of "sound": it is searched in the whole library (simple ones are made locally).

ACTIONS (return any number, applied in order):
- {{"do": "add_text", "text": "", "start": 0, "end": 0, "x": 0.5, "y": 0.2, "size": 90, "color": "#FFFFFF", "bg": "",
   "anim": "pop", "loop": "none", "rot": 0}}
   anim (entry): pop|bounce|drop|zoom|spin|slide|slide_left|slide_right|fade|count (numbers in the text count up from 0)|type
   (typewriter)|none · loop (while visible): none|float|pulse|wiggle|spin · rot: fixed tilt in degrees
- {{"do": "add_sticker", "emoji": "🔥", "start": 0, "end": 0, "x": 0.78, "y": 0.3, "size": 170}}  (pops in and floats)
- {{"do": "add_shape", "shape": "circle|box|arrow|underline", "start": 0, "end": 0, "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.15,
   "rotation": 45, "color": "#FF2D2D"}}  (arrow: x,y = the TIP, rotation = direction it points, 0 right, 90 down; w = length)
- {{"do": "add_wait_bar", "text": "WAIT FOR IT...", "start": 0, "end": 0}}
- {{"do": "add_template", "template": "<name>", "start": 0, "end": 0, "props": {{...}}, "w": 1, "x": 0.5, "y": 0.5}}
   animated template over the video (w 1 = full screen, 0.6 = a card). Templates and their props:
{templates}
- {{"do": "add_fx", "kind": "<kind>", "start": 0, "end": 0, "x": 0.5, "y": 0.5, "amount": 0.3, "dir": "left"}}
   camera: punch (sudden zoom that holds) | zoom (slow push-in) | pan (slow sweep toward dir) | drift (handheld float) | shake
   transitions, centred on a cut (start = cut - 0.2): whip (fast blurred sweep toward dir) | slide (push toward dir) |
   zoom_cut (zoom through the cut) | zoom_through (dives deep into x,y and comes out in the next shot) | flash | glitch |
   blur (gaussian blur in and out of the cut; amount = radius) | blur_zoom (blur plus a gentle zoom to x,y) |
   leak (coloured light leak; "color": "#ff9a3c"). flash and leak take an optional "color"
   · colour: bw. dir: left|right|up|down. "steps": 3 on a zoom = digital zoom in dry jumps. Snap = punch amount 0.32
   for 0.9 s plus a 0.2 s shake. Transitions are optional flavour: never more than one every ~5 s.
- {{"do": "scene_motion", "id": "<scene id>", "move": "in|out|left|right|up|down|still", "amount": 0.15, "drift": 0.3}}
   (camera move over a still image or video scene)
- {{"do": "auto_fx"}}   (re-place the automatic effects: speaker zooms, punch-ins, counting numbers, stickers, transitions)
- {{"do": "add_sound", "sound": "<id>", "at": 0, "volume": 0.8}}   ("at" = the moment it should hit; a riser is
   moved so that it ENDS there. Whoosh on cuts and transitions, riser before a reveal, drop or impact on the hit)
- {{"do": "add_sound", "want": "<english description, concrete: source, material, action>", "name": "<short Spanish
   name>", "intent": "<one of: {intents}>", "duration": 0, "at": 0, "volume": 0.8}}   (a sound that is not in the
   list; if it is not found either, nothing is added)
- {{"do": "update", "id": "<layer id>", "set": {{...fields...}}}}   (any layer: overlay, fx or audio)
- {{"do": "delete", "id": "<layer id>"}}
- {{"do": "segment", "index": 0, "set": {{"speed": 0.5, "freeze": 0.8, "volume": 1, "src_in": 0, "src_out": 0, "layout": "crop|fit_blur|fit_black"}}}}
- {{"do": "split", "at": 0}}   /   {{"do": "delete_segment", "index": 0}}
- {{"do": "hook", "text": ""}}   (on-screen hook text of the first seconds; "" removes it)
- {{"do": "caption_style", "set": {{"font_size": 80, "highlight_color": "#FFD400", "uppercase": true, "words_per_chunk": 3, "margin_v": 560}}}}
- {{"do": "captions", "enabled": true}}
- {{"do": "word", "index": 0, "text": "", "highlight": true}}   (fix a caption word or highlight it)
- {{"do": "word_style", "from": 0, "to": 0, "set": {{"color": "#FFD400", "scale": 1.4, "weight": 900, "font": "Bebas Neue",
   "italic": false, "anim": "pop|bounce|glow|fade_in|reveal_up|blur_in|typewriter|none", "out": "none|fade|shrink|blur|up"}}}}
   (mixed styles inside a sentence: style caption words from..to (indices), e.g. a number bigger and yellow; any key
   may be omitted; "set": {{}} removes their own style. caption_style "punctuation": "all|expressive|none" shows or hides
   the punctuation marks in the captions)
- {{"do": "aspect", "value": "9:16|1:1|4:5|16:9"}}
- {{"do": "color", "look": "<look>", "start": 0, "end": 0, "amount": 0.8, "exposure": 0, "contrast": 1, "saturation": 1,
   "temperature": 0, "vignette": 0, "mask": "none|subject|background"}}   (colour-grading adjustment layer over the video;
   looks: {looks}; mask subject/background = only the cut-out subject or only what is behind it, needs a cut-out)
- {{"do": "cut_words", "from": 0, "to": 0}}   (delete caption words from..to (indices) FROM THE VIDEO, image and sound;
   use it to remove a phrase, a mistake or filler words; only videos made from a source video)
- {{"do": "mix", "original": 1, "voice": 1, "music": 1, "sfx": 1, "ducking": 0.3}}   (volume of each sound group, 1 =
   unchanged; ducking = level the music drops to while someone speaks, 0 = off)
- {{"do": "marker", "at": 0, "label": "short name", "note": ""}}   (timeline marker for the editor, not visible in the
   video: use it to point out moments to review, a possible cut or where a sound could go)
Queries (their results come back to you before you finish; then send the edit actions):
- {{"do": "locate", "query": "the red pedal", "at": 0}}  → where an object is on the canvas at that time (x, y, w, h)
- {{"do": "look", "at": 0}}  → you get the frame at that time as an image
Use "locate" before placing a circle/arrow/zoom on a specific object unless its position is already known.

Respond with JSON only: {{"actions": [...], "reply": "", "done": true}}
Set "done": false only when you sent queries and need their results to continue.

CONVERSATION SO FAR:
{history}
USER: {message}
{observations}"""


# ---------- Resumen de la composición para la IA ----------

def _r(v: float) -> float:
    return round(float(v), 2)


def summarize(comp: dict) -> str:
    mix = comp.get("mix") or {}
    lines = [f"duration {compose.composition_duration(comp):.2f}s · aspect {comp.get('aspect')} · "
             f"hook text: {comp.get('hook', {}).get('text') or '(none)'} · captions "
             f"{'on' if comp.get('captions', {}).get('enabled') else 'off'}"]
    t = 0.0
    for i, s in enumerate(comp.get("segments", [])):
        length = compose.segment_length(s)
        extra = "".join([f", speed {s['speed']}" if s.get("speed", 1) != 1 else "",
                         f", freeze {s['freeze']}s" if s.get("freeze") else "", f", vol {s.get('volume', 1)}",
                         f", audio cut {s['audio_offset']:+.1f}s (J/L)" if s.get("audio_offset") else ""])
        lines.append(f"segment {i}: {t:.2f}-{t + length:.2f} · source {s['src_in']:.2f}-{s['src_out']:.2f}s · "
                     f"{s.get('layout')}{extra}" + (f" · \"{s['label']}\"" if s.get("label") else ""))
        t += length
    for sc in comp.get("scenes", []):
        what = sc.get("graphic", {}).get("component") if sc.get("kind") == "graphic" else sc.get("kind")
        m = sc.get("motion")
        cam = f" · camera zoom {m['from']['zoom']:.2f}->{m['to']['zoom']:.2f}" if m else ""
        lines.append(f"scene {sc['id']}: {sc['start']:.2f}-{sc['start'] + sc['duration']:.2f} · {what}{cam}")
    for o in comp.get("overlays", []):
        desc = (o.get("text") if o["kind"] in ("text", "progress") else o.get("title") if o["kind"] == "block"
                else o.get("component") if o["kind"] == "graphic"
                else f"colour {(o.get('grade') or {}).get('look') or 'manual'}" if o["kind"] == "adjust"
                else o.get("shape", o["kind"]))
        lines.append(f"overlay {o['id']} ({o['kind']}: {desc}) {o['start']:.2f}-{o['end']:.2f} at x {_r(o['x'])} y {_r(o['y'])}"
                     f" w {_r(o['w'])}" + (f" h {_r(o['h'])}" if "h" in o else "") + f" anim {o.get('anim')}"
                     + (f" loop {o['loop']}" if o.get("loop") not in (None, "none") else "")
                     + (f" track V{o.get('track')}" if o["kind"] == "video" else "")
                     + (f" keyframes {len(o['keys'])}" if o.get("keys") else "")
                     + (f" mask {o['mask']['shape']}{' inverted' if o['mask'].get('invert') else ''}" if o.get("mask") else ""))
    for f in comp.get("fx") or []:
        lines.append(f"fx {f['id']} ({f['kind']}) {f['start']:.2f}-{f['end']:.2f} amount {f['amount']}"
                     + (f" dir {f['dir']}" if f.get("dir") else ""))
    for a in comp.get("audio", []):
        kind = a.get("kind") or ("voice" if a["id"] == "narration" else "music")
        lines.append(f"audio {a['id']} ({kind}: {a.get('label') or Path(a['src']).name}) starts {a['start']:.2f}"
                     f" vol {a['volume']}" + (f" duck {a['duck']}" if a.get("duck") else ""))
    if mix:
        gains = ", ".join(f"{k} {v}" for k, v in (mix.get("gain") or {}).items() if v != 1)
        lines.append("mix: " + ", ".join(x for x in [gains, f"master {mix['master']}" if mix.get("master", 1) != 1 else "",
                                                    f"muted {mix['mute']}" if mix.get("mute") else "",
                                                    f"auto ducking to {mix['duck']['level']}" if mix.get("duck") else ""] if x))
    return "\n".join(lines)


def timeline_words(comp: dict) -> list[dict]:
    """Palabras en tiempo de timeline (como timelineWords en schema.ts) con su índice original."""
    cap = comp.get("captions", {})
    words = cap.get("words", [])
    if cap.get("time_base") == "timeline":
        return [{**w, "i": i} for i, w in enumerate(words)]
    out, t = [], 0.0
    segs = comp.get("segments", [])
    for s, (a, b) in zip(segs, compose.audio_source_ranges(segs)):  # un tramo duplicado repite sus palabras
        for i, w in enumerate(words):
            if a <= w["s"] < b and w.get("src", s["src"]) == s["src"]:
                out.append({**w, "i": i, "s": t + compose.segment_local_of(s, w["s"] - s["src_in"])})
        t += compose.segment_length(s)
    return sorted(out, key=lambda w: w["s"])


def _words_text(comp: dict, limit: int = 400) -> str:
    ws = timeline_words(comp)[:limit]
    return " ".join(f"{w['i']}:{w['w']}@{w['s']:.1f}" for w in ws) or "(no captions)"


# ---------- Consultas: fotogramas y objetos ----------

def _media_path(url: str) -> Path | None:
    """URL de un vídeo de la composición → archivo local."""
    url = unquote(url.split("?")[0])
    for prefix, sub in (("/media/clips/", "clips"), ("/media/assets/", "assets")):
        if url.startswith(prefix):  # recortes (rotoscopia) y recursos subidos
            return DATA_DIR / sub / url[len(prefix):]
    m = re.match(r"/api/sources/(\d+)/video", url)
    if m:
        with Session(engine) as s:
            src = s.get(Source, int(m.group(1)))
        return Path(src.video_path) if src else None
    return None


def segment_at(comp: dict, t: float) -> tuple[dict, float] | None:
    """Tramo bajo el instante t y segundo del original que se ve."""
    acc = 0.0
    for s in comp.get("segments", []):
        length = compose.segment_length(s)
        if acc <= t < acc + length:
            local = min(compose.segment_source_local(s, t - acc), s["src_out"] - s["src_in"] - 0.04)
            return s, s["src_in"] + max(0.0, local)
        acc += length
    return None


def _frame(comp: dict, t: float, name: str) -> tuple[Path, dict] | None:
    hit = segment_at(comp, t)
    if not hit:
        return None
    seg, src_t = hit
    path = _media_path(seg["src"])
    if not path or not path.exists():
        return None
    return extract_frame(path, src_t, WORK_DIR / f"{name}.jpg"), seg


def run_queries(comp: dict, queries: list[dict]) -> tuple[list[str], list[str]]:
    """Ejecuta locate/look. Devuelve (observaciones en texto, imágenes para la IA)."""
    notes, images, to_locate = [], [], []
    for n, q in enumerate(queries):
        at = float(q.get("at", 0))
        name = f"q{uuid.uuid4().hex[:6]}"
        got = _frame(comp, at, name)
        if not got:
            notes.append(f"{q['do']} at {at:.2f}s: there is no source video at that time (only graphics/scenes).")
            continue
        frame, seg = got
        if q["do"] == "look":
            images.append(str(frame))
            notes.append(f"look at {at:.2f}s: see image {frame.name} (the source frame; on the canvas it is shown with "
                         f"layout {seg.get('layout')}).")
        else:
            to_locate.append({"id": name, "image": str(frame), "query": str(q.get("query", ""))[:80], "_seg": seg,
                              "_at": at})
    if to_locate:
        found = locate([{k: v for k, v in it.items() if not k.startswith("_")} for it in to_locate])
        for it in to_locate:
            box = (found.get(it["id"]) or {}).get("box")
            if not box:
                notes.append(f"locate \"{it['query']}\" at {it['_at']:.2f}s: not found.")
                continue
            seg = it["_seg"]
            layout = seg.get("layout") if seg.get("layout") in ("crop", "fit_blur", "fit_black", "fit_color") else "fit_blur"
            x0, y0 = source_to_canvas(layout, seg["src_w"], seg["src_h"], box[0], box[1])
            x1, y1 = source_to_canvas(layout, seg["src_w"], seg["src_h"], box[2], box[3])
            notes.append(f"locate \"{it['query']}\" at {it['_at']:.2f}s: center x {(x0 + x1) / 2:.3f} y {(y0 + y1) / 2:.3f}, "
                         f"w {x1 - x0:.3f} h {y1 - y0:.3f} (canvas fractions).")
    return notes, images


# ---------- Acciones de edición ----------

def _id() -> str:
    return uuid.uuid4().hex[:8]


def _num(v, default: float, lo: float | None = None, hi: float | None = None) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = default
    if lo is not None:
        x = max(lo, x)
    if hi is not None:
        x = min(hi, x)
    return round(x, 3)


OVERLAY_FIELDS = {"text", "start", "end", "x", "y", "w", "h", "size", "color", "bg", "font", "weight", "anim", "shape",
                  "stroke", "rotation", "opacity", "loop", "rot"}
FX_FIELDS = {"kind", "start", "end", "x", "y", "amount", "dir", "steps", "color"}
FX_KINDS = {"punch": 1.2, "zoom": 3, "pan": 3, "drift": 4, "shake": 0.5, "whip": 0.4, "slide": 0.5, "zoom_cut": 0.5,
            "zoom_through": 0.7,
            "flash": 0.3, "glitch": 0.4, "bw": 2, "blur": 0.6, "blur_zoom": 0.6, "leak": 0.9}
ANIMS = {"none", "fade", "pop", "slide", "bounce", "zoom", "spin", "drop", "slide_left", "slide_right", "count", "type"}
LOOPS = {"none", "float", "pulse", "wiggle", "spin"}
WORD_STYLE_KEYS = {"color", "weight", "scale", "font", "italic", "anim", "out"}  # estilo propio de palabras
WORD_ANIMS = ("pop", "bounce", "glow", "none", "chunk_fade", "fade_in", "dim", "reveal_up", "blur_in", "typewriter", "sweep")
WORD_OUTS = ("none", "fade", "shrink", "blur", "up")
DIRS = {"left", "right", "up", "down"}
AUDIO_FIELDS = {"start", "volume", "duck", "fade_in", "fade_out", "src_in", "duration"}
SEGMENT_FIELDS = {"speed", "freeze", "volume", "src_in", "src_out", "layout"}
STYLE_FIELDS = set(compose.STYLE_FIELDS) | {"placement", "punctuation"}
TEMPLATE_LIST = "\n".join(f'   "{k}": {GRAPHIC_SPECS[k]}' for k in TEMPLATES)
LOOKS = ("teal_orange", "warm", "cool", "bw", "noir", "vintage", "bleach", "night", "vivid", "matte")
MIX_BUSES = ("original", "voice", "music", "sfx", "clips")
SHAPE_ES = {"circle": "Círculo", "box": "Recuadro", "arrow": "Flecha", "underline": "Subrayado"}


def scene_motion(move: str, k: float, drift: float = 0) -> dict:
    """Ken Burns de un preset (como ScenePanel.tsx): acercarse, alejarse, paneos o casi quieta."""
    z, d = 1 + k, min(0.3, k * 1.5)
    m = {"in": ((0.5, 0.5, 1), (0.5, 0.5, z)), "out": ((0.5, 0.5, z), (0.5, 0.5, 1)),
         "left": ((0.5 + d, 0.5, z), (0.5 - d, 0.5, z)), "right": ((0.5 - d, 0.5, z), (0.5 + d, 0.5, z)),
         "up": ((0.5, 0.5 + d, z), (0.5, 0.5 - d, z)), "down": ((0.5, 0.5 - d, z), (0.5, 0.5 + d, z)),
         "still": ((0.5, 0.5, 1.04), (0.5, 0.5, 1.04 + k / 5))}.get(move) or ((0.5, 0.5, 1), (0.5, 0.5, z))
    out = {"from": dict(zip(("x", "y", "zoom"), m[0])), "to": dict(zip(("x", "y", "zoom"), m[1]))}
    return {**out, "drift": round(drift, 2)} if drift else out


def apply_actions(comp: dict, actions: list[dict], sounds: dict[str, dict]) -> tuple[dict, list[str]]:
    """Aplica las acciones de edición. Devuelve la composición nueva y un resumen en español de cada cambio."""
    c = copy.deepcopy(comp)
    c.setdefault("fx", [])
    total = compose.composition_duration(c)
    changes: list[str] = []

    def span(a: dict, default_len: float) -> tuple[float, float]:
        start = _num(a.get("start"), 0, 0, max(0, total - 0.1))
        end = _num(a.get("end"), start + default_len, start + 0.1, total)
        return start, end

    for a in actions:
        kind = a.get("do")
        try:
            if kind == "add_text":
                start, end = span(a, 2)
                c["overlays"].append({"id": _id(), "kind": "text", "text": str(a.get("text", ""))[:120], "start": start,
                                      "end": end, "x": _num(a.get("x"), 0.5, 0, 1), "y": _num(a.get("y"), 0.2, 0, 1),
                                      "w": _num(a.get("w"), 0.86, 0.1, 1),
                                      "anim": a.get("anim") if a.get("anim") in ANIMS else "pop",
                                      "loop": a.get("loop") if a.get("loop") in LOOPS else "none",
                                      "rot": _num(a.get("rot"), 0, -45, 45),
                                      "size": _num(a.get("size"), 90, 20, 220), "color": a.get("color", "#FFFFFF"),
                                      "bg": a.get("bg", ""), "font": a.get("font", "Montserrat"), "weight": 900})
                changes.append(f"Texto «{a.get('text', '')}» en {start:.1f}-{end:.1f} s")
            elif kind == "add_sticker":
                start, end = span(a, 2.2)
                emoji = str(a.get("emoji") or "\U0001F525")[:4]
                c["overlays"].append({"id": _id(), "kind": "text", "text": emoji, "start": start, "end": end,
                                      "x": _num(a.get("x"), 0.78, 0, 1), "y": _num(a.get("y"), 0.3, 0, 1), "w": 0.3,
                                      "anim": "pop", "loop": "float", "rot": 8, "size": _num(a.get("size"), 170, 40, 300),
                                      "color": "#FFFFFF", "bg": "", "font": "Montserrat", "weight": 400})
                changes.append(f"Sticker {emoji} en {start:.1f} s")
            elif kind == "add_shape":
                shape = a.get("shape") if a.get("shape") in ("circle", "box", "arrow", "underline") else "circle"
                start, end = span(a, 1.6)
                c["overlays"].append({"id": _id(), "kind": "shape", "shape": shape, "start": start, "end": end,
                                      "x": _num(a.get("x"), 0.5, 0, 1), "y": _num(a.get("y"), 0.5, 0, 1),
                                      "w": _num(a.get("w"), 0.25 if shape == "arrow" else 0.3, 0.03, 1),
                                      "h": _num(a.get("h"), 0.15, 0, 1), "rotation": _num(a.get("rotation"), 45),
                                      "color": a.get("color", "#FF2D2D"), "stroke": _num(a.get("stroke"), 12, 4, 30),
                                      "anim": "draw"})
                changes.append(f"{SHAPE_ES[shape]} en {start:.1f} s")
            elif kind == "add_wait_bar":
                start, end = span(a, 2.5)
                c["overlays"].append({"id": _id(), "kind": "progress", "text": str(a.get("text") or "WAIT FOR IT...")[:40],
                                      "start": start, "end": end, "x": 0.5, "y": _num(a.get("y"), 0.2, 0, 1), "w": 0.7,
                                      "anim": "pop", "color": a.get("color", "#FFD400")})
                changes.append(f"Barra «espera» en {start:.1f}-{end:.1f} s")
            elif kind == "add_fx":
                fk = a.get("kind") if a.get("kind") in FX_KINDS else "punch"
                start, end = span(a, FX_KINDS[fk])
                c["fx"].append({"id": _id(), "kind": fk, "start": start, "end": end, "x": _num(a.get("x"), 0.5, 0, 1),
                                "y": _num(a.get("y"), 0.5, 0, 1), "amount": _num(a.get("amount"), 0.3, 0.05, 1.5),
                                **({"dir": a["dir"]} if a.get("dir") in DIRS else {}),
                                **({"color": a["color"]} if fk in ("flash", "leak") and isinstance(a.get("color"), str)
                                   and re.fullmatch(r"#[0-9a-fA-F]{6}", a["color"]) else {}),
                                **({"steps": int(_num(a.get("steps"), 3, 2, 6))} if fk == "zoom" and a.get("steps") else {})})
                changes.append(f"Efecto {fk} en {start:.1f} s")
            elif kind == "add_template":
                name = str(a.get("template") or "")
                if name not in TEMPLATES:
                    changes.append(f"(No existe la plantilla «{name}»)")
                    continue
                start, end = span(a, 4.5)
                props = {k: v for k, v in a["props"].items() if k != "image"} if isinstance(a.get("props"), dict) else {}
                c["overlays"].append({"id": _id(), "kind": "graphic", "component": name, "props": props, "start": start,
                                      "end": end, "x": _num(a.get("x"), 0.5, 0, 1), "y": _num(a.get("y"), 0.5, 0, 1),
                                      "w": _num(a.get("w"), 1, 0.2, 1), "anim": "none"})
                changes.append(f"Plantilla {name} en {start:.1f}-{end:.1f} s")
            elif kind == "scene_motion":
                sc = next((x for x in c.get("scenes") or [] if x["id"] == str(a.get("id"))), None)
                if not sc or sc.get("kind") == "graphic":
                    changes.append(f"(No hay una escena de imagen o vídeo «{a.get('id')}»)")
                    continue
                sc["motion"] = scene_motion(str(a.get("move") or "in"), _num(a.get("amount"), 0.15, 0.03, 0.4),
                                            _num(a.get("drift"), (sc.get("motion") or {}).get("drift", 0), 0, 1))
                changes.append(f"Cámara de la escena {sc['id']}: {a.get('move')}")
            elif kind == "auto_fx":
                before = c
                c = fxauto.decorate(c, fxauto.options(load_settings()))
                n = fxauto.summary(before, c)
                changes.append(f"Efectos automáticos: {sum(v for k, v in n.items() if k != 'removed')} colocados")
            elif kind == "add_sound":
                snd = sounds.get(str(a.get("sound")))
                if not snd and str(a.get("want") or "").strip():
                    # se busca en toda la biblioteca y, si es simple, se sintetiza
                    want = str(a.get("want")).strip()[:300]
                    got = sfx.find_or_make(want, str(a.get("intent") or ""), _num(a.get("duration"), 0, 0, 20),
                                           str(a.get("name") or ""))
                    snd = got["sound"]
                    if snd:
                        changes.append(f"(«{want}»: {'de la biblioteca' if got['how'] == 'library' else 'sintetizado aquí'})")
                if not snd:
                    changes.append(f"(No existe el sonido «{a.get('sound') or a.get('want')}»)")
                    continue
                at = sfx.start_at(snd, _num(a.get("at"), 0, 0, total))
                c["audio"].append({"id": _id(), "src": snd["url"], "start": at, "src_in": 0, "duration": 0,
                                   "volume": _num(a.get("volume"), 0.8, 0, 1.5), "fade_in": 0, "fade_out": 0,
                                   "kind": "sfx", "label": snd["name"]})
                changes.append(f"Sonido «{snd['name']}» en {at:.1f} s")
            elif kind in ("update", "delete"):
                lid = str(a.get("id"))
                for key, fields in (("overlays", OVERLAY_FIELDS), ("fx", FX_FIELDS), ("audio", AUDIO_FIELDS)):
                    items = c.get(key) or []
                    hit = next((x for x in items if x["id"] == lid), None)
                    if not hit:
                        continue
                    if kind == "delete":
                        c[key] = [x for x in items if x["id"] != lid]
                        changes.append(f"Borrada la capa {lid}")
                    else:
                        patch = {k: v for k, v in (a.get("set") or {}).items() if k in fields}
                        hit.update(patch)
                        changes.append(f"Cambiada la capa {lid}: {', '.join(patch) or 'nada'}")
                    break
                else:
                    changes.append(f"(No existe la capa {lid})")
            elif kind == "segment":
                i = int(a.get("index", -1))
                if not 0 <= i < len(c["segments"]):
                    changes.append(f"(No existe el tramo {i})")
                    continue
                seg = c["segments"][i]
                patch = {k: v for k, v in (a.get("set") or {}).items() if k in SEGMENT_FIELDS}
                if "speed" in patch:
                    patch["speed"] = _num(patch["speed"], 1, 0.25, 2)
                if "freeze" in patch:
                    patch["freeze"] = _num(patch["freeze"], 0, 0, 5)
                seg.update(patch)
                seg["src_out"] = max(seg["src_in"] + 0.2, seg["src_out"])
                changes.append(f"Tramo {i + 1}: {', '.join(f'{k}={v}' for k, v in patch.items())}")
            elif kind == "split":
                at = _num(a.get("at"), 0)
                acc = 0.0
                for i, seg in enumerate(c["segments"]):
                    length = compose.segment_length(seg)
                    if acc + 0.2 < at < acc + length - 0.2:
                        cut = seg["src_in"] + compose.segment_source_local(seg, at - acc)
                        if cut >= seg["src_out"] - 0.1:
                            break
                        second = {**copy.deepcopy(seg), "id": _id(), "src_in": round(cut, 3)}
                        seg["src_out"], seg["freeze"] = round(cut, 3), 0
                        c["segments"].insert(i + 1, second)
                        changes.append(f"Dividido el tramo {i + 1} en {at:.1f} s")
                        break
                    acc += length
            elif kind == "delete_segment":
                i = int(a.get("index", -1))
                if 0 <= i < len(c["segments"]) and len(c["segments"]) > 1:
                    c["segments"].pop(i)
                    changes.append(f"Borrado el tramo {i + 1}")
            elif kind == "hook":
                c["hook"] = {**(c.get("hook") or {}), "text": str(a.get("text", ""))[:100]}  # conserva su estilo
                changes.append("Gancho en pantalla: " + (c["hook"]["text"] or "quitado"))
            elif kind == "caption_style":
                patch = {k: v for k, v in (a.get("set") or {}).items() if k in STYLE_FIELDS}
                c["captions"]["style"].update(patch)
                changes.append(f"Estilo de subtítulos: {', '.join(patch)}")
            elif kind == "captions":
                c["captions"]["enabled"] = bool(a.get("enabled"))
                changes.append("Subtítulos " + ("activados" if c["captions"]["enabled"] else "desactivados"))
            elif kind == "word":
                i = int(a.get("index", -1))
                words = c["captions"]["words"]
                if 0 <= i < len(words):
                    if a.get("text"):
                        words[i]["w"] = str(a["text"])[:40]
                    if "highlight" in a:
                        words[i]["hl"] = bool(a["highlight"])
                    changes.append(f"Subtítulo {i}: «{words[i]['w']}»")
            elif kind == "word_style":
                words = c["captions"]["words"]
                i, j = sorted((int(a.get("from", -1)), int(a.get("to", a.get("from", -1)))))
                patch = {k: v for k, v in (a.get("set") or {}).items() if k in WORD_STYLE_KEYS and v not in (None, "")}
                if "scale" in patch:
                    patch["scale"] = _num(patch["scale"], 1, 0.4, 3)
                if patch.get("anim") not in (None, *WORD_ANIMS):
                    patch.pop("anim")
                if patch.get("out") not in (None, *WORD_OUTS):
                    patch.pop("out")
                if 0 <= i <= j < len(words):
                    for w in words[i:j + 1]:
                        if patch:
                            w["st"] = {**(w.get("st") or {}), **patch}
                        else:
                            w.pop("st", None)
                    changes.append(f"Estilo de las palabras {i}–{j}: " + (", ".join(patch) or "quitado"))
            elif kind == "color":
                start, end = span(a, total)
                grade = {"look": a["look"]} if a.get("look") in LOOKS else {}
                for k, lo, hi, base in (("amount", 0, 1, 1), ("exposure", -2, 2, 0), ("contrast", 0.4, 2, 1),
                                        ("saturation", 0, 2.5, 1), ("temperature", -1, 1, 0), ("tint", -1, 1, 0),
                                        ("vignette", 0, 1, 0)):
                    if a.get(k) is not None and _num(a[k], base, lo, hi) != base:
                        grade[k] = _num(a[k], base, lo, hi)
                layer = {"id": _id(), "kind": "adjust", "start": start, "end": end, "x": 0.5, "y": 0.5, "w": 1,
                         "anim": "fade" if end - start < total - 0.5 else "none", "grade": grade}
                if a.get("mask") in ("subject", "background"):
                    if not any(s.get("matte") for s in c["segments"] + c.get("scenes", [])):
                        changes.append("(Para corregir solo el sujeto o el fondo, recorta antes el sujeto: + Recorte…)")
                        continue
                    layer["mask"] = {"shape": "subject", "x": 0.5, "y": 0.5, "w": 1, "h": 1, "feather": 0,
                                     **({"invert": True} if a["mask"] == "background" else {})}
                c["overlays"].append(layer)
                changes.append(f"Color {grade.get('look', 'a mano')} en {start:.1f}-{end:.1f} s")
            elif kind == "cut_words":
                cap = c.get("captions", {})
                words = cap.get("words", [])
                i, j = int(a.get("from", -1)), int(a.get("to", a.get("from", -1)))
                if cap.get("time_base") != "source" or not c["segments"]:
                    changes.append("(Borrar palabras solo funciona en vídeos que salen de un vídeo con voz)")
                elif not (0 <= i <= j < len(words)):
                    changes.append(f"(No existen las palabras {i}-{j})")
                else:
                    lo, hi = compose.word_cut_range(words, i, j)
                    gone = compose.cut_source(c, lo, hi, words[i].get("src"))
                    text = " ".join(w["w"] for w in words[i:j + 1])
                    changes.append(f"Quitado del vídeo «{text[:60]}» ({gone:.1f} s)" if gone else f"(«{text[:40]}» no está en el vídeo)")
                    total = compose.composition_duration(c)
            elif kind == "mix":
                mix = c.setdefault("mix", {})
                gains = {b: _num(a[b], 1, 0, 2) for b in MIX_BUSES if a.get(b) is not None}
                if gains:
                    mix["gain"] = {**(mix.get("gain") or {}), **gains}
                if a.get("ducking") is not None:
                    level = _num(a["ducking"], 0, 0, 0.8)
                    if level:
                        mix["duck"] = {**(mix.get("duck") or {"attack": 0.3, "release": 0.5}), "level": level}
                    else:
                        mix.pop("duck", None)
                changes.append("Mezcla: " + ", ".join([f"{k} {v}" for k, v in gains.items()]
                                                     + ([f"ducking {a['ducking']}"] if a.get("ducking") is not None else [])))
            elif kind == "marker":  # marcador en la timeline (no se ve en el vídeo)
                at = round(_num(a.get("at"), 0, 0, total), 3)
                label = str(a.get("label") or "Marcador")[:60]
                marks = c.setdefault("markers", [])
                marks.append({"id": _id(), "t": at, "label": label, "color": "#956400",
                              **({"note": str(a["note"])[:200]} if a.get("note") else {})})
                marks.sort(key=lambda m: m["t"])
                changes.append(f"Marcador «{label}» en {at:.1f} s")
            elif kind == "aspect" and a.get("value") in ("9:16", "1:1", "4:5", "16:9"):
                c["aspect"] = a["value"]
                changes.append(f"Formato {a['value']}")
        except Exception as exc:  # una acción mal formada no tumba las demás
            log.warning("Acción del agente ignorada %s: %s", a, exc)
            changes.append(f"(Acción ignorada: {kind})")
    return c, changes


QUERY_KINDS = ("locate", "look")


def run_agent(clip_id: int, comp: dict, message: str, history: list[dict], playhead: float, selection: str) -> dict:
    settings = load_settings()
    provider = get_provider(settings.llm_provider, settings)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    catalog = sfx.catalog()
    sounds = {i["id"]: i for i in catalog}
    sound_list = sfx.ai_sound_list()  # solo tu galería si está importada, agrupada con el uso de cada categoría
    cw, ch = {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "16:9": (1920, 1080)}.get(comp.get("aspect"), (1080, 1920))
    hist = "\n".join(f"{'USER' if h.get('role') == 'user' else 'ASSISTANT'}: {h.get('text', '')}" for h in history[-8:]) or "(none)"
    observations: list[str] = []
    images: list[str] = []
    current = comp
    all_changes: list[str] = []
    reply = ""
    for turn in range(MAX_TURNS):
        prompt = PROMPT.format(summary=summarize(current), words=_words_text(current), playhead=playhead,
                               selection=selection or "nothing", sounds=sound_list, history=hist, message=message,
                               cw=cw, ch=ch, templates=TEMPLATE_LIST, looks="|".join(LOOKS), intents="|".join(sfx.INTENTS),
                               observations=("RESULTS OF YOUR QUERIES:\n" + "\n".join(observations)) if observations else "")
        out = provider.complete_json(prompt, images=images or None, task="editor")
        actions = [x for x in out.get("actions") or [] if isinstance(x, dict)]
        reply = str(out.get("reply") or reply)
        queries = [x for x in actions if x.get("do") in QUERY_KINDS]
        edits = [x for x in actions if x.get("do") not in QUERY_KINDS]
        if edits:
            current, changes = apply_actions(current, edits, sounds)
            all_changes += changes
        if queries and turn < MAX_TURNS - 1:
            notes, imgs = run_queries(current, queries)
            observations += notes
            images += imgs
            continue
        break
    return {"reply": reply or ("Hecho." if all_changes else "No he cambiado nada."),
            "composition": current if all_changes else None, "changes": all_changes}
