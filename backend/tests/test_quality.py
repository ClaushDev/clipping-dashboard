import json
import subprocess

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from clipping import quality
from clipping.api import app
from clipping.config import DATA_DIR, find_exe
from clipping.db import Clip, engine, init_db

client = TestClient(app)
init_db()


def _words(n: int, start: float = 0.2, step: float = 0.4, gap_at: int = -1, gap: float = 0.0) -> list[dict]:
    out, t = [], start
    for i in range(n):
        if i == gap_at:
            t += gap
        out.append({"w": f"w{i}", "s": round(t, 2), "e": round(t + 0.3, 2)})
        t += step
    return out


def _comp(**extra) -> dict:
    base = {"version": 1, "aspect": "9:16", "fps": 30, "segments": [], "scenes": [], "overlays": [], "audio": [],
            "captions": {"enabled": True, "time_base": "timeline", "style": {"hook_enabled": True}, "words": []},
            "hook": {"text": "Nadie te lo cuenta"}}
    return {**base, **extra}


def test_plan_flags_slideshow_dead_air_and_missing_files():
    scenes = [{"id": f"s{k}", "kind": "image", "start": k * 8.0, "duration": 8.0, "transition": "cut",
               "src": "/media/assets/no-existe.png"} for k in range(5)]
    comp = _comp(scenes=scenes, hook={"text": ""},
                 audio=[{"id": "v", "kind": "voice", "src": "/media/assets/no-narration.wav", "start": 0, "duration": 0},
                        {"id": "m", "kind": "music", "src": "", "volume": 0.6, "start": 0, "duration": 0}],
                 captions={"enabled": True, "time_base": "timeline", "style": {}, "words": _words(90, gap_at=40, gap=2.5)})
    plan = quality.plan_check(comp)
    codes = [i["code"] for i in plan["issues"]]
    assert "slideshow" in codes and codes.count("long_still") == 4  # 3 con su segundo + «y 2 más»
    assert "slow_open" in codes and "dead_air" in codes and "no_hook" in codes and "music_loud" in codes
    assert codes.count("missing_file") == 6
    gap = next(i for i in plan["issues"] if i["code"] == "dead_air")
    assert gap["at"] == pytest.approx(16.1, abs=0.01) and "2.6 s" in gap["text"]
    assert plan["metrics"]["still_share"] == 1.0 and plan["metrics"]["shots"] == 5
    value, verdict = quality.score(plan["issues"])
    assert verdict == "problema" and value < 50


def test_plan_clean_clip():
    seg = {"id": "a", "src": "/api/sources/1/video", "src_w": 1920, "src_h": 1080, "src_in": 10, "src_out": 40,
           "layout": "crop", "keys": [], "volume": 1}
    words = [{"w": f"w{i}", "s": 10.1 + i * 0.35, "e": 10.4 + i * 0.35} for i in range(80)]
    comp = _comp(segments=[seg, {**seg, "id": "b", "src_in": 50, "src_out": 60}],
                 captions={"enabled": True, "time_base": "source", "style": {"hook_enabled": True}, "words": words})
    plan = quality.plan_check(comp)
    assert [i for i in plan["issues"] if i["level"] != "info"] == []
    assert plan["metrics"]["words"] == 80 and 160 < plan["metrics"]["wpm"] < 180  # tiempos de origen → timeline


