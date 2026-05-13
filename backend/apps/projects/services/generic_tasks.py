from __future__ import annotations

import csv
from datetime import datetime
import io
import json
from typing import Any, Iterable
import zipfile

from apps.datasets_core.models import Dataset
from apps.labeling.models import Annotation
from apps.projects.models import Project, Task
from apps.projects.task_registry import (
    TASK_CLASSIFICATION,
    TASK_COMPARISON,
    TASK_IMAGE_ANNOTATION,
    TASK_TEXT_ANNOTATION,
)

GENERIC_TASK_TYPES = {
    TASK_TEXT_ANNOTATION,
    TASK_IMAGE_ANNOTATION,
    TASK_CLASSIFICATION,
    TASK_COMPARISON,
}


def is_generic_task_project(project: Project) -> bool:
    return str(getattr(project, "task_type", "") or "") in GENERIC_TASK_TYPES


def generic_annotation_format(project: Project) -> str:
    return "generic_v1"


def generic_dataset_for_project(project: Project) -> Dataset:
    project_id = str(project.id)
    for dataset in Dataset.objects(owner=project.owner):
        metadata = dataset.metadata or {}
        if metadata.get("project_id") == project_id and metadata.get("purpose") == "generic_tasks":
            if metadata.get("annotation_format") != generic_annotation_format(project):
                metadata["annotation_format"] = generic_annotation_format(project)
                dataset.metadata = metadata
                dataset.save()
            return dataset

    dataset = Dataset(
        owner=project.owner,
        name=f"{project.title} generic tasks",
        description=f"Task dataset for project {project.title}",
        status=Dataset.STATUS_ACTIVE,
        metadata={
            "project_id": project_id,
            "purpose": "generic_tasks",
            "task_type": getattr(project, "task_type", ""),
            "widget_type": getattr(project, "widget_type", ""),
            "annotation_format": generic_annotation_format(project),
        },
    )
    dataset.save()
    return dataset


def _normalize_task_item(project: Project, raw: Any, index: int) -> dict:
    if isinstance(raw, str):
        text = raw.strip()
        return {
            "title": text[:120] or f"Task {index}",
            "input_ref": "",
            "metadata": {"prompt": text},
        }
    if not isinstance(raw, dict):
        return {
            "title": f"Task {index}",
            "input_ref": "",
            "metadata": {"prompt": str(raw)},
        }

    title = str(raw.get("title") or raw.get("prompt") or raw.get("text") or f"Task {index}").strip()
    input_ref = str(raw.get("input_ref") or raw.get("url") or raw.get("file_uri") or "").strip()
    metadata = {
        "prompt": str(raw.get("prompt") or raw.get("text") or title).strip(),
        "option_a": str(raw.get("option_a") or raw.get("a") or "").strip(),
        "option_b": str(raw.get("option_b") or raw.get("b") or "").strip(),
        "source": raw.get("source") or "manual",
        "task_type": getattr(project, "task_type", ""),
        "widget_type": getattr(project, "widget_type", ""),
    }
    extra_metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
    for key, value in extra_metadata.items():
        metadata[str(key)] = value
    return {
        "title": title[:500] or f"Task {index}",
        "input_ref": input_ref[:1024],
        "metadata": {key: value for key, value in metadata.items() if value not in ("", None)},
    }


def create_generic_tasks_from_items(project: Project, items: Iterable[Any]) -> dict:
    if not is_generic_task_project(project):
        return {"created": 0, "skipped": 0, "dataset_id": "", "total": Task.objects(project=project).count()}

    dataset = generic_dataset_for_project(project)
    created = 0
    skipped = 0
    for index, raw in enumerate(items, start=1):
        item = _normalize_task_item(project, raw, index)
        title = item["title"]
        input_ref = item["input_ref"]
        metadata = item["metadata"]
        duplicate = None
        source_key = str(metadata.get("source_key") or metadata.get("source_frame_id") or "").strip()
        if source_key:
            duplicate = next((task for task in Task.objects(project=project) if (task.metadata or {}).get("source_key") == source_key or (task.metadata or {}).get("source_frame_id") == source_key), None)
        elif input_ref:
            duplicate = Task.objects(project=project, input_ref=input_ref).first()
        if duplicate:
            skipped += 1
            continue
        Task(
            project=project,
            dataset=dataset,
            title=title,
            status=Task.STATUS_PENDING,
            input_ref=input_ref or None,
            metadata=metadata,
        ).save()
        created += 1
    return {"created": created, "skipped": skipped, "dataset_id": str(dataset.id), "total": Task.objects(project=project).count()}


