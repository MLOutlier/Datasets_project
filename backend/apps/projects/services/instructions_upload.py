from __future__ import annotations

import mimetypes
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Tuple

from django.conf import settings


class InstructionUploadError(ValueError):
    pass


ALLOWED_EXTENSIONS = {
    ".pdf",
    ".html",
    ".htm",
    ".docx",
    ".md",
    ".txt",
    ".csv",
    ".json",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".mp4",
    ".mov",
    ".webm",
}


def _safe_name(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    return f"{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex}{ext}"


def save_project_instruction(file_obj, project_id: str) -> Tuple[Dict[str, str], Path]:
    """
    Сохраняет файл инструкции проекта в MEDIA_ROOT/projects/<project_id>/instructions/.
    Возвращает метаданные и абсолютный путь к файлу.
    """
    if not file_obj:
        raise InstructionUploadError("file is required")

    max_size = int(getattr(settings, "MAX_INSTRUCTION_UPLOAD_SIZE", 25 * 1024 * 1024))
    if getattr(file_obj, "size", 0) and file_obj.size > max_size:
        raise InstructionUploadError(f"File too large. Maximum size is {max_size // (1024 * 1024)} MB")

    original_name = getattr(file_obj, "name", "") or "instruction"
    ext = Path(original_name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise InstructionUploadError(f"Unsupported instruction file extension: {ext}")

    media_root = Path(getattr(settings, "MEDIA_ROOT", Path(__file__).resolve().parents[4] / "media"))
    target_dir = media_root / "projects" / project_id / "instructions"
    target_dir.mkdir(parents=True, exist_ok=True)

    stored_name = _safe_name(original_name)
    target_path = target_dir / stored_name

    with open(target_path, "wb+") as destination:
        for chunk in file_obj.chunks():
            destination.write(chunk)

    mime_type, _ = mimetypes.guess_type(original_name)
    file_uri = f"/media/projects/{project_id}/instructions/{stored_name}"

    return (
        {
            "file_uri": file_uri,
            "file_name": original_name,
            "mime_type": mime_type or "application/octet-stream",
            "file_size": str(getattr(file_obj, "size", 0) or 0),
        },
        target_path,
    )


def save_project_instruction_asset(file_obj, project_id: str, folder: str = "instruction-assets") -> Tuple[Dict[str, str], Path]:
    if not file_obj:
        raise InstructionUploadError("file is required")

    max_size = int(getattr(settings, "MAX_INSTRUCTION_UPLOAD_SIZE", 25 * 1024 * 1024))
    if getattr(file_obj, "size", 0) and file_obj.size > max_size:
        raise InstructionUploadError(f"File too large. Maximum size is {max_size // (1024 * 1024)} MB")

    original_name = getattr(file_obj, "name", "") or "asset"
    ext = Path(original_name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise InstructionUploadError(f"Unsupported instruction asset extension: {ext}")

    media_root = Path(getattr(settings, "MEDIA_ROOT", Path(__file__).resolve().parents[4] / "media"))
    target_dir = media_root / "projects" / project_id / folder
    target_dir.mkdir(parents=True, exist_ok=True)

    stored_name = _safe_name(original_name)
    target_path = target_dir / stored_name

    with open(target_path, "wb+") as destination:
        for chunk in file_obj.chunks():
            destination.write(chunk)

    mime_type, _ = mimetypes.guess_type(original_name)
    file_uri = f"/media/projects/{project_id}/{folder}/{stored_name}"
    return (
        {
            "file_uri": file_uri,
            "file_name": original_name,
            "mime_type": mime_type or "application/octet-stream",
            "file_size": str(getattr(file_obj, "size", 0) or 0),
        },
        target_path,
    )

