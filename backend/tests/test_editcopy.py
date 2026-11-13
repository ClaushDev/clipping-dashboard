import subprocess

import pytest

from clipping.config import find_exe
from clipping.pipeline import editcopy

pytestmark = pytest.mark.skipif(not find_exe("ffmpeg"), reason="sin ffmpeg")


def _make(path, codec):
    subprocess.run([find_exe("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:d=2:r=25",
                    "-f", "lavfi", "-i", "sine=d=2", "-c:v", codec, "-c:a", "aac", "-shortest", str(path)], check=True)


def test_h264_is_left_alone(tmp_path):
    src = tmp_path / "source.mp4"
    _make(src, "libx264")
    assert not editcopy.needs_copy(src)
    assert editcopy.ensure(src, tmp_path, replace=True) == src


def test_other_codecs_become_h264_with_short_gop(tmp_path):
    src = tmp_path / "source.mp4"
    _make(src, "mpeg4")  # cualquier códec que no sea H.264, como AV1 o VP9
    assert editcopy.needs_copy(src)
    seen = []
    out = editcopy.ensure(src, tmp_path / "f", replace=False, on_progress=seen.append)
    assert out == tmp_path / "f" / "edit.mp4" and src.exists()  # el archivo del usuario no se toca
    info = editcopy._video_info(out)
    assert info["codec"] == "h264" and (info["width"], info["height"]) == (320, 240)
    assert abs(info["duration"] - 2) < 0.2 and seen and seen[-1] > 0.5
    # Descargado por la app: la copia sustituye al original con el mismo nombre
    out2 = editcopy.ensure(src, tmp_path, replace=True)
    assert out2 == src and editcopy._video_info(src)["codec"] == "h264"
    assert not list(tmp_path.glob("*.part.mp4")) and not list(tmp_path.glob("*.h264.mp4"))