def create_image_tasks_from_import(import_session) -> dict:
    project = import_session.project
    if str(getattr(project, "task_type", "") or "") != TASK_IMAGE_ANNOTATION:
        return {"created": 0, "skipped": 0, "dataset_id": "", "total": Task.objects(project=project).count()}

    from apps.cv_annotation.models import FrameItem, ImportAsset

    items = []
    processed_assets = list(ImportAsset.objects(import_session=import_session, processing_status=ImportAsset.STATUS_PROCESSED))
    for asset in processed_assets:
        if asset.asset_type != ImportAsset.TYPE_IMAGE:
            continue
        for frame in FrameItem.objects(project=project, asset=asset).order_by("frame_number"):
            items.append(
                {
                    "title": asset.file_name or f"Image {frame.id}",
                    "input_ref": frame.frame_uri,
                    "metadata": {
                        "source": "image_import",
                        "source_key": str(frame.id),
                        "source_frame_id": str(frame.id),
                        "source_asset_id": str(asset.id),
                        "width": frame.width,
                        "height": frame.height,
                    },
                }
            )
    return create_generic_tasks_from_items(project, items)


def generic_task_summary(project: Project) -> dict:
    tasks = list(Task.objects(project=project))
    return {
        "total": len(tasks),
        "pending": sum(1 for task in tasks if task.status == Task.STATUS_PENDING),
        "in_progress": sum(1 for task in tasks if task.status == Task.STATUS_IN_PROGRESS),
        "review": sum(1 for task in tasks if task.status == Task.STATUS_REVIEW),
        "completed": sum(1 for task in tasks if task.status == Task.STATUS_COMPLETED),
        "rejected": sum(1 for task in tasks if task.status == Task.STATUS_REJECTED),
    }


def validate_generic_submission(project: Project, label_data: dict) -> str:
    task_type = str(getattr(project, "task_type", "") or "")
    if not isinstance(label_data, dict) or not label_data:
        return "Answer payload is required."

    if task_type in {TASK_CLASSIFICATION, TASK_IMAGE_ANNOTATION}:
        label = str(label_data.get("label") or label_data.get("class_label") or "").strip()
        allowed = {str(item.get("name") or item.get("label") or "").strip() for item in project.label_schema or []}
        allowed.discard("")
        if not label:
            return "Select a label before submitting."
        if allowed and label not in allowed:
            return "Selected label is not allowed for this project."
        return ""

    if task_type == TASK_COMPARISON:
        choice = str(label_data.get("choice") or "").strip().upper()
        if choice not in {"A", "B"}:
            return "Choose option A or B before submitting."
        return ""

    if task_type == TASK_TEXT_ANNOTATION:
        text = str(label_data.get("text") or "").strip()
        if not text:
            return "Text answer is required."
        return ""

    return ""


def _latest_annotation(task: Task) -> Annotation | None:
    return Annotation.objects(task=task).order_by("-created_at").first()


