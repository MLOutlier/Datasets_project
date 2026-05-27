from __future__ import annotations

import mimetypes
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict

from django.conf import settings
from PIL import Image

MEDIA_ROOT = Path(getattr(settings, "MEDIA_ROOT", Path(__file__).resolve().parents[3] / "media"))
UPLOAD_ROOT = MEDIA_ROOT / "projects"
MAX_UPLOAD_SIZE = int(getattr(settings, "MAX_UPLOAD_SIZE", 500 * 1024 * 1024))

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm"}


class UploadValidationError(ValueError):
    pass


def detect_asset_type(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    raise UploadValidationError(f"Unsupported file extension: {ext}")


def validate_upload(file_obj) -> str:
    if not getattr(file_obj, "name", ""):
        raise UploadValidationError("Uploaded file must include a name")
    if getattr(file_obj, "size", None) is None:
        raise UploadValidationError("Uploaded file size is not available")
    if file_obj.size > MAX_UPLOAD_SIZE:
        raise UploadValidationError(f"File too large. Maximum size is {MAX_UPLOAD_SIZE // (1024 * 1024)} MB")
    return detect_asset_type(file_obj.name)


def _safe_name(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    return f"{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex}{ext}"


def save_project_file(file_obj, project_id: str, import_id: str) -> Dict[str, str]:
    asset_type = validate_upload(file_obj)
    target_dir = UPLOAD_ROOT / project_id / import_id
    stored_name = _safe_name(file_obj.name)
    target_path = target_dir / stored_name
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        with open(target_path, "wb+") as destination:
            for chunk in file_obj.chunks():
                destination.write(chunk)
    except OSError as exc:
        raise UploadValidationError("Upload storage is not writable. Check MEDIA_ROOT permissions.") from exc
    mime_type, _ = mimetypes.guess_type(file_obj.name)
    return {
        "asset_type": asset_type,
        "file_path": str(target_path),
        "file_uri": f"/media/projects/{project_id}/{import_id}/{stored_name}",
        "file_name": file_obj.name,
        "file_size": str(file_obj.size),
        "mime_type": mime_type or "application/octet-stream",
    }


def absolute_media_path(file_uri: str) -> Path:
    relative = file_uri.replace("/media/", "")
    return MEDIA_ROOT / relative


def image_dimensions(file_uri: str) -> Dict[str, int]:
    path = absolute_media_path(file_uri)
    with Image.open(path) as image:
        width, height = image.size
    return {"width": width, "height": height}
