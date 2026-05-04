from __future__ import annotations

import subprocess
from pathlib import Path
from typing import List

from PIL import Image

from .upload import absolute_media_path


class FrameExtractionError(RuntimeError):
    pass


def ffmpeg_diagnostics() -> dict:
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except FileNotFoundError:
        return {"available": False, "message": "ffmpeg is not installed or not available in PATH"}
    except subprocess.TimeoutExpired:
        return {"available": False, "message": "ffmpeg diagnostics timed out"}
    if result.returncode != 0:
        return {"available": False, "message": result.stderr.strip() or "ffmpeg command failed"}
    first_line = (result.stdout or "").splitlines()
    return {"available": True, "message": first_line[0] if first_line else "ffmpeg available"}


def extract_video_frames(file_uri: str, project_id: str, import_id: str, interval_sec: float) -> List[dict]:
    video_path = absolute_media_path(file_uri)
    if not video_path.exists():
        raise FrameExtractionError(f"Video file not found: {file_uri}")

    if interval_sec <= 0:
        raise FrameExtractionError("Frame interval must be greater than zero")

    frames_dir = video_path.parent / f"frames_{Path(video_path).stem}"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for stale_frame in frames_dir.glob("frame_*.jpg"):
        stale_frame.unlink(missing_ok=True)
    output_pattern = str(frames_dir / "frame_%06d.jpg")
    fps_expr = f"fps=1/{interval_sec}"

    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video_path), "-vf", fps_expr, "-q:v", "2", "-y", output_pattern],
            capture_output=True,
            text=True,
            timeout=1800,
        )
    except FileNotFoundError as exc:
        raise FrameExtractionError("ffmpeg is not installed or not available in PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise FrameExtractionError("Video frame extraction timed out") from exc

    if result.returncode != 0:
        raise FrameExtractionError(result.stderr.strip() or "ffmpeg failed to extract frames")

    frame_files = sorted(frames_dir.glob("frame_*.jpg"))
    if not frame_files:
        raise FrameExtractionError("No frames were extracted from the video")

    frames: List[dict] = []
    for index, frame_path in enumerate(frame_files):
        with Image.open(frame_path) as image:
            width, height = image.size
        frame_uri = f"/media/projects/{project_id}/{import_id}/{frames_dir.name}/{frame_path.name}"
        frames.append(
            {
                "frame_uri": frame_uri,
                "frame_number": index,
                "timestamp_sec": round(index * interval_sec, 3),
                "width": width,
                "height": height,
            }
        )
    return frames