def _generic_export_rows(project: Project) -> list[dict]:
    rows = []
    for task in Task.objects(project=project).order_by("created_at"):
        annotation = _latest_annotation(task)
        rows.append(
            {
                "task_id": str(task.id),
                "project_id": str(project.id),
                "dataset_id": str(task.dataset.id),
                "task_type": str(getattr(project, "task_type", "") or ""),
                "widget_type": str(getattr(project, "widget_type", "") or ""),
                "title": task.title,
                "input_ref": task.input_ref or "",
                "prompt": (task.metadata or {}).get("prompt", ""),
                "option_a": (task.metadata or {}).get("option_a", ""),
                "option_b": (task.metadata or {}).get("option_b", ""),
                "task_status": task.status,
                "annotator_id": str(task.annotator.id) if task.annotator else "",
                "annotation_id": str(annotation.id) if annotation else "",
                "annotation_status": annotation.status if annotation else "",
                "annotation_format": annotation.annotation_format if annotation else generic_annotation_format(project),
                "label_data": annotation.label_data if annotation else {},
                "created_at": task.created_at.isoformat() if task.created_at else "",
                "updated_at": task.updated_at.isoformat() if task.updated_at else "",
                "annotated_at": annotation.created_at.isoformat() if annotation and annotation.created_at else "",
                "source_metadata": task.metadata or {},
            }
        )
    return rows


def _csv_text(rows: list[dict]) -> str:
    stream = io.StringIO()
    headers = [
        "task_id",
        "project_id",
        "dataset_id",
        "task_type",
        "widget_type",
        "title",
        "input_ref",
        "prompt",
        "option_a",
        "option_b",
        "task_status",
        "annotator_id",
        "annotation_id",
        "annotation_status",
        "annotation_format",
        "label_data",
        "created_at",
        "updated_at",
        "annotated_at",
        "source_metadata",
    ]
    writer = csv.DictWriter(stream, fieldnames=headers, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    for row in rows:
        serializable = dict(row)
        serializable["label_data"] = json.dumps(serializable.get("label_data") or {}, ensure_ascii=False)
        serializable["source_metadata"] = json.dumps(serializable.get("source_metadata") or {}, ensure_ascii=False)
        writer.writerow(serializable)
    return stream.getvalue()


def build_generic_project_export(project: Project, export_format: str = "both") -> dict:
    rows = _generic_export_rows(project)
    payload = {
        "export_version": 1,
        "generated_at": datetime.utcnow().isoformat(),
        "project": {
            "id": str(project.id),
            "title": project.title,
            "annotation_type": project.annotation_type,
            "task_type": str(getattr(project, "task_type", "") or ""),
            "widget_type": str(getattr(project, "widget_type", "") or ""),
            "export_format": export_format,
        },
        "quality_report": {
            "tasks": generic_task_summary(project),
            "annotations_total": sum(1 for row in rows if row["annotation_id"]),
            "completion_rate": round(sum(1 for row in rows if row["task_status"] == Task.STATUS_COMPLETED) / len(rows), 4) if rows else 0.0,
        },
    }
    if export_format in {"json", "both"}:
        payload["json"] = rows
    if export_format in {"jsonl", "both"}:
        payload["jsonl"] = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    if export_format in {"csv", "both"}:
        payload["csv"] = rows
    return payload


def build_generic_project_export_archive(project: Project, export_format: str = "both") -> tuple[str, bytes]:
    payload = build_generic_project_export(project, export_format=export_format)
    rows = _generic_export_rows(project)
    archive_stream = io.BytesIO()
    with zipfile.ZipFile(archive_stream, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("export_manifest.json", json.dumps({k: payload[k] for k in ("export_version", "generated_at", "project")}, ensure_ascii=False, indent=2))
        bundle.writestr("quality_report.json", json.dumps(payload.get("quality_report", {}), ensure_ascii=False, indent=2))
        if export_format in {"json", "both"}:
            bundle.writestr("annotations.json", json.dumps(rows, ensure_ascii=False, indent=2))
        if export_format in {"jsonl", "both"}:
            bundle.writestr("annotations.jsonl", "\n".join(json.dumps(row, ensure_ascii=False) for row in rows))
        if export_format in {"csv", "both"}:
            bundle.writestr("annotations.csv", _csv_text(rows))
    return f"project_{project.id}_generic_{export_format}.zip", archive_stream.getvalue()