def test_parse_ffmpeg_and_render_issues():
    log = """[blackdetect @ 0] black_start:4.2 black_end:5.6 black_duration:1.4
[freezedetect @ 0] lavfi.freezedetect.freeze_start: 10.0
[freezedetect @ 0] lavfi.freezedetect.freeze_duration: 3.5
[freezedetect @ 0] lavfi.freezedetect.freeze_end: 13.5
[silencedetect @ 0] silence_start: 20.0
[silencedetect @ 0] silence_end: 22.0 | silence_duration: 2.0
[scdet @ 0] lavfi.scd.score: 40.1, lavfi.scd.time: 2.5
[scdet @ 0] lavfi.scd.score: 33.0, lavfi.scd.time: 7.5
  Stream #0:1: Audio: aac
[Parsed_ebur128_0 @ 0] Summary:
  Integrated loudness:
    I:         -22.5 LUFS
  True peak:
    Peak:       -0.4 dBFS
"""
    data = quality.parse_ffmpeg(log)
    assert data["black"] == [(4.2, 5.6)] and data["freezes"] == [(10.0, 3.5)] and data["silences"] == [(20.0, 2.0)]
    assert data["cuts"] == [2.5, 7.5] and data["lufs"] == -22.5 and data["peak"] == -0.4 and data["has_audio"]
    issues, metrics = quality.render_issues(data, 30.0, 30.0, scene_based=False)
    codes = {i["code"]: i["level"] for i in issues}
    assert codes == {"black": "error", "freeze": "warn", "quiet": "warn", "clipping": "warn", "silence": "warn",
                     "long_take": "info"}
    assert metrics["real_cuts"] == 2 and metrics["real_longest_shot"] == 22.5


@pytest.mark.skipif(not find_exe("ffmpeg"), reason="sin FFmpeg")
def test_analyze_real_video(tmp_path):
    """Vídeo sintético: 2 s de imagen, 2 s de negro y silencio, 2 s de otra imagen. FFmpeg tiene que verlo todo."""
    out = tmp_path / "t.mp4"
    subprocess.run([
        find_exe("ffmpeg"), "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=d=2:s=320x240:r=25", "-f", "lavfi", "-i", "color=black:d=2:s=320x240:r=25",
        "-f", "lavfi", "-i", "testsrc2=d=2:s=320x240:r=25",
        "-f", "lavfi", "-i", "sine=f=440:d=2", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2",
        "-f", "lavfi", "-i", "sine=f=660:d=2",
        "-filter_complex", "[0:v][3:a][1:v][4:a][2:v][5:a]concat=n=3:v=1:a=1[v][a]", "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(out)], check=True)
    data = quality.analyze_video(out)
    (b0, b1), = data["black"]
    assert 1.9 < b0 < 2.1 and 3.9 < b1 < 4.1
    assert any(1.9 < s < 2.2 and d > 1.5 for s, d in data["silences"]) and data["has_audio"]
    assert data["lufs"] is not None and len(data["cuts"]) >= 2
    comp = _comp(scenes=[{"id": "x", "kind": "graphic", "start": 0, "duration": 6, "transition": "cut", "graphic": {}}],
                 audio=[{"id": "v", "kind": "voice", "src": "", "start": 0, "duration": 0}])
    report = quality.check_clip(comp, out, version=3)
    assert report["rendered"] and report["verdict"] == "problema" and report["sheet"] == ""  # fuera de DATA_DIR
    assert {"black", "silence"} <= {i["code"] for i in report["issues"]}


def test_quality_endpoints():
    with Session(engine) as s:
        comp = _comp(scenes=[{"id": "s", "kind": "image", "start": 0, "duration": 10, "transition": "cut", "src": ""}])
        clip = Clip(source_id=0, start=0, end=10, composition=json.dumps(comp), status="review")
        s.add(clip)
        s.commit()
        clip_id = clip.id
    r = client.post(f"/api/clips/{clip_id}/quality")
    assert r.status_code == 200 and not r.json()["rendered"] and r.json()["counts"]["warn"] >= 1
    listed = next(c for c in client.get("/api/clips").json() if c["id"] == clip_id)
    assert set(listed["quality"]) == {"score", "verdict", "counts", "version"}
    assert client.get(f"/api/clips/{clip_id}").json()["quality"]["issues"]
    plan = client.post("/api/quality/plan", json={"composition": comp}).json()
    assert plan["score"] == listed["quality"]["score"] and plan["rendered"] is False
