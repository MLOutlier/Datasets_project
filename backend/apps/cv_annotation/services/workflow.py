from __future__ import annotations

import csv
from datetime import datetime, timedelta
import hashlib
import io
import json
import random
import subprocess
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from bson import ObjectId
from mongoengine import Q

from apps.projects.models import Project, ProjectMembership
from apps.projects.task_registry import (
    TASK_BBOX_ANNOTATION,
    TASK_BBOX_VALIDATION,
    TASK_CLASSIFICATION,
    TASK_COMPARISON,
    TASK_IMAGE_ANNOTATION,
    TASK_TEXT_ANNOTATION,
    TASK_TYPE_SPECS,
    TASK_VIDEO_ANNOTATION,
    TASK_VIDEO_INTERVAL_VALIDATION,
)
from apps.users.models import User
from ..models import (
    Assignment,
    BBoxValidationAssignment,
    FrameItem,
    GoldenAnnotationAssignment,
    GoldenAttempt,
    GoldenFrame,
    ImportAsset,
    ImportSession,
    IntervalValidationAssignment,
    ReviewRecord,
    VideoChunkAnnotation,
    VideoChunkAssignment,
    VideoChunkTask,
    VideoInterval,
    WorkAnnotation,
    WorkItem,
    SecurityEvent,
)
from .frames import FrameExtractionError, extract_video_frames, ffmpeg_diagnostics
from .preannotation import generate_preannotation_for_frame
from .security import log_security_event
from .upload import absolute_media_path, image_dimensions
from .video_qc import build_video_qc_payload, interpolate_boxes

DEFAULT_TASK_BATCH_SIZE = 10
DEFAULT_MIN_SEQUENCE_SIZE = 3
DEFAULT_INTERVAL_VALIDATORS_PER_ITEM = 3
DEFAULT_BBOX_VALIDATORS_PER_BATCH = 3
DEFAULT_BBOX_REAL_ITEMS_PER_BATCH = 20
DEFAULT_BBOX_GOLDEN_ITEMS_PER_BATCH = 10
DEFAULT_GOLDEN_MIN_SCORE = 0.8
DEFAULT_VIDEO_CHUNK_DURATION_SEC = 45
DEFAULT_VIDEO_CHUNK_MIN_DURATION_SEC = 30
DEFAULT_VIDEO_CHUNK_MAX_DURATION_SEC = 60
DEFAULT_INTERVAL_REVIEW_PADDING_SEC = 2.0
DEFAULT_ANNOTATION_GOLDEN_INTERVAL = 9
DEFAULT_STUCK_ASSIGNMENT_TTL_MINUTES = 120
DEFAULT_GOLDEN_CANDIDATE_THRESHOLD = 0.9
DEFAULT_GOLDEN_PROMOTION_TARGET = 10
DEFAULT_MAX_REANNOTATION_ROUNDS = 2
DEFAULT_BBOX_COORDINATE_SPREAD_THRESHOLD = 0.25


def _int_rule(project: Project, key: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int((project.participant_rules or {}).get(key) or default))
    except (TypeError, ValueError):
        return max(minimum, default)


def _float_rule(project: Project, key: str, default: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    try:
        value = float((project.participant_rules or {}).get(key) or default)
    except (TypeError, ValueError):
        value = default
    return min(max(value, minimum), maximum)


def workflow_runtime_settings(project: Project) -> dict:
    return {
        "interval_annotators_per_chunk": _int_rule(
            project,
            "interval_annotators_per_chunk",
            max(1, int(project.assignments_per_task or 1)),
        ),
        "interval_validators_per_item": _int_rule(project, "interval_validators_per_item", DEFAULT_INTERVAL_VALIDATORS_PER_ITEM),
        "bbox_validators_per_batch": _int_rule(project, "bbox_validators_per_batch", DEFAULT_BBOX_VALIDATORS_PER_BATCH),
        "bbox_real_items_per_batch": _int_rule(project, "bbox_real_items_per_batch", DEFAULT_BBOX_REAL_ITEMS_PER_BATCH),
        "bbox_golden_items_per_batch": _int_rule(project, "bbox_golden_items_per_batch", DEFAULT_BBOX_GOLDEN_ITEMS_PER_BATCH),
        "golden_min_score": _float_rule(project, "golden_min_score", DEFAULT_GOLDEN_MIN_SCORE),
        "video_chunk_duration_sec": _int_rule(project, "video_chunk_duration_sec", DEFAULT_VIDEO_CHUNK_DURATION_SEC),
        "video_chunk_min_duration_sec": _int_rule(project, "video_chunk_min_duration_sec", DEFAULT_VIDEO_CHUNK_MIN_DURATION_SEC),
        "video_chunk_max_duration_sec": _int_rule(project, "video_chunk_max_duration_sec", DEFAULT_VIDEO_CHUNK_MAX_DURATION_SEC),
        "interval_review_padding_sec": _float_rule(project, "interval_review_padding_sec", DEFAULT_INTERVAL_REVIEW_PADDING_SEC, minimum=0.0, maximum=30.0),
        "annotation_golden_interval": _int_rule(project, "annotation_golden_interval", DEFAULT_ANNOTATION_GOLDEN_INTERVAL),
        "stuck_assignment_ttl_minutes": _int_rule(project, "stuck_assignment_ttl_minutes", DEFAULT_STUCK_ASSIGNMENT_TTL_MINUTES),
        "golden_candidate_threshold": _float_rule(project, "golden_candidate_threshold", DEFAULT_GOLDEN_CANDIDATE_THRESHOLD),
        "golden_promotion_target": _int_rule(project, "golden_promotion_target", DEFAULT_GOLDEN_PROMOTION_TARGET),
        "max_reannotation_rounds": _int_rule(project, "max_reannotation_rounds", DEFAULT_MAX_REANNOTATION_ROUNDS, minimum=0),
        "bbox_coordinate_spread_threshold": _float_rule(
            project,
            "bbox_coordinate_spread_threshold",
            DEFAULT_BBOX_COORDINATE_SPREAD_THRESHOLD,
            minimum=0.0,
            maximum=1.0,
        ),
    }


def _task_type(project: Project) -> str:
    return str(getattr(project, "task_type", "") or TASK_BBOX_ANNOTATION)


def _is_task(project: Project, *task_types: str) -> bool:
    return _task_type(project) in task_types


def _workflow_meta_set(obj, **updates) -> dict:
    meta = obj.workflow_meta or {}
    meta.update(updates)
    obj.workflow_meta = meta
    return meta


def _mark_work_item_validation_blocked(work_item: WorkItem, validation_status: str, reason: str, extra: Optional[dict] = None) -> None:
    meta = _workflow_meta_set(
        work_item,
        blocked_reason=reason,
        blocked_at=datetime.utcnow().isoformat(),
        **(extra or {}),
    )
    meta["quality_state"] = validation_status
    work_item.validation_status = validation_status
    work_item.validation_comment = reason
    if validation_status == WorkItem.VALIDATION_DISPUTED:
        work_item.review_status = "disputed"
        work_item.review_required = False
    work_item.save()


def _next_queue_position(project: Project) -> int:
    last_assignment = Assignment.objects(project=project).order_by("-queue_position").first()
    return int(last_assignment.queue_position or 0) + 1 if last_assignment else 0


def _batch_work_items(project: Project, task_batch_id: str) -> List[WorkItem]:
    items = [
        item
        for item in WorkItem.objects(project=project)
        if (item.workflow_meta or {}).get("task_batch_id") == task_batch_id
    ]
    return sorted(
        items,
        key=lambda item: (
            int((item.workflow_meta or {}).get("task_batch_number") or 0),
            int((item.workflow_meta or {}).get("task_batch_index") or 0),
            int(item.frame.frame_number or 0),
        ),
    )


def _work_item_payload(work_item: WorkItem, assignment: Optional[Assignment] = None) -> dict:
    frame = work_item.frame
    final_boxes = _normalize_boxes(work_item.final_annotation)
    return {
        "work_item_id": str(work_item.id),
        "frame_id": str(frame.id),
        "frame_url": frame.frame_uri,
        "frame_number": frame.frame_number,
        "timestamp_sec": frame.timestamp_sec,
        "width": frame.width,
        "height": frame.height,
        "status": work_item.status,
        "assignment_id": str(assignment.id) if assignment else None,
        "assignment_status": assignment.status if assignment else None,
        "queue_position": assignment.queue_position if assignment else None,
        "workflow_meta": work_item.workflow_meta or {},
        "agreement_score": float(work_item.agreement_score or 0.0),
        "final_annotation": {"boxes": final_boxes},
        "final_box_count": len(final_boxes),
        "video_qc": work_item.video_qc or {},
        "validation_status": work_item.validation_status or WorkItem.VALIDATION_PENDING,
        "validation_comment": work_item.validation_comment or "",
        "quality_state": (work_item.workflow_meta or {}).get("quality_state") or work_item.validation_status or WorkItem.VALIDATION_PENDING,
        "blocked_reason": (work_item.workflow_meta or {}).get("blocked_reason") or "",
    }


def annotator_batch_payload(project: Project, annotator: User, current_assignment: Assignment) -> dict:
    task_batch_id = str((current_assignment.work_item.workflow_meta or {}).get("task_batch_id") or "").strip()
    if not task_batch_id:
        return {"task_batch_id": "", "items": [], "current_index": 0, "total": 0}
    batch_items = _batch_work_items(project, task_batch_id)
    assignments = {
        str(item.work_item.id): item
        for item in Assignment.objects(project=project, annotator=annotator, work_item__in=batch_items)
    }
    items_payload = []
    current_index = 0
    for index, work_item in enumerate(batch_items, start=1):
        assignment = assignments.get(str(work_item.id))
        payload = _work_item_payload(work_item, assignment=assignment)
        items_payload.append(payload)
        if assignment and str(assignment.id) == str(current_assignment.id):
            current_index = index
    return {
        "task_batch_id": task_batch_id,
        "batch_number": int((current_assignment.work_item.workflow_meta or {}).get("task_batch_number") or 0),
        "total_batches": int((current_assignment.work_item.workflow_meta or {}).get("task_batch_total") or 0),
        "current_index": current_index,
        "total": len(items_payload),
        "items": items_payload,
    }


def validation_queue(projects: List[Project]) -> List[dict]:
    items: List[dict] = []
    for project in projects:
        work_items = list(WorkItem.objects(project=project))
        batch_ids = sorted({str(item.workflow_meta.get("task_batch_id") or "") for item in work_items if item.workflow_meta.get("task_batch_id")})
        for batch_id in batch_ids:
            batch_items = _batch_work_items(project, batch_id)
            if not batch_items:
                continue
            ready_items = [item for item in batch_items if item.status == WorkItem.STATUS_COMPLETED]
            if len(ready_items) != len(batch_items):
                continue
            has_pending = any(item.validation_status != WorkItem.VALIDATION_APPROVED for item in batch_items)
            if not has_pending:
                continue
            needs_changes = sum(1 for item in batch_items if item.validation_status == WorkItem.VALIDATION_NEEDS_CHANGES)
            flagged_items = sum(1 for item in batch_items if (item.video_qc or {}).get("flag_for_review"))
            items.append(
                {
                    "project_id": str(project.id),
                    "project_title": project.title,
                    "task_batch_id": batch_id,
                    "batch_number": int((batch_items[0].workflow_meta or {}).get("task_batch_number") or 0),
                    "frames_total": len(batch_items),
                    "approved_frames": sum(1 for item in batch_items if item.validation_status == WorkItem.VALIDATION_APPROVED),
                    "needs_changes_frames": needs_changes,
                    "flagged_frames": flagged_items,
                    "average_agreement": round(sum(float(item.agreement_score or 0.0) for item in batch_items) / len(batch_items), 4),
                    "validation_status": "needs_changes" if needs_changes else "pending",
                }
            )
    items.sort(key=lambda item: (item["project_title"], item["batch_number"]))
    return items


def validation_batch_detail(project: Project, task_batch_id: str) -> dict:
    batch_items = _batch_work_items(project, task_batch_id)
    return {
        "project_id": str(project.id),
        "project_title": project.title,
        "task_batch_id": task_batch_id,
        "batch_number": int((batch_items[0].workflow_meta or {}).get("task_batch_number") or 0) if batch_items else 0,
        "frames_total": len(batch_items),
        "items": [_work_item_payload(item) for item in batch_items],
        "all_approved": all(item.validation_status == WorkItem.VALIDATION_APPROVED for item in batch_items) if batch_items else False,
    }


def build_import_preview(import_session: ImportSession) -> dict:
    assets = list(ImportAsset.objects(import_session=import_session))
    processed = [asset for asset in assets if asset.processing_status == ImportAsset.STATUS_PROCESSED]
    failed = [asset for asset in assets if asset.processing_status == ImportAsset.STATUS_FAILED]
    preview_frames = list(FrameItem.objects(project=import_session.project, asset__in=[asset.id for asset in processed]).limit(5))
    return {
        "assets_total": len(assets),
        "assets_processed": len(processed),
        "assets_failed": len(failed),
        "frames_total": sum(asset.frame_count for asset in processed),
        "errors": [asset.error_message for asset in failed if asset.error_message],
        "sample_frames": [frame.frame_uri for frame in preview_frames],
        "cleanup": import_session.summary.get("cleanup", {}) if isinstance(import_session.summary, dict) else {},
        "ffmpeg": ffmpeg_diagnostics(),
    }


def process_import_asset(asset: ImportAsset, interval_sec: float) -> ImportAsset:
    try:
        if asset.asset_type == ImportAsset.TYPE_IMAGE:
            dims = image_dimensions(asset.file_uri)
            FrameItem.objects(project=asset.project, asset=asset).delete()
            FrameItem(
                project=asset.project,
                asset=asset,
                frame_uri=asset.file_uri,
                frame_number=0,
                timestamp_sec=0.0,
                width=dims["width"],
                height=dims["height"],
            ).save()
            asset.frame_count = 1
            asset.metadata = dims
        else:
            FrameItem.objects(project=asset.project, asset=asset).delete()
            extracted = extract_video_frames(asset.file_uri, str(asset.project.id), str(asset.import_session.id), interval_sec)
            for frame in extracted:
                FrameItem(project=asset.project, asset=asset, **frame).save()
            asset.frame_count = len(extracted)
            asset.metadata = {
                "frame_interval_sec": interval_sec,
                "video_frames_extracted": len(extracted),
            }
            asset.metadata["intervals"] = {"created": 0, "updated": 0, "intervals_total": 0, "mode": "manual_executor_stage"}
            asset.metadata["chunk_tasks"] = (
                create_video_chunk_tasks_for_asset(asset)
                if _is_task(asset.project, TASK_VIDEO_ANNOTATION)
                else {"tasks_created": 0, "assignments_created": 0, "skipped_for_task_type": _task_type(asset.project)}
            )
        asset.processing_status = ImportAsset.STATUS_PROCESSED
        asset.error_message = ""
    except FrameExtractionError as exc:
        asset.processing_status = ImportAsset.STATUS_FAILED
        asset.error_message = f"Frame extraction failed: {exc}"
        asset.frame_count = 0
        asset.metadata = {"frame_interval_sec": interval_sec, "failed_stage": "frame_extraction"}
    except Exception as exc:
        asset.processing_status = ImportAsset.STATUS_FAILED
        asset.error_message = str(exc)
        asset.frame_count = 0
    asset.save()
    cleanup = _cleanup_processed_asset(asset)
    if cleanup:
        asset.metadata = {**(asset.metadata or {}), "cleanup": cleanup}
        asset.save()
    return asset


def _interval_seconds(frame: FrameItem) -> float:
    return float(frame.timestamp_sec or 0.0)


def generate_auto_intervals_for_asset(asset: ImportAsset, created_by: User | None = None) -> dict:
    if asset.asset_type != ImportAsset.TYPE_VIDEO:
        return {"created": 0, "updated": 0, "intervals_total": 0}
    frames = list(FrameItem.objects(project=asset.project, asset=asset).order_by("frame_number"))
    if not frames:
        return {"created": 0, "updated": 0, "intervals_total": 0}
    # Simple heuristic baseline: split the video into "object candidate" windows.
    # These drafts are always editable by humans on interval stage.
    segment_size = 20
    candidate_spans = []
    for start in range(0, len(frames), segment_size):
        end = min(start + segment_size - 1, len(frames) - 1)
        if (start // segment_size) % 2 == 0:
            candidate_spans.append((start, end))
    created = 0
    updated = 0
    existing = list(VideoInterval.objects(project=asset.project, asset=asset, source=VideoInterval.SOURCE_AUTO))
    for item in existing:
        item.delete()
    for start_idx, end_idx in candidate_spans:
        start_frame = frames[start_idx]
        end_frame = frames[end_idx]
        VideoInterval(
            project=asset.project,
            asset=asset,
            start_frame=start_frame.frame_number,
            end_frame=end_frame.frame_number,
            start_sec=_interval_seconds(start_frame),
            end_sec=_interval_seconds(end_frame),
            status=VideoInterval.STATUS_DRAFT,
            source=VideoInterval.SOURCE_AUTO,
            confidence=0.6,
            created_by=created_by,
        ).save()
        created += 1
    return {"created": created, "updated": updated, "intervals_total": created}


def list_video_intervals(project: Project, asset: ImportAsset | None = None, status: str | None = None) -> List[VideoInterval]:
    query = {"project": project}
    if asset:
        query["asset"] = asset
    if status:
        query["status"] = status
    return list(VideoInterval.objects(**query).order_by("asset", "start_frame", "created_at"))


def upsert_video_intervals(project: Project, asset: ImportAsset, actor: User, intervals: List[dict]) -> dict:
    created = 0
    updated = 0
    for payload in intervals:
        interval_id = str(payload.get("id") or "").strip()
        interval = (
            VideoInterval.objects(id=ObjectId(interval_id), project=project, asset=asset).first()
            if interval_id
            else None
        )
        if not interval:
            interval = VideoInterval(project=project, asset=asset, created_by=actor)
            created += 1
        else:
            updated += 1
        interval.start_frame = int(payload["start_frame"])
        interval.end_frame = int(payload["end_frame"])
        frame_start = FrameItem.objects(project=project, asset=asset, frame_number=interval.start_frame).first()
        frame_end = FrameItem.objects(project=project, asset=asset, frame_number=interval.end_frame).first()
        interval.start_sec = _interval_seconds(frame_start) if frame_start else 0.0
        interval.end_sec = _interval_seconds(frame_end) if frame_end else interval.start_sec
        interval.source = str(payload.get("source") or VideoInterval.SOURCE_MANUAL)
        interval.confidence = float(payload.get("confidence") or 0.0)
        interval.metadata = payload.get("metadata") or {}
        interval.status = VideoInterval.STATUS_DRAFT
        interval.validated_at = None
        interval.validated_by = None
        interval.save()
    return {"created": created, "updated": updated}


def validate_video_intervals(project: Project, actor: User, interval_ids: List[str], decision: str, comment: str = "") -> dict:
    updated = 0
    for interval in VideoInterval.objects(project=project, id__in=[ObjectId(item) for item in interval_ids]):
        interval.status = decision
        interval.validated_by = actor
        interval.validated_at = datetime.utcnow()
        interval.metadata = {**(interval.metadata or {}), "validation_comment": comment}
        interval.save()
        updated += 1
    return {"updated": updated, "decision": decision}


def _path_to_media_uri(path: Path) -> str:
    try:
        relative = path.resolve().relative_to(MEDIA_ROOT.resolve())
    except Exception:
        relative = path.name
    if isinstance(relative, Path):
        return "/media/" + relative.as_posix()
    return f"/media/{relative}"


def _ensure_interval_review_clip(interval: VideoInterval, padding_sec: float | None = None) -> dict:
    padding = max(0.0, float(padding_sec if padding_sec is not None else workflow_runtime_settings(interval.project)["interval_review_padding_sec"]))
    source_path = absolute_media_path(interval.asset.file_uri)
    if not source_path.exists():
        return {"ready": False, "reason": "source_missing"}

    start_sec = max(0.0, float(interval.start_sec or 0.0) - padding)
    end_sec = max(start_sec + 0.5, float(interval.end_sec or interval.start_sec or 0.0) + padding)
    duration_sec = max(0.5, end_sec - start_sec)

    metadata = interval.metadata or {}
    clip_meta = metadata.get("review_clip") if isinstance(metadata.get("review_clip"), dict) else {}
    clip_uri = str(clip_meta.get("clip_uri") or "").strip()
    if clip_uri:
        clip_path = absolute_media_path(clip_uri)
        if clip_path.exists():
            return {
                "ready": True,
                "clip_uri": clip_uri,
                "start_sec": float(clip_meta.get("start_sec") or start_sec),
                "end_sec": float(clip_meta.get("end_sec") or end_sec),
                "duration_sec": float(clip_meta.get("duration_sec") or duration_sec),
                "padding_sec": padding,
            }

    clip_dir = source_path.parent / "review_clips"
    clip_dir.mkdir(parents=True, exist_ok=True)
    clip_name = f"interval_{str(interval.id)}_{int(start_sec * 1000)}_{int(end_sec * 1000)}.mp4"
    clip_path = clip_dir / clip_name
    if not clip_path.exists():
        try:
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{start_sec:.3f}",
                    "-i",
                    str(source_path),
                    "-t",
                    f"{duration_sec:.3f}",
                    "-an",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    "28",
                    "-movflags",
                    "+faststart",
                    "-y",
                    str(clip_path),
                ],
                capture_output=True,
                text=True,
                timeout=600,
            )
        except FileNotFoundError:
            return {"ready": False, "reason": "ffmpeg_unavailable"}
        except subprocess.TimeoutExpired:
            return {"ready": False, "reason": "ffmpeg_timeout"}
        if result.returncode != 0:
            return {"ready": False, "reason": result.stderr.strip() or "clip_generation_failed"}

    clip_uri = _path_to_media_uri(clip_path)
    interval.metadata = {
        **metadata,
        "review_clip": {
            "clip_uri": clip_uri,
            "start_sec": round(start_sec, 3),
            "end_sec": round(end_sec, 3),
            "duration_sec": round(duration_sec, 3),
            "padding_sec": round(padding, 3),
            "generated_at": datetime.utcnow().isoformat(),
        },
    }
    interval.save()
    return {
        "ready": True,
        "clip_uri": clip_uri,
        "start_sec": round(start_sec, 3),
        "end_sec": round(end_sec, 3),
        "duration_sec": round(duration_sec, 3),
        "padding_sec": round(padding, 3),
    }


def _recover_stuck_assignments(project: Project) -> int:
    ttl_minutes = workflow_runtime_settings(project)["stuck_assignment_ttl_minutes"]
    stale_before = datetime.utcnow() - timedelta(minutes=ttl_minutes)
    recovered = 0
    for assignment in Assignment.objects(project=project, status__in=[Assignment.STATUS_IN_PROGRESS, Assignment.STATUS_DRAFT], updated_at__lt=stale_before):
        assignment.status = Assignment.STATUS_ASSIGNED
        assignment.started_at = None
        assignment.submitted_at = None
        assignment.quality_signals = {
            **(assignment.quality_signals or {}),
            "recovered_at": datetime.utcnow().isoformat(),
            "recovery_reason": "stale_assignment",
        }
        assignment.save()
        log_security_event(
            project=project,
            event_type=SecurityEvent.EVENT_ASSIGNMENT_RECOVERED,
            payload={"assignment_id": str(assignment.id), "ttl_minutes": ttl_minutes},
            severity="warning",
        )
        recovered += 1
    return recovered


def _video_chunk_size_frames(asset: ImportAsset, frames: List[FrameItem], chunk_size_frames: int | None = None) -> Tuple[int, int]:
    if chunk_size_frames:
        return max(1, int(chunk_size_frames)), 0
    settings = workflow_runtime_settings(asset.project)
    min_sec = int(settings["video_chunk_min_duration_sec"])
    max_sec = max(min_sec, int(settings["video_chunk_max_duration_sec"]))
    target_sec = min(max(int(settings["video_chunk_duration_sec"]), min_sec), max_sec)
    frame_interval = float((asset.metadata or {}).get("frame_interval_sec") or asset.project.frame_interval_sec or 1.0)
    if frame_interval <= 0:
        frame_interval = 1.0
    return max(1, round(target_sec / frame_interval)), target_sec


def create_video_chunk_tasks_for_asset(asset: ImportAsset, chunk_size_frames: int | None = None) -> dict:
    if not _is_task(asset.project, TASK_VIDEO_ANNOTATION):
        return {"tasks_created": 0, "assignments_created": 0, "skipped_for_task_type": _task_type(asset.project)}
    if asset.asset_type != ImportAsset.TYPE_VIDEO:
        return {"tasks_created": 0, "assignments_created": 0}
    project = asset.project
    frames = list(FrameItem.objects(project=project, asset=asset).order_by("frame_number"))
    if not frames:
        return {"tasks_created": 0, "assignments_created": 0}
    chunk_size_frames, chunk_duration_sec = _video_chunk_size_frames(asset, frames, chunk_size_frames=chunk_size_frames)
    existing = list(VideoChunkTask.objects(project=project, asset=asset))
    for task in existing:
        assignments = list(VideoChunkAssignment.objects(task=task))
        if assignments:
            VideoChunkAnnotation.objects(assignment__in=assignments).delete()
            VideoChunkAssignment.objects(id__in=[item.id for item in assignments]).delete()
        task.delete()
    tasks_created = 0
    assignments_created = 0
    required_annotations = workflow_runtime_settings(project)["interval_annotators_per_chunk"]
    annotators = select_annotators_for_project(project, required_annotations, stage="interval_annotation")
    for chunk_index, start in enumerate(range(0, len(frames), chunk_size_frames)):
        end = min(start + chunk_size_frames - 1, len(frames) - 1)
        task = VideoChunkTask(
            project=project,
            asset=asset,
            chunk_index=chunk_index,
            start_frame=int(frames[start].frame_number),
            end_frame=int(frames[end].frame_number),
            required_annotations=required_annotations,
        )
        task.save()
        tasks_created += 1
        for annotator in annotators[:required_annotations]:
            VideoChunkAssignment(task=task, project=project, annotator=annotator).save()
            assignments_created += 1
    return {
        "tasks_created": tasks_created,
        "assignments_created": assignments_created,
        "chunk_size_frames": chunk_size_frames,
        "target_duration_sec": chunk_duration_sec,
    }


def annotator_interval_chunk_queue(annotator: User) -> List[dict]:
    assignments = list(
        VideoChunkAssignment.objects(
            annotator=annotator,
            status__in=[VideoChunkAssignment.STATUS_ASSIGNED, VideoChunkAssignment.STATUS_IN_PROGRESS],
        ).order_by("created_at")
    )
    return [
        {
            "assignment_id": str(item.id),
            "task_id": str(item.task.id),
            "project_id": str(item.project.id),
            "project_title": item.project.title,
            "asset_id": str(item.task.asset.id),
            "asset_uri": item.task.asset.file_uri,
            "start_frame": item.task.start_frame,
            "end_frame": item.task.end_frame,
            "duration_sec": max(0.0, (float(item.task.end_frame) - float(item.task.start_frame)) * float(item.project.frame_interval_sec or 1.0)),
            "frame_interval_sec": float(item.project.frame_interval_sec or 1.0),
            "status": item.status,
        }
        for item in assignments
    ]


def submit_interval_chunk_assignment(assignment: VideoChunkAssignment, intervals: List[dict], comment: str = "") -> dict:
    if assignment.status == VideoChunkAssignment.STATUS_ASSIGNED:
        assignment.status = VideoChunkAssignment.STATUS_IN_PROGRESS
    assignment.save()
    annotation = VideoChunkAnnotation.objects(assignment=assignment).first()
    if not annotation:
        annotation = VideoChunkAnnotation(assignment=assignment)
    annotation.intervals = intervals
    annotation.comment = comment
    annotation.status = VideoChunkAnnotation.STATUS_SUBMITTED
    annotation.save()
    assignment.status = VideoChunkAssignment.STATUS_SUBMITTED
    assignment.save()
    previous_intervals = [
        interval
        for interval in VideoInterval.objects(project=assignment.project, asset=assignment.task.asset)
        if (interval.metadata or {}).get("chunk_assignment_id") == str(assignment.id)
    ]
    for interval in previous_intervals:
        interval.delete()
    created_intervals = 0
    for entry in intervals:
        raw_start = int(entry["start_frame"])
        raw_end = int(entry["end_frame"])
        start_frame = min(max(min(raw_start, raw_end), int(assignment.task.start_frame)), int(assignment.task.end_frame))
        end_frame = min(max(max(raw_start, raw_end), int(assignment.task.start_frame)), int(assignment.task.end_frame))
        if end_frame < start_frame:
            continue
        start_obj = FrameItem.objects(project=assignment.project, asset=assignment.task.asset, frame_number=start_frame).first()
        end_obj = FrameItem.objects(project=assignment.project, asset=assignment.task.asset, frame_number=end_frame).first()
        interval = VideoInterval(
            project=assignment.project,
            asset=assignment.task.asset,
            start_frame=start_frame,
            end_frame=end_frame,
            start_sec=float(start_obj.timestamp_sec if start_obj else 0.0),
            end_sec=float(end_obj.timestamp_sec if end_obj else 0.0),
            status=VideoInterval.STATUS_DRAFT,
            source=VideoInterval.SOURCE_MANUAL,
            confidence=float(entry.get("confidence") or 0.0),
            metadata={"chunk_task_id": str(assignment.task.id), "chunk_assignment_id": str(assignment.id)},
            created_by=assignment.annotator,
        )
        interval.save()
        created_intervals += 1
    submitted_count = VideoChunkAssignment.objects(task=assignment.task, status=VideoChunkAssignment.STATUS_SUBMITTED).count()
    assignment.task.status = (
        VideoChunkTask.STATUS_COMPLETED
        if submitted_count >= int(assignment.task.required_annotations or 1)
        else VideoChunkTask.STATUS_IN_PROGRESS
    )
    assignment.task.save()
    return {"annotation_id": str(annotation.id), "intervals_created": created_intervals}


def _required_interval_validation_votes(interval: VideoInterval, min_validators: int | None = None) -> int:
    if not interval.created_by:
        return 0
    configured = min_validators or workflow_runtime_settings(interval.project)["interval_validators_per_item"]
    candidates = [
        user
        for user in select_annotators_for_project(interval.project, 50, stage="interval_validation")
        if str(user.id) != str(interval.created_by.id)
    ]
    return min(configured, len(candidates))


def _mark_interval_blocked(interval: VideoInterval, status: str, reason: str, extra: Optional[dict] = None) -> None:
    interval.status = status
    interval.validated_at = datetime.utcnow()
    interval.metadata = {
        **(interval.metadata or {}),
        "validation_final_status": status,
        "validation_blocked_reason": reason,
        "validation_blocked_at": datetime.utcnow().isoformat(),
        **(extra or {}),
    }
    interval.save()


def _create_extra_interval_validation_assignment(interval: VideoInterval) -> int:
    existing_validator_ids = {
        str(item.validator.id)
        for item in IntervalValidationAssignment.objects(interval=interval)
    }
    candidates = [
        user
        for user in select_annotators_for_project(interval.project, 50, stage="interval_validation")
        if str(user.id) != str(interval.created_by.id if interval.created_by else "")
        and str(user.id) not in existing_validator_ids
    ]
    if not candidates:
        return 0
    IntervalValidationAssignment(interval=interval, project=interval.project, validator=candidates[0]).save()
    return 1


def _finalize_interval_if_ready(interval: VideoInterval, min_validators: int | None = None) -> bool:
    if not interval.created_by or interval.status != VideoInterval.STATUS_DRAFT:
        return False
    required_validators = _required_interval_validation_votes(interval, min_validators=min_validators)
    if required_validators <= 0:
        _mark_interval_blocked(
            interval,
            VideoInterval.STATUS_INSUFFICIENT_VALIDATORS,
            "No independent validators are available for this interval",
            {"validation_required_votes": 0},
        )
        return True
    votes = list(IntervalValidationAssignment.objects(interval=interval, status=IntervalValidationAssignment.STATUS_SUBMITTED))
    if len(votes) < required_validators:
        return False
    approvals = sum(1 for vote in votes if vote.decision == VideoInterval.STATUS_APPROVED)
    rejects = len(votes) - approvals
    agreement = round(max(approvals, rejects) / len(votes), 4) if votes else 0.0
    threshold = float(interval.project.agreement_threshold or 0.0)
    conflict = approvals == rejects or agreement < threshold
    if conflict:
        settings = workflow_runtime_settings(interval.project)
        rounds = int((interval.metadata or {}).get("validation_reannotation_rounds") or 0)
        if rounds < settings["max_reannotation_rounds"]:
            created = _create_extra_interval_validation_assignment(interval)
            if created:
                interval.metadata = {
                    **(interval.metadata or {}),
                    "validation_votes": len(votes),
                    "validation_required_votes": required_validators + created,
                    "validation_approved": approvals,
                    "validation_rejected": rejects,
                    "validation_agreement": agreement,
                    "validation_reannotation_rounds": rounds + 1,
                    "validation_final_status": "needs_more_votes",
                }
                interval.save()
                return False
        _mark_interval_blocked(
            interval,
            VideoInterval.STATUS_DISPUTED,
            "Interval validation did not reach consensus",
            {
                "validation_votes": len(votes),
                "validation_required_votes": required_validators,
                "validation_approved": approvals,
                "validation_rejected": rejects,
                "validation_agreement": agreement,
                "validation_reannotation_rounds": rounds,
            },
        )
        return True
    interval.status = VideoInterval.STATUS_APPROVED if approvals > rejects else VideoInterval.STATUS_REJECTED
    interval.validated_at = datetime.utcnow()
    interval.metadata = {
        **(interval.metadata or {}),
        "validation_votes": len(votes),
        "validation_required_votes": required_validators,
        "validation_approved": approvals,
        "validation_rejected": rejects,
        "validation_agreement": agreement,
        "validation_final_status": interval.status,
    }
    interval.save()
    if interval.status == VideoInterval.STATUS_APPROVED and _is_task(interval.project, TASK_BBOX_ANNOTATION):
        _create_work_items_from_approved_interval(interval)
    return True


def ensure_interval_validation_assignments(project: Project, min_validators: int | None = None) -> int:
    if not _is_task(project, TASK_VIDEO_INTERVAL_VALIDATION):
        return 0
    # NOTE: Fixed issue where intervals could become locked after first annotator.
    # We now consider intervals regardless of current status, ensuring they are
    # available for validation until the required number of validators is met.
    created = 0
    required_validators = min_validators or workflow_runtime_settings(project)["interval_validators_per_item"]
    intervals = list(VideoInterval.objects(project=project))
    for interval in intervals:
        if not interval.created_by:
            continue
        _finalize_interval_if_ready(interval, min_validators=required_validators)
        if interval.status != VideoInterval.STATUS_DRAFT:
            continue
        effective_required = _required_interval_validation_votes(interval, min_validators=required_validators)
        existing = list(IntervalValidationAssignment.objects(interval=interval))
        existing_validator_ids = {str(item.validator.id) for item in existing}
        candidates = [
            user
            for user in select_annotators_for_project(project, max(10, effective_required * 3), stage="interval_validation")
            if str(user.id) != str(interval.created_by.id if interval.created_by else "")
            and str(user.id) not in existing_validator_ids
        ]
        for validator in candidates[: max(0, effective_required - len(existing))]:
            IntervalValidationAssignment(interval=interval, project=project, validator=validator).save()
            created += 1
    return created


def validator_interval_queue(validator: User) -> List[dict]:
    assignments = [
        assignment
        for assignment in IntervalValidationAssignment.objects(validator=validator, status=IntervalValidationAssignment.STATUS_ASSIGNED).order_by("created_at")
        if assignment.interval.created_by and str(assignment.interval.created_by.id) != str(validator.id)
    ]
    return [
        {
            "assignment_id": str(item.id),
            "interval_id": str(item.interval.id),
            "project_id": str(item.project.id),
            "project_title": item.project.title,
            "asset_id": str(item.interval.asset.id),
            "asset_uri": item.interval.asset.file_uri,
            "clip": _ensure_interval_review_clip(item.interval, padding_sec=workflow_runtime_settings(item.project)["interval_review_padding_sec"]),
            "start_frame": item.interval.start_frame,
            "end_frame": item.interval.end_frame,
            "start_sec": float(item.interval.start_sec or 0.0),
            "end_sec": float(item.interval.end_sec or 0.0),
            "duration_sec": max(0.0, float(item.interval.end_sec or 0.0) - float(item.interval.start_sec or 0.0)),
            "frame_interval_sec": float(item.project.frame_interval_sec or 1.0),
            "status": item.status,
        }
        for item in assignments
    ]


def submit_interval_validation(assignment: IntervalValidationAssignment, decision: str, comment: str = "", min_validators: int | None = None) -> dict:
    required_validators = _required_interval_validation_votes(assignment.interval, min_validators=min_validators)
    if not assignment.interval.created_by:
        assignment.status = IntervalValidationAssignment.STATUS_SUBMITTED
        assignment.comment = "Skipped auto interval without human author"
        assignment.save()
        return {"assignment_id": str(assignment.id), "interval_status": assignment.interval.status, "skipped": True}
    if str(assignment.interval.created_by.id) == str(assignment.validator.id):
        raise PermissionError("Annotator cannot validate their own interval annotation")
    assignment.decision = decision
    assignment.comment = comment
    assignment.status = IntervalValidationAssignment.STATUS_SUBMITTED
    assignment.save()
    interval = assignment.interval
    votes = list(IntervalValidationAssignment.objects(interval=interval, status=IntervalValidationAssignment.STATUS_SUBMITTED))
    _finalize_interval_if_ready(interval, min_validators=min_validators)
    return {
        "assignment_id": str(assignment.id),
        "interval_status": interval.status,
        "votes": len(votes),
        "required_votes": required_validators,
    }


def _create_work_items_from_approved_interval(interval: VideoInterval) -> int:
    project = interval.project
    asset = interval.asset
    created = 0
    queue_position = _next_queue_position(project)
    frames = list(
        FrameItem.objects(project=project, asset=asset, frame_number__gte=interval.start_frame, frame_number__lte=interval.end_frame).order_by("frame_number")
    )
    batch_entries = _build_asset_batches(asset, frames, project)
    required_assignments = max(1, int(project.assignments_per_task or 1))
    candidate_annotators = select_annotators_for_project(project, max(required_assignments, 50), stage="bbox_annotation")
    local_assignment_counts = {str(user.id): 0 for user in candidate_annotators}
    for entry in batch_entries:
        frame = entry["frame"]
        workflow_meta = entry["workflow_meta"]
        work_item = WorkItem.objects(project=project, frame=frame).first()
        if not work_item:
            work_item = WorkItem(project=project, frame=frame, workflow_meta=workflow_meta)
            work_item.validation_status = WorkItem.VALIDATION_PENDING
            work_item.save()
            created += 1
        existing_annotators = {str(a.annotator.id) for a in Assignment.objects(work_item=work_item)}
        next_order = Assignment.objects(work_item=work_item).count()
        selected_annotators = sorted(
            [user for user in candidate_annotators if str(user.id) not in existing_annotators],
            key=lambda user: (local_assignment_counts.get(str(user.id), 0), str(user.id)),
        )[: max(0, required_assignments - len(existing_annotators))]
        if len(existing_annotators) + len(selected_annotators) < required_assignments:
            _mark_work_item_validation_blocked(
                work_item,
                WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS,
                "Not enough independent annotators are available for bbox annotation",
                {
                    "required_assignments": required_assignments,
                    "available_assignments": len(existing_annotators) + len(selected_annotators),
                },
            )
        for annotator in selected_annotators:
            if str(annotator.id) in existing_annotators:
                continue
            Assignment(
                project=project,
                work_item=work_item,
                annotator=annotator,
                order_index=next_order,
                queue_position=queue_position,
                status=Assignment.STATUS_ASSIGNED,
            ).save()
            local_assignment_counts[str(annotator.id)] = local_assignment_counts.get(str(annotator.id), 0) + 1
            next_order += 1
            queue_position += 1
    return created


def _file_sha256(file_uri: str) -> str:
    path = absolute_media_path(file_uri)
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _cleanup_processed_asset(asset: ImportAsset) -> dict:
    removed_duplicates = 0
    removed_invalid_frames = 0
    duplicate_of_asset_id = ""
    duplicate = (
        ImportAsset.objects(
            project=asset.project,
            processing_status=ImportAsset.STATUS_PROCESSED,
            id__ne=asset.id,
            file_size=asset.file_size,
            file_name=asset.file_name,
        )
        .first()
    )
    current_hash = ""
    try:
        current_hash = _file_sha256(asset.file_uri)
    except Exception:
        current_hash = ""
    if duplicate:
        duplicate_hash = duplicate.metadata.get("sha256", "")
        if not duplicate_hash:
            try:
                duplicate_hash = _file_sha256(duplicate.file_uri)
            except Exception:
                duplicate_hash = ""
        if current_hash and duplicate_hash and current_hash == duplicate_hash:
            duplicate_of_asset_id = str(duplicate.id)
            FrameItem.objects(project=asset.project, asset=asset).delete()
            removed_duplicates = asset.frame_count
            asset.processing_status = ImportAsset.STATUS_FAILED
            asset.error_message = f"Duplicate asset detected (same content as {duplicate_of_asset_id})"
            asset.frame_count = 0
    valid_frames = []
    for frame in FrameItem.objects(project=asset.project, asset=asset):
        if frame.width <= 0 or frame.height <= 0:
            frame.delete()
            removed_invalid_frames += 1
            continue
        valid_frames.append(frame)
    if asset.processing_status == ImportAsset.STATUS_PROCESSED:
        asset.frame_count = len(valid_frames)
    metadata = asset.metadata or {}
    if current_hash:
        metadata["sha256"] = current_hash
    cleanup = {
        "removed_duplicates": removed_duplicates,
        "removed_invalid_frames": removed_invalid_frames,
        "duplicate_of_asset_id": duplicate_of_asset_id,
    }
    metadata["cleanup"] = cleanup
    asset.metadata = metadata
    asset.save()
    if removed_duplicates or removed_invalid_frames:
        log_security_event(
            project=asset.project,
            event_type=SecurityEvent.EVENT_IMPORT_CLEANUP,
            payload={"asset_id": str(asset.id), **cleanup},
            severity="warning" if removed_duplicates else "info",
        )
    return cleanup


def _stage_pool_user_ids(project: Project, stage: str | None) -> set[str]:
    if not stage:
        return set()
    rules = project.participant_rules or {}
    stage_pools = rules.get("stage_pools") if isinstance(rules.get("stage_pools"), dict) else {}
    raw_pool = stage_pools.get(stage) or rules.get(f"{stage}_user_ids") or rules.get(f"{stage}_annotator_ids") or []
    if isinstance(raw_pool, str):
        raw_pool = [item.strip() for item in raw_pool.split(",")]
    if not isinstance(raw_pool, list):
        return set()
    return {str(item).strip() for item in raw_pool if str(item).strip()}


def select_annotators_for_project(project: Project, limit: int, stage: str | None = None) -> List[User]:
    membership_qs = ProjectMembership.objects(project=project, role=ProjectMembership.ROLE_ANNOTATOR, is_active=True)
    memberships = list(membership_qs)
    allowed_ids = {str(user.id) for user in (project.allowed_annotators or [])}
    stage_pool_ids = _stage_pool_user_ids(project, stage)
    rules = project.participant_rules or {}
    assignment_scope = str(rules.get("assignment_scope") or "selected_only").strip().lower()
    required_specialization = str(rules.get("specialization") or "").strip().lower()
    required_group = str(rules.get("group") or "").strip().lower()

    if allowed_ids and assignment_scope != "all":
        memberships = [membership for membership in memberships if str(membership.user.id) in allowed_ids]

    if stage_pool_ids:
        memberships = [membership for membership in memberships if str(membership.user.id) in stage_pool_ids]

    if not memberships and allowed_ids:
        allowed_users = list(User.objects(id__in=list(allowed_ids), role=User.ROLE_ANNOTATOR, is_active=True))
        memberships = []
        for user in allowed_users:
            membership = ProjectMembership.objects(
                project=project,
                user=user,
                role=ProjectMembership.ROLE_ANNOTATOR,
            ).first()
            if not membership:
                membership = ProjectMembership(
                    project=project,
                    user=user,
                    role=ProjectMembership.ROLE_ANNOTATOR,
                )
            membership.is_active = True
            membership.specialization = user.specialization
            membership.group_name = user.group_name
            membership.save()
            memberships.append(membership)

    if not memberships and stage_pool_ids:
        stage_users = list(User.objects(id__in=list(stage_pool_ids), role=User.ROLE_ANNOTATOR, is_active=True))
        memberships = []
        for user in stage_users:
            membership = ProjectMembership.objects(project=project, user=user, role=ProjectMembership.ROLE_ANNOTATOR).first()
            if not membership:
                membership = ProjectMembership(project=project, user=user, role=ProjectMembership.ROLE_ANNOTATOR)
            membership.is_active = True
            membership.specialization = user.specialization
            membership.group_name = user.group_name
            membership.save()
            memberships.append(membership)

    if not memberships and assignment_scope == "all":
        fallback = list(User.objects(role=User.ROLE_ANNOTATOR, is_active=True))
        memberships = [
            ProjectMembership(
                project=project,
                user=user,
                role=ProjectMembership.ROLE_ANNOTATOR,
                is_active=True,
                specialization=user.specialization,
                group_name=user.group_name,
            )
            for user in fallback
        ]

    if required_group and assignment_scope == "group_only":
        memberships = [membership for membership in memberships if membership.group_name.lower() == required_group]

    if assignment_scope == "selected_only" and allowed_ids:
        memberships = [membership for membership in memberships if str(membership.user.id) in allowed_ids]

    if stage_pool_ids:
        memberships = [membership for membership in memberships if str(membership.user.id) in stage_pool_ids]

    def open_load(user: User) -> int:
        return Assignment.objects(
            annotator=user,
            status__in=[Assignment.STATUS_ASSIGNED, Assignment.STATUS_IN_PROGRESS, Assignment.STATUS_DRAFT],
        ).count()

    sorted_memberships = sorted(
        memberships,
        key=lambda membership: (
            0 if not required_specialization or membership.specialization.lower() == required_specialization else 1,
            0 if not required_group or membership.group_name.lower() == required_group else 1,
            open_load(membership.user),
            -float(membership.user.rating or 0.0),
            membership.user.created_at,
        ),
    )

    picked: List[User] = []
    seen = set()
    for membership in sorted_memberships:
        user_id = str(membership.user.id)
        if user_id in seen:
            continue
        seen.add(user_id)
        picked.append(membership.user)
        if len(picked) >= limit:
            break
    return picked


def _workflow_settings(project: Project) -> dict:
    rules = project.participant_rules or {}
    task_batch_size = max(1, int(rules.get("task_batch_size") or DEFAULT_TASK_BATCH_SIZE))
    min_sequence_size = max(1, int(rules.get("min_sequence_size") or DEFAULT_MIN_SEQUENCE_SIZE))
    return {
        "task_batch_size": task_batch_size,
        "min_sequence_size": min_sequence_size,
    }


def _build_frame_batches(batch_namespace: str, frames: List[FrameItem], project: Project) -> List[dict]:
    settings = _workflow_settings(project)
    task_batch_size = settings["task_batch_size"]
    min_sequence_size = settings["min_sequence_size"]
    batches: List[dict] = []
    total_batches = (len(frames) + task_batch_size - 1) // task_batch_size if frames else 0
    for batch_number, start in enumerate(range(0, len(frames), task_batch_size), start=1):
        batch_frames = frames[start : start + task_batch_size]
        batch_id = f"{batch_namespace}:batch:{batch_number}"
        batch_size = len(batch_frames)
        for index, frame in enumerate(batch_frames, start=1):
            batches.append(
                {
                    "frame": frame,
                    "workflow_meta": {
                        "task_batch_id": batch_id,
                        "task_batch_number": batch_number,
                        "task_batch_size": batch_size,
                        "task_batch_target_size": task_batch_size,
                        "task_batch_total": total_batches,
                        "task_batch_index": index,
                        "sequence_id": batch_id,
                        "sequence_index": index,
                        "sequence_length": batch_size,
                        "min_sequence_size": min_sequence_size,
                        "validation_ready": batch_size >= min_sequence_size,
                        "asset_id": str(frame.asset.id),
                    },
                }
            )
    return batches


def _build_asset_batches(asset: ImportAsset, frames: List[FrameItem], project: Project) -> List[dict]:
    return _build_frame_batches(str(asset.id), frames, project)


def create_work_items_for_import(import_session: ImportSession) -> Dict[str, int]:
    project = import_session.project
    processed_assets = list(ImportAsset.objects(import_session=import_session, processing_status=ImportAsset.STATUS_PROCESSED))
    if not _is_task(project, TASK_BBOX_ANNOTATION):
        preview = build_import_preview(import_session)
        import_session.preview = preview
        import_session.summary = {
            "work_items_created": 0,
            "assignments_created": 0,
            "frame_ids": [],
            "workflow_batches_total": 0,
            "validation_ready_items": 0,
            "workflow_settings": _workflow_settings(project),
            "skipped_for_task_type": _task_type(project),
        }
        import_session.status = ImportSession.STATUS_FINALIZED if processed_assets else ImportSession.STATUS_FAILED
        import_session.save()
        return import_session.summary
    frame_ids = []
    created_work_items = 0
    created_assignments = 0
    validation_ready_items = 0
    queue_position = _next_queue_position(project)
    local_assignment_counts: Dict[str, int] = {}
    image_frames: List[FrameItem] = []
    batch_entries: List[dict] = []
    for asset in processed_assets:
        asset_frames = list(FrameItem.objects(project=project, asset=asset).order_by("created_at", "frame_number"))
        if asset.asset_type == ImportAsset.TYPE_IMAGE:
            image_frames.extend(asset_frames)
        else:
            batch_entries.extend(_build_asset_batches(asset, asset_frames, project))
    if image_frames:
        batch_entries.extend(_build_frame_batches(f"{import_session.id}:images", image_frames, project))

    workflow_batches_total = len({entry["workflow_meta"]["task_batch_id"] for entry in batch_entries})
    for entry in batch_entries:
        frame = entry["frame"]
        workflow_meta = entry["workflow_meta"]
        work_item = WorkItem.objects(project=project, frame=frame).first()
        if not work_item:
            work_item = WorkItem(project=project, frame=frame)
            work_item.workflow_meta = workflow_meta
            work_item.validation_status = WorkItem.VALIDATION_PENDING
            ai_enabled = bool((project.participant_rules or {}).get("ai_prelabel_enabled", False))
            if ai_enabled:
                model_name = str((project.participant_rules or {}).get("ai_model") or "baseline-box-v1")
                confidence_threshold = float((project.participant_rules or {}).get("ai_confidence_threshold") or 0.7)
                preannotation = generate_preannotation_for_frame(frame, model_name=model_name, confidence_threshold=confidence_threshold)
                work_item.pre_annotations = preannotation
                work_item.pre_annotation_model = model_name
                work_item.pre_annotation_confidence_threshold = confidence_threshold
                log_security_event(
                    project=project,
                    event_type=SecurityEvent.EVENT_PREANNOTATION,
                    payload={"frame_id": str(frame.id), "model": model_name, "threshold": confidence_threshold, "boxes": len(preannotation.get("boxes", []))},
                )
            work_item.save()
            created_work_items += 1
        else:
            work_item.workflow_meta = workflow_meta
            work_item.save()
        if workflow_meta.get("validation_ready"):
            validation_ready_items += 1
        existing_annotators = {str(assignment.annotator.id) for assignment in Assignment.objects(work_item=work_item)}
        required_assignments = max(1, int(project.assignments_per_task or 1))
        candidate_annotators = select_annotators_for_project(project, max(50, required_assignments * 3), stage="bbox_annotation")
        selected_annotators = sorted(
            [user for user in candidate_annotators if str(user.id) not in existing_annotators],
            key=lambda user: (local_assignment_counts.get(str(user.id), 0), str(user.id)),
        )[: max(0, required_assignments - len(existing_annotators))]
        if len(existing_annotators) + len(selected_annotators) < int(project.assignments_per_task or 1):
            _mark_work_item_validation_blocked(
                work_item,
                WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS,
                "Not enough independent annotators are available for bbox annotation",
                {
                    "required_assignments": int(project.assignments_per_task or 1),
                    "available_assignments": len(existing_annotators) + len(selected_annotators),
                },
            )
        next_order = Assignment.objects(work_item=work_item).count()
        for annotator in selected_annotators:
            if str(annotator.id) in existing_annotators:
                continue
            assignment = Assignment(
                project=project,
                work_item=work_item,
                annotator=annotator,
                order_index=next_order,
                queue_position=queue_position,
                status=Assignment.STATUS_ASSIGNED,
            )
            assignment.save()
            created_assignments += 1
            local_assignment_counts[str(annotator.id)] = local_assignment_counts.get(str(annotator.id), 0) + 1
            queue_position += 1
            log_security_event(
                project=project,
                event_type=SecurityEvent.EVENT_ASSIGNMENT_DISTRIBUTION,
                payload={"work_item_id": str(work_item.id), "annotator_id": str(annotator.id)},
            )
            next_order += 1
        frame_ids.append(str(frame.id))

    preview = build_import_preview(import_session)
    import_session.preview = preview
    cleanup_summary = {
        "duplicates_removed": sum(int((asset.metadata or {}).get("cleanup", {}).get("removed_duplicates", 0)) for asset in processed_assets),
        "invalid_frames_removed": sum(int((asset.metadata or {}).get("cleanup", {}).get("removed_invalid_frames", 0)) for asset in processed_assets),
        "duplicate_assets": [str(asset.id) for asset in ImportAsset.objects(import_session=import_session, processing_status=ImportAsset.STATUS_FAILED) if "Duplicate asset" in (asset.error_message or "")],
    }
    import_session.summary = {
        "work_items_created": created_work_items,
        "assignments_created": created_assignments,
        "frame_ids": frame_ids,
        "workflow_batches_total": workflow_batches_total,
        "validation_ready_items": validation_ready_items,
        "workflow_settings": _workflow_settings(project),
        "cleanup": cleanup_summary,
    }
    import_session.status = ImportSession.STATUS_FINALIZED if created_work_items or processed_assets else ImportSession.STATUS_FAILED
    import_session.save()
    return import_session.summary


def _normalize_boxes(label_data: dict) -> List[dict]:
    boxes = label_data.get("boxes", []) if isinstance(label_data, dict) else []
    normalized = []
    for raw in boxes:
        try:
            normalized.append(
                {
                    "x": float(raw["x"]),
                    "y": float(raw["y"]),
                    "width": float(raw["width"]),
                    "height": float(raw["height"]),
                    "label": str(raw["label"]),
                }
            )
        except Exception:
            continue
    return normalized


def _iou(box_a: dict, box_b: dict) -> float:
    ax1, ay1 = box_a["x"], box_a["y"]
    ax2, ay2 = ax1 + box_a["width"], ay1 + box_a["height"]
    bx1, by1 = box_b["x"], box_b["y"]
    bx2, by2 = bx1 + box_b["width"], by1 + box_b["height"]

    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    if inter_x2 <= inter_x1 or inter_y2 <= inter_y1:
        return 0.0
    intersection = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
    union = box_a["width"] * box_a["height"] + box_b["width"] * box_b["height"] - intersection
    return 0.0 if union <= 0 else intersection / union


def compare_bbox_annotations(label_a: dict, label_b: dict, iou_threshold: float) -> dict:
    boxes_a = _normalize_boxes(label_a)
    boxes_b = _normalize_boxes(label_b)
    if not boxes_a and not boxes_b:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0, "average_iou": 1.0, "quality_score": 1.0, "matches": []}

    used_b = set()
    matches = []
    tp = 0
    for index_a, box_a in enumerate(boxes_a):
        best_match = None
        best_iou = 0.0
        for index_b, box_b in enumerate(boxes_b):
            if index_b in used_b or box_a["label"] != box_b["label"]:
                continue
            iou = _iou(box_a, box_b)
            if iou >= iou_threshold and iou > best_iou:
                best_match = index_b
                best_iou = iou
        if best_match is not None:
            used_b.add(best_match)
            tp += 1
            matches.append({"a": index_a, "b": best_match, "iou": round(best_iou, 4), "label": box_a["label"]})
    fp = max(0, len(boxes_b) - tp)
    fn = max(0, len(boxes_a) - tp)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) else 0.0
    average_iou = round(sum(match["iou"] for match in matches) / len(matches), 4) if matches else 0.0
    quality_score = round(f1 * average_iou, 4) if matches else f1
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "average_iou": average_iou,
        "quality_score": quality_score,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "matches": matches,
        "count_a": len(boxes_a),
        "count_b": len(boxes_b),
    }


def _median(values: List[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / 2.0


def _box_coordinate_spread(boxes: List[dict], merged_box: dict) -> float:
    if len(boxes) <= 1:
        return 0.0
    frame_scale = max(float(merged_box.get("width") or 1.0), float(merged_box.get("height") or 1.0), 1.0)
    spreads = []
    for key in ["x", "y", "width", "height"]:
        values = [float(box[key]) for box in boxes]
        spreads.append((max(values) - min(values)) / frame_scale)
    return round(max(spreads), 4)


def _merge_cluster_boxes(boxes: List[dict], frame: FrameItem) -> dict:
    x = _median([box["x"] for box in boxes])
    y = _median([box["y"] for box in boxes])
    width = _median([box["width"] for box in boxes])
    height = _median([box["height"] for box in boxes])
    max_width = max(float(frame.width or 0), 1.0)
    max_height = max(float(frame.height or 0), 1.0)
    x = min(max(x, 0.0), max(max_width - 1.0, 0.0))
    y = min(max(y, 0.0), max(max_height - 1.0, 0.0))
    width = min(max(width, 1.0), max_width - x)
    height = min(max(height, 1.0), max_height - y)
    merged = {
        "x": round(x, 2),
        "y": round(y, 2),
        "width": round(width, 2),
        "height": round(height, 2),
        "label": boxes[0]["label"],
    }
    merged["consensus_sources"] = len(boxes)
    merged["coordinate_spread"] = _box_coordinate_spread(boxes, merged)
    return merged


def build_consensus_bbox_annotation(annotations: List[WorkAnnotation], work_item: WorkItem) -> dict:
    normalized_annotations = [
        {"annotation_id": str(annotation.id), "boxes": _normalize_boxes(annotation.label_data)}
        for annotation in annotations
    ]
    total_annotations = len(normalized_annotations)
    if total_annotations == 0:
        return {"boxes": [], "metrics": {"box_count": 0, "clusters": []}}

    min_sources = max(1, (total_annotations // 2) + 1)
    clusters: List[dict] = []
    for annotation in normalized_annotations:
        for box in annotation["boxes"]:
            best_cluster = None
            best_iou = 0.0
            for cluster in clusters:
                if cluster["label"] != box["label"]:
                    continue
                if annotation["annotation_id"] in cluster["annotation_ids"]:
                    continue
                representative = cluster["representative"]
                iou = _iou(box, representative)
                if iou >= work_item.project.iou_threshold and iou > best_iou:
                    best_cluster = cluster
                    best_iou = iou
            if best_cluster:
                best_cluster["boxes"].append(box)
                best_cluster["annotation_ids"].add(annotation["annotation_id"])
                best_cluster["representative"] = _merge_cluster_boxes(best_cluster["boxes"], work_item.frame)
            else:
                clusters.append(
                    {
                        "label": box["label"],
                        "boxes": [box],
                        "annotation_ids": {annotation["annotation_id"]},
                        "representative": _merge_cluster_boxes([box], work_item.frame),
                    }
                )

    consensus_boxes = []
    cluster_metrics = []
    spread_threshold = workflow_runtime_settings(work_item.project)["bbox_coordinate_spread_threshold"]
    for cluster in clusters:
        source_count = len(cluster["annotation_ids"])
        merged = _merge_cluster_boxes(cluster["boxes"], work_item.frame)
        pair_ious = []
        for i, box_a in enumerate(cluster["boxes"]):
            for j in range(i + 1, len(cluster["boxes"])):
                pair_ious.append(_iou(box_a, cluster["boxes"][j]))
        average_iou = round(sum(pair_ious) / len(pair_ious), 4) if pair_ious else 1.0
        rejection_reasons = []
        if source_count < min_sources:
            rejection_reasons.append("insufficient_sources")
        if average_iou < float(work_item.project.iou_threshold or 0.0):
            rejection_reasons.append("low_mean_iou")
        if float(merged["coordinate_spread"]) > spread_threshold:
            rejection_reasons.append("high_coordinate_spread")
        accepted = not rejection_reasons
        cluster_metrics.append(
            {
                "label": cluster["label"],
                "source_count": source_count,
                "required_sources": min_sources,
                "accepted": accepted,
                "coordinate_spread": merged["coordinate_spread"],
                "coordinate_spread_threshold": spread_threshold,
                "average_iou": average_iou,
                "rejection_reasons": rejection_reasons,
            }
        )
        if accepted:
            consensus_boxes.append(merged)

    consensus_boxes.sort(key=lambda box: (str(box["label"]), float(box["y"]), float(box["x"])))
    unaccepted_majority_clusters = [
        metric
        for metric in cluster_metrics
        if int(metric["source_count"]) >= min_sources and not metric["accepted"]
    ]
    return {
        "boxes": consensus_boxes,
        "metrics": {
            "box_count": len(consensus_boxes),
            "clusters": cluster_metrics,
            "required_sources_per_box": min_sources,
            "total_annotations": total_annotations,
            "unaccepted_majority_clusters": len(unaccepted_majority_clusters),
        },
    }


def _consensus_bbox_quality_score(consensus_metrics: dict) -> float:
    clusters = consensus_metrics.get("clusters") or []
    total_annotations = max(int(consensus_metrics.get("total_annotations") or 0), 1)
    if not clusters:
        return 1.0
    accepted = [cluster for cluster in clusters if cluster.get("accepted")]
    if not accepted:
        return 0.0
    accepted_scores = []
    for cluster in accepted:
        coverage = min(float(cluster.get("source_count") or 0) / total_annotations, 1.0)
        mean_iou = min(max(float(cluster.get("average_iou") or 0.0), 0.0), 1.0)
        accepted_scores.append(coverage * mean_iou)
    base_score = sum(accepted_scores) / len(accepted_scores)
    rejected_clusters = max(len(clusters) - len(accepted), 0)
    extra_penalty = rejected_clusters / len(clusters)
    return round(max(0.0, base_score * (1.0 - extra_penalty)), 4)


def _assignment_quality_signals(assignment: Assignment) -> dict:
    elapsed_sec = None
    if assignment.started_at and assignment.submitted_at:
        elapsed_sec = max(0.0, (assignment.submitted_at - assignment.started_at).total_seconds())
    return {
        "elapsed_sec": round(elapsed_sec, 3) if elapsed_sec is not None else None,
        "too_fast": bool(elapsed_sec is not None and elapsed_sec < 2.0),
    }


def update_user_quality(user: User, agreement: float, disputed: bool = False) -> None:
    completed = int(getattr(user, "completed_assignments", 0) or 0) + 1
    current_rating = float(user.rating or 0.0)
    user.rating = round(((current_rating * (completed - 1)) + agreement) / completed, 4)
    if disputed:
        previous_conflicts = float(getattr(user, "conflict_rate", 0.0) or 0.0) * (completed - 1)
        user.conflict_rate = round((previous_conflicts + 1.0) / completed, 4)
    else:
        previous_conflicts = float(getattr(user, "conflict_rate", 0.0) or 0.0) * (completed - 1)
        user.conflict_rate = round(previous_conflicts / completed, 4)
    user.completed_assignments = completed
    user.save()


def evaluate_work_item(work_item: WorkItem) -> Optional[dict]:
    annotations = list(WorkAnnotation.objects(work_item=work_item, status=WorkAnnotation.STATUS_SUBMITTED))
    if len(annotations) < work_item.project.assignments_per_task:
        return None

    pair_scores: List[float] = []
    pair_metrics: List[dict] = []
    for i, annotation_a in enumerate(annotations):
        for j in range(i + 1, len(annotations)):
            annotation_b = annotations[j]
            comparison = compare_bbox_annotations(
                annotation_a.label_data,
                annotation_b.label_data,
                work_item.project.iou_threshold,
            )
            pair_scores.append(comparison.get("quality_score", comparison["f1"]))
            pair_metrics.append({"a": str(annotation_a.id), "b": str(annotation_b.id), "metrics": comparison})
    consensus = build_consensus_bbox_annotation(annotations, work_item)
    pair_quality = round(sum(pair_scores) / len(pair_scores), 4) if pair_scores else 1.0
    consensus_f1 = _consensus_bbox_quality_score(consensus["metrics"])
    consensus_quality_ok = int((consensus["metrics"] or {}).get("unaccepted_majority_clusters") or 0) == 0
    required_sources = max(int((consensus["metrics"] or {}).get("required_sources_per_box") or 1), 1)
    acceptance_threshold = min(float(work_item.project.agreement_threshold or 0.0), required_sources / max(len(annotations), 1))
    work_item.agreement_score = consensus_f1
    if consensus_f1 >= acceptance_threshold and consensus_quality_ok:
        work_item.status = WorkItem.STATUS_COMPLETED
        work_item.review_required = False
        work_item.review_status = "auto_accepted"
        work_item.validation_status = WorkItem.VALIDATION_PENDING
        work_item.validation_comment = ""
        work_item.validated_by = None
        work_item.validated_at = None
        work_item.final_annotation = {"boxes": consensus["boxes"]}
        work_item.final_source = "annotator_consensus"
        work_item.workflow_meta = {
            **(work_item.workflow_meta or {}),
            "bbox_consensus": consensus["metrics"],
        }
        work_item.save()

        for annotation in annotations:
            annotation.status = WorkAnnotation.STATUS_ACCEPTED
            annotation.save()
            annotation.assignment.status = Assignment.STATUS_ACCEPTED
            annotation.assignment.save()
            update_user_quality(annotation.annotator, consensus_f1, disputed=False)
        _run_video_qc_for_work_item(work_item)
        return {"state": "accepted", "metrics": {"quality_score": consensus_f1, "pair_quality": pair_quality, "pairs": pair_metrics, "consensus": consensus["metrics"]}}
    if not ReviewRecord.objects(work_item=work_item).first():
        ReviewRecord(
            project=work_item.project,
            work_item=work_item,
            status=ReviewRecord.STATUS_PENDING,
            agreement_score=consensus_f1,
            metrics={"pairs": pair_metrics, "consensus": consensus["metrics"]},
            dispute_reason="low_agreement",
        ).save()
    requeued_assignments = requeue_low_agreement_work_item(work_item, annotations, consensus_f1, pair_metrics=pair_metrics)
    state = "requeued"
    if work_item.validation_status == WorkItem.VALIDATION_DISPUTED:
        state = "disputed"
    elif work_item.validation_status == WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS:
        state = "insufficient_annotators"
    return {
        "state": state,
        "metrics": {"quality_score": consensus_f1, "pair_quality": pair_quality, "pairs": pair_metrics, "consensus": consensus["metrics"]},
        "requeued_assignments": requeued_assignments,
    }


def requeue_low_agreement_work_item(work_item: WorkItem, annotations: List[WorkAnnotation], consensus_f1: float, pair_metrics: List[dict] | None = None) -> int:
    return requeue_work_item_for_validation(work_item, actor=None, reason="low_agreement")


def requeue_work_item_for_validation(work_item: WorkItem, actor: User | None = None, reason: str = "validation_needs_changes") -> int:
    project = work_item.project
    settings = workflow_runtime_settings(project)
    meta = work_item.workflow_meta or {}
    rounds = int(meta.get("reannotation_rounds") or 0)
    if rounds >= settings["max_reannotation_rounds"]:
        _mark_work_item_validation_blocked(
            work_item,
            WorkItem.VALIDATION_DISPUTED,
            f"Consensus was not reached after {rounds} reannotation round(s)",
            {"reannotation_rounds": rounds, "last_requeue_reason": reason},
        )
        return 0

    required_assignments = max(1, int(project.assignments_per_task or 1))
    existing_assignments = list(Assignment.objects(work_item=work_item).order_by("order_index", "created_at"))
    existing_annotator_ids = {str(item.annotator.id) for item in existing_assignments}
    fresh_candidates = [
        user
        for user in select_annotators_for_project(project, max(required_assignments * 3, len(existing_assignments) + required_assignments), stage="bbox_annotation")
        if str(user.id) not in existing_annotator_ids
    ]
    extra_assignments_needed = 1
    if len(fresh_candidates) < extra_assignments_needed:
        _mark_work_item_validation_blocked(
            work_item,
            WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS,
            "No independent annotators are available for reannotation",
            {
                "reannotation_rounds": rounds,
                "last_requeue_reason": reason,
                "fresh_candidates": len(fresh_candidates),
                "required_new_assignments": extra_assignments_needed,
            },
        )
        return 0

    queue_position = _next_queue_position(project)
    for assignment in existing_assignments:
        assignment.quality_signals = {
            **(assignment.quality_signals or {}),
            "requeue_reason": reason,
        }
        assignment.save()

    work_item.status = WorkItem.STATUS_PENDING
    work_item.final_annotation = {}
    work_item.final_source = ""
    work_item.validation_status = WorkItem.VALIDATION_NEEDS_CHANGES
    work_item.validated_by = actor
    work_item.validated_at = datetime.utcnow() if actor else work_item.validated_at
    work_item.review_required = False
    work_item.review_status = f"requeued_{reason}"
    _workflow_meta_set(
        work_item,
        reannotation_rounds=rounds + 1,
        last_requeue_reason=reason,
        quality_state="reannotation_requested",
    )
    work_item.save()

    created = 0
    next_order = Assignment.objects(work_item=work_item).count()
    for annotator in fresh_candidates[:extra_assignments_needed]:
        Assignment(
            project=project,
            work_item=work_item,
            annotator=annotator,
            order_index=next_order,
            queue_position=queue_position,
            status=Assignment.STATUS_ASSIGNED,
        ).save()
        next_order += 1
        queue_position += 1
        created += 1
        log_security_event(
            project=project,
            actor=actor,
            event_type=SecurityEvent.EVENT_ASSIGNMENT_DISTRIBUTION,
            payload={"work_item_id": str(work_item.id), "annotator_id": str(annotator.id), "reason": reason},
            severity="warning",
        )
    return created


def resolve_validation_batch(project: Project, task_batch_id: str, actor: User, items: List[dict], batch_comment: str = "") -> dict:
    decisions = {str(item.get("work_item_id") or ""): item for item in items if item.get("work_item_id")}
    batch_items = _batch_work_items(project, task_batch_id)
    approved = 0
    requeued = 0
    for work_item in batch_items:
        decision = str((decisions.get(str(work_item.id), {}) or {}).get("decision") or "approve").strip().lower()
        comment = str((decisions.get(str(work_item.id), {}) or {}).get("comment") or "").strip()
        if decision == "needs_changes":
            work_item.validation_comment = comment or batch_comment
            created = requeue_work_item_for_validation(work_item, actor=actor, reason="validation_needs_changes")
            work_item.validation_comment = comment or batch_comment
            work_item.save()
            requeued += created or 1
            continue

        work_item.validation_status = WorkItem.VALIDATION_APPROVED
        work_item.validation_comment = comment or batch_comment
        work_item.validated_by = actor
        work_item.validated_at = datetime.utcnow()
        work_item.save()
        approved += 1

    return {
        "project_id": str(project.id),
        "task_batch_id": task_batch_id,
        "approved_items": approved,
        "requeued_items": requeued,
        "status": "completed" if approved == len(batch_items) else "partial_requeue",
    }


def _clone_annotation(annotation: dict) -> dict:
    return json.loads(json.dumps(annotation or {"boxes": []}))


def _active_golden_frames(project: Project, limit: int | None = None) -> List[GoldenFrame]:
    query = GoldenFrame.objects(project=project, status=GoldenFrame.STATUS_ACTIVE).order_by("-candidate_score", "-created_at")
    items = list(query.limit(limit)) if limit else list(query)
    return items


def _golden_reference_threshold(project: Project) -> float:
    settings = workflow_runtime_settings(project)
    return max(float(project.agreement_threshold or 0.0), float(settings["golden_candidate_threshold"]))


def _register_golden_candidate(work_item: WorkItem, source: str) -> Optional[GoldenFrame]:
    if work_item.status != WorkItem.STATUS_COMPLETED:
        return None
    if work_item.validation_status != WorkItem.VALIDATION_APPROVED:
        return None
    boxes = _normalize_boxes(work_item.final_annotation)
    if not boxes:
        return None
    threshold = _golden_reference_threshold(work_item.project)
    if float(work_item.agreement_score or 0.0) < threshold:
        return None
    candidate = GoldenFrame.objects(project=work_item.project, frame=work_item.frame).first()
    if not candidate:
        candidate = GoldenFrame(project=work_item.project, frame=work_item.frame)
    if candidate.status == GoldenFrame.STATUS_ACTIVE:
        return candidate
    candidate.reference_annotation = {"boxes": boxes}
    candidate.source_work_item = work_item
    candidate.candidate_score = float(work_item.agreement_score or 0.0)
    candidate.candidate_source = source
    candidate.status = GoldenFrame.STATUS_CANDIDATE
    candidate.review_notes = str((work_item.workflow_meta or {}).get("bbox_validation_summary", {}).get("status") or "")
    candidate.save()
    log_security_event(
        project=work_item.project,
        event_type=SecurityEvent.EVENT_GOLDEN_CANDIDATE,
        payload={
            "golden_frame_id": str(candidate.id),
            "work_item_id": str(work_item.id),
            "agreement_score": float(work_item.agreement_score or 0.0),
            "source": source,
        },
        severity="info",
    )
    return candidate


def _ensure_golden_frames(project: Project, target_count: int = 10) -> List[GoldenFrame]:
    return _active_golden_frames(project, limit=target_count)


def _golden_attempt_rates(golden: GoldenFrame) -> dict:
    annotation_seen = int(golden.annotation_seen or 0)
    validation_seen = int(golden.validation_seen or 0)
    return {
        "annotation_seen": annotation_seen,
        "annotation_passed": int(golden.annotation_passed or 0),
        "annotation_failed": int(golden.annotation_failed or 0),
        "annotation_pass_rate": round(float(golden.annotation_passed or 0) / annotation_seen, 4) if annotation_seen else 0.0,
        "validation_seen": validation_seen,
        "validation_passed": int(golden.validation_passed or 0),
        "validation_failed": int(golden.validation_failed or 0),
        "validation_pass_rate": round(float(golden.validation_passed or 0) / validation_seen, 4) if validation_seen else 0.0,
    }


def list_golden_candidates(project: Project) -> List[dict]:
    items = list(GoldenFrame.objects(project=project).order_by("status", "-candidate_score", "-created_at"))
    return [
        {
            "golden_frame_id": str(item.id),
            "frame_id": str(item.frame.id),
            "frame_url": item.frame.frame_uri,
            "frame_number": item.frame.frame_number,
            "timestamp_sec": float(item.frame.timestamp_sec or 0.0),
            "width": item.frame.width,
            "height": item.frame.height,
            "candidate_score": float(item.candidate_score or 0.0),
            "candidate_source": item.candidate_source or "",
            "status": item.status or (GoldenFrame.STATUS_ACTIVE if item.is_active else GoldenFrame.STATUS_CANDIDATE),
            "is_active": item.status == GoldenFrame.STATUS_ACTIVE,
            "is_candidate": item.status in {GoldenFrame.STATUS_CANDIDATE, GoldenFrame.STATUS_ACTIVE},
            "promoted_at": item.promoted_at,
            "review_notes": item.review_notes or "",
            "reference_annotation": {"boxes": _normalize_boxes(item.reference_annotation)},
            "stats": _golden_attempt_rates(item),
        }
        for item in items
    ]


def promote_golden_candidate(project: Project, golden_frame_id: str, actor: User, review_notes: str = "") -> dict:
    if not ObjectId.is_valid(golden_frame_id):
        raise ValueError("Invalid golden frame id")
    golden = GoldenFrame.objects(id=ObjectId(golden_frame_id), project=project).first()
    if not golden:
        raise ValueError("Golden candidate not found")
    golden.status = GoldenFrame.STATUS_ACTIVE
    golden.promoted_by = actor
    golden.promoted_at = datetime.utcnow()
    if review_notes:
        golden.review_notes = review_notes
    golden.save()
    log_security_event(
        project=project,
        actor=actor,
        event_type=SecurityEvent.EVENT_GOLDEN_PROMOTED,
        payload={
            "golden_frame_id": str(golden.id),
            "frame_id": str(golden.frame.id),
            "candidate_score": float(golden.candidate_score or 0.0),
            "review_notes": review_notes,
        },
    )
    return {
        "golden_frame_id": str(golden.id),
        "status": golden.status,
        "is_active": golden.status == GoldenFrame.STATUS_ACTIVE,
        "is_candidate": golden.status in {GoldenFrame.STATUS_CANDIDATE, GoldenFrame.STATUS_ACTIVE},
        "promoted_at": golden.promoted_at,
    }


def retire_golden_frame(project: Project, golden_frame_id: str, actor: User, review_notes: str = "") -> dict:
    if not ObjectId.is_valid(golden_frame_id):
        raise ValueError("Invalid golden frame id")
    golden = GoldenFrame.objects(id=ObjectId(golden_frame_id), project=project).first()
    if not golden:
        raise ValueError("Golden frame not found")
    golden.status = GoldenFrame.STATUS_RETIRED
    if review_notes:
        golden.review_notes = review_notes
    golden.save()
    log_security_event(
        project=project,
        actor=actor,
        event_type=SecurityEvent.EVENT_GOLDEN_PROMOTED,
        payload={"golden_frame_id": str(golden.id), "frame_id": str(golden.frame.id), "retired": True, "review_notes": review_notes},
        severity="warning",
    )
    return {"golden_frame_id": str(golden.id), "status": golden.status, "is_active": False, "is_candidate": False}


def _project_label_names(project: Project) -> List[str]:
    labels = []
    for item in project.label_schema or []:
        name = str(item.get("name") or item.get("label") or "").strip()
        if name and name not in labels:
            labels.append(name)
    return labels


def _shift_box_badly(box: dict, frame: FrameItem) -> dict:
    shifted = dict(box)
    max_width = max(float(frame.width or 0), 1.0)
    max_height = max(float(frame.height or 0), 1.0)
    width = max(float(shifted.get("width") or 1.0), 1.0)
    height = max(float(shifted.get("height") or 1.0), 1.0)
    shifted["x"] = round(min(max(float(box.get("x") or 0.0) + max(width * 1.5, max_width * 0.25), 0.0), max(max_width - width, 0.0)), 2)
    shifted["y"] = round(min(max(float(box.get("y") or 0.0) + max(height * 1.5, max_height * 0.25), 0.0), max(max_height - height, 0.0)), 2)
    if _iou(box, shifted) >= 0.5:
        shifted["x"] = 0.0 if float(box.get("x") or 0.0) > max_width / 2 else max(max_width - width, 0.0)
        shifted["y"] = 0.0 if float(box.get("y") or 0.0) > max_height / 2 else max(max_height - height, 0.0)
    return shifted


def _extra_box_for_frame(frame: FrameItem, label: str) -> dict:
    width = max(round(float(frame.width or 100) * 0.12, 2), 8.0)
    height = max(round(float(frame.height or 100) * 0.12, 2), 8.0)
    return {"x": 1.0, "y": 1.0, "width": width, "height": height, "label": label}


def _build_golden_validation_question(golden: GoldenFrame, seed: str = "") -> dict:
    reference = {"boxes": _normalize_boxes(golden.reference_annotation)}
    boxes = _clone_annotation(reference).get("boxes", [])
    label_names = _project_label_names(golden.project)
    issue_types = ["correct", "missing_box", "bad_geometry", "wrong_label", "extra_box"]
    if not boxes:
        issue_types = ["correct", "extra_box"]
    elif len(label_names) < 2:
        issue_types.remove("wrong_label")
    digest = hashlib.sha256(f"{golden.id}:{seed}".encode("utf-8")).hexdigest()
    issue_type = issue_types[int(digest[:8], 16) % len(issue_types)]
    probe = {"boxes": _clone_annotation(reference).get("boxes", [])}
    expected_decision = "approve"

    if issue_type == "missing_box":
        probe["boxes"] = probe["boxes"][1:] if len(probe["boxes"]) > 1 else []
        expected_decision = "needs_changes"
    elif issue_type == "bad_geometry" and probe["boxes"]:
        probe["boxes"][0] = _shift_box_badly(probe["boxes"][0], golden.frame)
        expected_decision = "needs_changes"
    elif issue_type == "wrong_label" and probe["boxes"]:
        current_label = str(probe["boxes"][0].get("label") or "")
        replacement = next((label for label in label_names if label != current_label), None)
        if replacement:
            probe["boxes"][0] = {**probe["boxes"][0], "label": replacement}
        expected_decision = "needs_changes"
    elif issue_type == "extra_box":
        label = str((boxes[0] if boxes else {}).get("label") or (label_names[0] if label_names else "object"))
        probe["boxes"].append(_extra_box_for_frame(golden.frame, label))
        expected_decision = "needs_changes"

    return {
        "golden_id": str(golden.id),
        "probe_annotation": probe,
        "expected_decision": expected_decision,
        "issue_type": issue_type,
    }


def _bbox_validation_real_payload(work_item: WorkItem) -> dict:
    payload = _work_item_payload(work_item)
    payload["question_id"] = str(work_item.id)
    payload["candidate_annotation"] = payload.get("final_annotation", {"boxes": []})
    return payload


def _bbox_validation_golden_payload(golden: GoldenFrame, question: Optional[dict] = None) -> dict:
    frame = golden.frame
    probe_annotation = (question or {}).get("probe_annotation") or {"boxes": _normalize_boxes(golden.reference_annotation)}
    return {
        "golden_id": str(golden.id),
        "frame_id": str(frame.id),
        "frame_url": frame.frame_uri,
        "frame_number": frame.frame_number,
        "timestamp_sec": frame.timestamp_sec,
        "width": frame.width,
        "height": frame.height,
        "question_id": str(golden.id),
        "candidate_annotation": {"boxes": _normalize_boxes(probe_annotation)},
    }


def ensure_bbox_validation_assignments(
    project: Project,
    min_validators: int | None = None,
    real_items_per_batch: int | None = None,
    golden_items_per_batch: int | None = None,
) -> int:
    if not _is_task(project, TASK_BBOX_VALIDATION):
        return 0
    settings = workflow_runtime_settings(project)
    required_validators = min_validators or settings["bbox_validators_per_batch"]
    real_batch_size = real_items_per_batch or settings["bbox_real_items_per_batch"]
    golden_batch_size = golden_items_per_batch or settings["bbox_golden_items_per_batch"]
    completed_items = list(
        WorkItem.objects(
            project=project,
            status=WorkItem.STATUS_COMPLETED,
            validation_status=WorkItem.VALIDATION_PENDING,
        ).order_by("created_at")
    )
    if not completed_items:
        return 0
    created = 0
    golden_frames = _ensure_golden_frames(project, golden_batch_size)
    for start in range(0, len(completed_items), real_batch_size):
        items = completed_items[start : start + real_batch_size]
        target_real_ids = {str(item.id) for item in items}
        existing_for_batch = [
            assignment
            for assignment in BBoxValidationAssignment.objects(project=project)
            if set(assignment.work_item_ids or []) == target_real_ids
        ]
        if len(existing_for_batch) >= required_validators:
            continue
        existing_validator_ids = {str(assignment.validator.id) for assignment in existing_for_batch}
        candidates = [
            user
            for user in select_annotators_for_project(project, max(15, required_validators * 3), stage="bbox_validation")
            if str(user.id) not in existing_validator_ids
        ]
        validators_created_for_batch = 0
        for validator in candidates:
            eligible_items = []
            for item in items:
                source_author_ids = {str(author_id) for author_id in (item.workflow_meta or {}).get("source_author_ids", [])}
                authored = WorkAnnotation.objects(
                    work_item=item,
                    annotator=validator,
                    status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED],
                ).first()
                if not authored and str(validator.id) not in source_author_ids:
                    eligible_items.append(item)
            real_ids = [str(item.id) for item in eligible_items[:real_batch_size]]
            if not real_ids:
                continue
            existing = BBoxValidationAssignment.objects(project=project, validator=validator, work_item_ids=real_ids).first()
            if existing:
                continue
            selected_golden = golden_frames[:golden_batch_size]
            golden_questions = [
                _build_golden_validation_question(golden, seed=f"{validator.id}:{start}:{index}")
                for index, golden in enumerate(selected_golden, start=1)
            ]
            golden_ids = [question["golden_id"] for question in golden_questions]
            BBoxValidationAssignment(
                project=project,
                validator=validator,
                work_item_ids=real_ids,
                golden_frame_ids=golden_ids,
                golden_questions=golden_questions,
                status=BBoxValidationAssignment.STATUS_ASSIGNED,
            ).save()
            created += 1
            validators_created_for_batch += 1
            if len(existing_for_batch) + validators_created_for_batch >= required_validators:
                break
        if validators_created_for_batch == 0:
            for item in items:
                if _required_bbox_validation_votes(item, min_validators=required_validators) <= 0:
                    _mark_work_item_validation_blocked(
                        item,
                        WorkItem.VALIDATION_INSUFFICIENT_VALIDATORS,
                        "No independent bbox validators are available",
                    )
    return created


def _required_bbox_validation_votes(work_item: WorkItem, min_validators: int | None = None) -> int:
    required = min_validators or workflow_runtime_settings(work_item.project)["bbox_validators_per_batch"]
    authors = {
        str(annotation.annotator.id)
        for annotation in WorkAnnotation.objects(work_item=work_item, status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED])
        if annotation.annotator
    }
    authors.update(str(author_id) for author_id in (work_item.workflow_meta or {}).get("source_author_ids", []))
    candidates = select_annotators_for_project(work_item.project, 50, stage="bbox_validation")
    eligible = [user for user in candidates if str(user.id) not in authors]
    return min(required, len(eligible))


def bbox_validation_queue_for_annotator(user: User) -> List[dict]:
    """Return BBox validation assignments for *user* excluding their own annotations.

    The original implementation returned all real items, which caused a validator
    to see the annotations they themselves created. This version filters out any
    ``WorkItem`` that already has a ``WorkAnnotation`` authored by the same
    validator, ensuring only foreign annotations are presented for review.
    """
    assignments = list(
        BBoxValidationAssignment.objects(
            validator=user, status=BBoxValidationAssignment.STATUS_ASSIGNED
        ).order_by("created_at")
    )
    payload: List[dict] = []
    for item in assignments:
        # Load all referenced work items and filter out those already annotated by the validator
        all_real_items = [
            wi
            for wi in WorkItem.objects(
                project=item.project,
                id__in=[ObjectId(wid) for wid in item.work_item_ids if ObjectId.is_valid(wid)],
            )
        ]
        # Exclude items where the validator already has a submitted or accepted annotation
        real_items = []
        for wi in all_real_items:
            source_author_ids = {str(author_id) for author_id in (wi.workflow_meta or {}).get("source_author_ids", [])}
            authored = WorkAnnotation.objects(work_item=wi, annotator=user, status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED]).first()
            if not authored and str(user.id) not in source_author_ids:
                real_items.append(wi)
        real_lookup = {str(wi.id): wi for wi in real_items}
        ordered_real = [real_lookup[wid] for wid in item.work_item_ids if wid in real_lookup]
        # Load golden frames (always included, no need to filter by author)
        golden_items = [
            g
            for g in GoldenFrame.objects(
                project=item.project,
                id__in=[ObjectId(gid) for gid in item.golden_frame_ids if ObjectId.is_valid(gid)],
                status=GoldenFrame.STATUS_ACTIVE,
            )
        ]
        golden_lookup = {str(g.id): g for g in golden_items}
        ordered_golden = [golden_lookup[gid] for gid in item.golden_frame_ids if gid in golden_lookup]
        question_lookup = {
            str(question.get("golden_id") or ""): question
            for question in (item.golden_questions or [])
        }
        ordered_real_ids = [str(wi.id) for wi in ordered_real]
        ordered_golden_ids = [str(g.id) for g in ordered_golden]
        sequence = [
            {"id": str(wi.id), "index": index}
            for index, wi in enumerate(ordered_real, start=1)
        ] + [
            {"id": str(g.id), "index": len(ordered_real) + index}
            for index, g in enumerate(ordered_golden, start=1)
        ]
        rng = random.Random(str(item.id))
        rng.shuffle(sequence)
        sequence = [{"id": entry["id"], "index": index} for index, entry in enumerate(sequence, start=1)]

        payload.append(
            {
                "assignment_id": str(item.id),
                "project_id": str(item.project.id),
                "project_title": item.project.title,
                "questions": [
                    *[_bbox_validation_real_payload(wi) for wi in ordered_real],
                    *[_bbox_validation_golden_payload(g, question_lookup.get(str(g.id))) for g in ordered_golden],
                ],
                "total": len(sequence),
                "current_index": 1 if sequence else 0,
                "sequence": sequence,
            }
        )
    return payload


def submit_bbox_validation_assignment(
    assignment: BBoxValidationAssignment,
    decisions: Dict[str, str],
    golden_decisions: Dict[str, str],
    min_score: float = 0.8,
    min_validators: int | None = None,
) -> dict:
    required_min_score = min_score if min_score is not None else workflow_runtime_settings(assignment.project)["golden_min_score"]
    required_validators = min_validators or workflow_runtime_settings(assignment.project)["bbox_validators_per_batch"]
    golden_frames = list(
        GoldenFrame.objects(
            project=assignment.project,
            id__in=[ObjectId(golden_id) for golden_id in assignment.golden_frame_ids if ObjectId.is_valid(golden_id)],
            status=GoldenFrame.STATUS_ACTIVE,
        )
    )
    question_lookup = {
        str(question.get("golden_id") or ""): question
        for question in (assignment.golden_questions or [])
    }
    all_decisions = {**decisions, **golden_decisions}
    golden_total = len(golden_frames)
    golden_correct = 0
    for golden in golden_frames:
        decision = str(all_decisions.get(str(golden.id), "")).strip().lower()
        question = question_lookup.get(str(golden.id)) or _build_golden_validation_question(golden, seed=str(assignment.id))
        expected_decision = str(question.get("expected_decision") or "approve").strip().lower()
        passed = decision == expected_decision
        if passed:
            golden_correct += 1
        GoldenAttempt(
            project=assignment.project,
            golden_frame=golden,
            user=assignment.validator,
            stage=GoldenAttempt.STAGE_VALIDATION,
            validation_assignment=assignment,
            decision=decision,
            probe_annotation=question.get("probe_annotation") or {},
            reference_annotation={"boxes": _normalize_boxes(golden.reference_annotation)},
            score=1.0 if passed else 0.0,
            passed=passed,
            issue_type=str(question.get("issue_type") or ""),
        ).save()
        golden.validation_seen = int(golden.validation_seen or 0) + 1
        if passed:
            golden.validation_passed = int(golden.validation_passed or 0) + 1
        else:
            golden.validation_failed = int(golden.validation_failed or 0) + 1
        golden.save()
    score = round(golden_correct / golden_total, 4) if golden_total else 1.0
    for work_item_id in all_decisions.keys():
        if not ObjectId.is_valid(work_item_id):
            continue
        work_item = WorkItem.objects(id=ObjectId(work_item_id), project=assignment.project).first()
        if not work_item:
            continue
        authored = WorkAnnotation.objects(
            work_item=work_item,
            annotator=assignment.validator,
            status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED],
        ).first()
        if authored:
            raise PermissionError("Annotator cannot validate their own bbox annotation")
    assignment.decisions = decisions
    assignment.golden_decisions = golden_decisions
    assignment.golden_score = score
    assignment.status = BBoxValidationAssignment.STATUS_SUBMITTED
    assignment.save()
    if golden_total and score < required_min_score:
        return {"assignment_id": str(assignment.id), "status": "rejected_by_golden", "golden_score": score, "golden_total": golden_total}
    approved_count = 0
    requeued_count = 0
    pending_count = 0
    for work_item_id in assignment.work_item_ids:
        if not ObjectId.is_valid(work_item_id):
            continue
        work_item = WorkItem.objects(id=ObjectId(work_item_id), project=assignment.project).first()
        if not work_item:
            continue
        authored = WorkAnnotation.objects(
            work_item=work_item,
            annotator=assignment.validator,
            status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED],
        ).first()
        if authored:
            continue
        decision = str(all_decisions.get(work_item_id, "approve")).strip().lower()
        validators_meta = (work_item.workflow_meta or {}).get("bbox_validation_votes") or []
        validators_meta = [
            vote
            for vote in validators_meta
            if str(vote.get("validator_id") or "") != str(assignment.validator.id)
        ]
        validators_meta.append({"validator_id": str(assignment.validator.id), "decision": decision})
        meta = work_item.workflow_meta or {}
        meta["bbox_validation_votes"] = validators_meta
        work_item.workflow_meta = meta

        submitted_votes = [
            vote
            for vote in validators_meta
            if str(vote.get("decision") or "").strip().lower() in {"approve", "needs_changes"}
        ]
        required_votes = _required_bbox_validation_votes(work_item, min_validators=required_validators)
        if required_votes <= 0:
            meta["bbox_validation_summary"] = {
                "votes": len(submitted_votes),
                "required_votes": 0,
                "approved": sum(1 for vote in submitted_votes if vote.get("decision") == "approve"),
                "needs_changes": sum(1 for vote in submitted_votes if vote.get("decision") == "needs_changes"),
                "agreement": 0.0,
                "status": "insufficient_validators",
            }
            work_item.workflow_meta = meta
            _mark_work_item_validation_blocked(
                work_item,
                WorkItem.VALIDATION_INSUFFICIENT_VALIDATORS,
                "No independent bbox validators are available",
            )
            pending_count += 1
            continue
        if len(submitted_votes) < required_votes:
            meta["bbox_validation_summary"] = {
                "votes": len(submitted_votes),
                "required_votes": required_votes,
                "approved": sum(1 for vote in submitted_votes if vote.get("decision") == "approve"),
                "needs_changes": sum(1 for vote in submitted_votes if vote.get("decision") == "needs_changes"),
                "agreement": 0.0,
                "status": "pending",
            }
            work_item.workflow_meta = meta
            work_item.save()
            pending_count += 1
            continue

        needs_changes_votes = sum(1 for vote in submitted_votes if vote.get("decision") == "needs_changes")
        approve_votes = len(submitted_votes) - needs_changes_votes
        agreement = round(max(approve_votes, needs_changes_votes) / len(submitted_votes), 4) if submitted_votes else 0.0
        conflict = approve_votes == needs_changes_votes or agreement < float(work_item.project.agreement_threshold or 0.0)
        meta["bbox_validation_summary"] = {
            "votes": len(submitted_votes),
            "required_votes": required_votes,
            "approved": approve_votes,
            "needs_changes": needs_changes_votes,
            "agreement": agreement,
            "status": "needs_changes" if needs_changes_votes > approve_votes or conflict else "approved",
        }
        work_item.workflow_meta = meta
        if needs_changes_votes > approve_votes or conflict:
            requeue_work_item_for_validation(work_item, actor=assignment.validator, reason="bbox_validation_needs_changes")
            requeued_count += 1
        else:
            work_item.validation_status = WorkItem.VALIDATION_APPROVED
            work_item.validated_by = assignment.validator
            work_item.validated_at = datetime.utcnow()
            work_item.save()
            _register_golden_candidate(work_item, source="bbox_validation")
            approved_count += 1
    return {
        "assignment_id": str(assignment.id),
        "status": "submitted",
        "golden_score": score,
        "golden_total": golden_total,
        "golden_mode": "active" if golden_total else "bootstrap",
        "approved_items": approved_count,
        "requeued_items": requeued_count,
        "pending_items": pending_count,
    }


def repair_submitted_bbox_validation(project: Project) -> dict:
    """Replay submitted bbox validation assignments into pending work items.

    Older projects may have submitted validation packets while individual
    WorkItem.workflow_meta votes stayed incomplete. This repair keeps the
    independent-validator rule and finalizes items from already submitted votes.
    """
    settings = workflow_runtime_settings(project)
    required_validators = settings["bbox_validators_per_batch"]
    submitted_assignments = list(BBoxValidationAssignment.objects(project=project, status=BBoxValidationAssignment.STATUS_SUBMITTED))
    pending_items = list(
        WorkItem.objects(
            project=project,
            status=WorkItem.STATUS_COMPLETED,
            validation_status=WorkItem.VALIDATION_PENDING,
        )
    )
    approved_count = 0
    requeued_count = 0
    still_pending_count = 0
    insufficient_validator_count = 0
    repaired_vote_count = 0

    for work_item in pending_items:
        work_item_id = str(work_item.id)
        votes_by_validator: Dict[str, dict] = {}
        for assignment in submitted_assignments:
            decision = str((assignment.decisions or {}).get(work_item_id) or "").strip().lower()
            if decision not in {"approve", "needs_changes"}:
                continue
            authored = WorkAnnotation.objects(
                work_item=work_item,
                annotator=assignment.validator,
                status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED],
            ).first()
            if authored:
                continue
            votes_by_validator[str(assignment.validator.id)] = {
                "validator_id": str(assignment.validator.id),
                "decision": decision,
            }

        submitted_votes = list(votes_by_validator.values())
        repaired_vote_count += len(submitted_votes)
        meta = work_item.workflow_meta or {}
        meta["bbox_validation_votes"] = submitted_votes
        required_votes = _required_bbox_validation_votes(work_item, min_validators=required_validators)
        if required_votes <= 0:
            meta["bbox_validation_summary"] = {
                "votes": len(submitted_votes),
                "required_votes": 0,
                "approved": sum(1 for vote in submitted_votes if vote.get("decision") == "approve"),
                "needs_changes": sum(1 for vote in submitted_votes if vote.get("decision") == "needs_changes"),
                "agreement": 0.0,
                "status": "insufficient_validators",
                "repaired_from_submitted_assignments": True,
            }
            work_item.workflow_meta = meta
            _mark_work_item_validation_blocked(
                work_item,
                WorkItem.VALIDATION_INSUFFICIENT_VALIDATORS,
                "No independent bbox validators are available",
            )
            insufficient_validator_count += 1
            continue

        approve_votes = sum(1 for vote in submitted_votes if vote.get("decision") == "approve")
        needs_changes_votes = sum(1 for vote in submitted_votes if vote.get("decision") == "needs_changes")
        if len(submitted_votes) < required_votes:
            meta["bbox_validation_summary"] = {
                "votes": len(submitted_votes),
                "required_votes": required_votes,
                "approved": approve_votes,
                "needs_changes": needs_changes_votes,
                "agreement": 0.0,
                "status": "pending",
                "repaired_from_submitted_assignments": True,
            }
            work_item.workflow_meta = meta
            work_item.save()
            still_pending_count += 1
            continue

        agreement = round(max(approve_votes, needs_changes_votes) / len(submitted_votes), 4) if submitted_votes else 0.0
        conflict = approve_votes == needs_changes_votes or agreement < float(project.agreement_threshold or 0.0)
        meta["bbox_validation_summary"] = {
            "votes": len(submitted_votes),
            "required_votes": required_votes,
            "approved": approve_votes,
            "needs_changes": needs_changes_votes,
            "agreement": agreement,
            "status": "needs_changes" if needs_changes_votes > approve_votes or conflict else "approved",
            "repaired_from_submitted_assignments": True,
        }
        work_item.workflow_meta = meta
        actor = None
        first_vote = submitted_votes[0] if submitted_votes else None
        if first_vote and ObjectId.is_valid(str(first_vote.get("validator_id") or "")):
            actor = User.objects(id=ObjectId(str(first_vote.get("validator_id")))).first()
        if needs_changes_votes > approve_votes or conflict:
            requeue_work_item_for_validation(work_item, actor=actor, reason="bbox_validation_needs_changes")
            requeued_count += 1
        else:
            work_item.validation_status = WorkItem.VALIDATION_APPROVED
            work_item.validated_by = actor
            work_item.validated_at = datetime.utcnow()
            work_item.save()
            _register_golden_candidate(work_item, source="bbox_validation_repair")
            approved_count += 1

    return {
        "pending_items_checked": len(pending_items),
        "votes_replayed": repaired_vote_count,
        "approved_items": approved_count,
        "requeued_items": requeued_count,
        "still_pending_items": still_pending_count,
        "insufficient_validator_items": insufficient_validator_count,
    }


def save_assignment_annotation(assignment: Assignment, label_data: dict, comment: str, is_final: bool) -> Tuple[WorkAnnotation, Optional[dict]]:
    now = datetime.utcnow()
    if not assignment.started_at:
        assignment.started_at = now
    assignment.submitted_at = now if is_final else assignment.submitted_at
    assignment.status = Assignment.STATUS_SUBMITTED if is_final else Assignment.STATUS_DRAFT
    assignment.quality_signals = _assignment_quality_signals(assignment)
    assignment.save()

    annotation = WorkAnnotation.objects(assignment=assignment).first()
    if not annotation:
        annotation = WorkAnnotation(
            assignment=assignment,
            work_item=assignment.work_item,
            annotator=assignment.annotator,
            annotation_format="bbox",
            label_data=label_data,
        )
    annotation.label_data = label_data
    annotation.comment = comment
    annotation.is_final = is_final
    annotation.status = WorkAnnotation.STATUS_SUBMITTED if is_final else WorkAnnotation.STATUS_DRAFT
    annotation.save()

    evaluation = evaluate_work_item(assignment.work_item) if is_final else None
    if is_final and evaluation and evaluation.get("state") == "accepted":
        settings = workflow_runtime_settings(assignment.project)
        ensure_bbox_validation_assignments(
            project=assignment.project,
            min_validators=settings["bbox_validators_per_batch"],
            real_items_per_batch=settings["bbox_real_items_per_batch"],
            golden_items_per_batch=settings["bbox_golden_items_per_batch"],
        )
    return annotation, evaluation


def resolve_review(review: ReviewRecord, reviewer: User, resolution: dict) -> dict:
    golden_score = _evaluate_golden_answers(review, resolution)
    if golden_score["golden_total"] > 0 and golden_score["golden_errors"] / golden_score["golden_total"] > 0.2:
        review.golden_total = golden_score["golden_total"]
        review.golden_errors = golden_score["golden_errors"]
        review.golden_score = golden_score["golden_score"]
        review.metrics = {**(review.metrics or {}), "golden": golden_score}
        review.save()
        log_security_event(
            project=review.project,
            actor=reviewer,
            event_type=SecurityEvent.EVENT_REVIEW_RESOLVE,
            payload={"review_id": str(review.id), "golden": golden_score, "rejected": True},
            severity="warning",
        )
        return {"review_id": str(review.id), "work_item_id": str(review.work_item.id), "status": "rejected_by_golden"}

    review.reviewer = reviewer
    review.status = ReviewRecord.STATUS_RESOLVED
    review.resolution = resolution
    review.golden_total = golden_score["golden_total"]
    review.golden_errors = golden_score["golden_errors"]
    review.golden_score = golden_score["golden_score"]
    review.metrics = {**(review.metrics or {}), "golden": golden_score}
    review.resolved_at = datetime.utcnow()
    review.save()

    work_item = review.work_item
    work_item.status = WorkItem.STATUS_COMPLETED
    work_item.review_required = False
    work_item.review_status = "resolved"
    work_item.final_annotation = resolution
    work_item.final_source = "reviewer"
    work_item.save()
    _run_video_qc_for_work_item(work_item)

    annotations = list(WorkAnnotation.objects(work_item=work_item, status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED]))
    for annotation in annotations:
        score = compare_bbox_annotations(annotation.label_data, resolution, work_item.project.iou_threshold)["f1"]
        annotation.status = WorkAnnotation.STATUS_ACCEPTED if score >= work_item.project.agreement_threshold else WorkAnnotation.STATUS_REJECTED
        annotation.save()
        annotation.assignment.status = Assignment.STATUS_ACCEPTED if annotation.status == WorkAnnotation.STATUS_ACCEPTED else Assignment.STATUS_REJECTED
        annotation.assignment.save()
        update_user_quality(annotation.annotator, score, disputed=True)
    log_security_event(
        project=review.project,
        actor=reviewer,
        event_type=SecurityEvent.EVENT_REVIEW_RESOLVE,
        payload={"review_id": str(review.id), "golden": golden_score, "resolved": True},
    )
    return {"review_id": str(review.id), "work_item_id": str(work_item.id), "status": review.status}


def _evaluate_golden_answers(review: ReviewRecord, resolution: dict) -> dict:
    golden_ids = review.golden_frame_ids or []
    if not golden_ids:
        return {"golden_total": 0, "golden_errors": 0, "golden_score": 1.0}
    golden_frames = list(GoldenFrame.objects(id__in=golden_ids, status=GoldenFrame.STATUS_ACTIVE))
    total = len(golden_frames)
    if total == 0:
        return {"golden_total": 0, "golden_errors": 0, "golden_score": 1.0}
    # Simplified validation: reviewer resolution should align with golden references on average.
    scores = [
        compare_bbox_annotations(golden.reference_annotation, resolution, review.project.iou_threshold)["f1"]
        for golden in golden_frames
    ]
    errors = sum(1 for score in scores if score < 0.8)
    passed = total - errors
    return {"golden_total": total, "golden_errors": errors, "golden_score": round(passed / total, 4)}


GOLDEN_ASSIGNMENT_PREFIX = "golden_"


def golden_assignment_public_id(assignment: GoldenAnnotationAssignment) -> str:
    return f"{GOLDEN_ASSIGNMENT_PREFIX}{assignment.id}"


def parse_golden_assignment_public_id(public_id: str) -> str:
    value = str(public_id or "")
    return value[len(GOLDEN_ASSIGNMENT_PREFIX) :] if value.startswith(GOLDEN_ASSIGNMENT_PREFIX) else ""


def maybe_create_hidden_golden_assignment(project: Project, annotator: User) -> Optional[GoldenAnnotationAssignment]:
    if annotator.role != User.ROLE_ANNOTATOR:
        return None
    existing = GoldenAnnotationAssignment.objects(
        project=project,
        annotator=annotator,
        status__in=[
            GoldenAnnotationAssignment.STATUS_ASSIGNED,
            GoldenAnnotationAssignment.STATUS_IN_PROGRESS,
            GoldenAnnotationAssignment.STATUS_DRAFT,
        ],
    ).order_by("created_at").first()
    if existing:
        return existing

    settings = workflow_runtime_settings(project)
    interval = max(1, int(settings["annotation_golden_interval"] or DEFAULT_ANNOTATION_GOLDEN_INTERVAL))
    ordinary_submitted = Assignment.objects(
        project=project,
        annotator=annotator,
        status__in=[Assignment.STATUS_SUBMITTED, Assignment.STATUS_ACCEPTED, Assignment.STATUS_REJECTED],
    ).count()
    due_slots = ordinary_submitted // interval
    completed_golden = GoldenAttempt.objects(project=project, user=annotator, stage=GoldenAttempt.STAGE_ANNOTATION).count()
    if due_slots <= completed_golden:
        return None

    attempted_ids = {
        str(attempt.golden_frame.id)
        for attempt in GoldenAttempt.objects(project=project, user=annotator, stage=GoldenAttempt.STAGE_ANNOTATION)
    }
    eligible = [golden for golden in _active_golden_frames(project) if str(golden.id) not in attempted_ids]
    if not eligible:
        return None
    golden = sorted(eligible, key=lambda item: (int(item.annotation_seen or 0), -float(item.candidate_score or 0.0), str(item.id)))[0]
    assignment = GoldenAnnotationAssignment(project=project, annotator=annotator, golden_frame=golden)
    try:
        assignment.save()
    except Exception:
        assignment = GoldenAnnotationAssignment.objects(project=project, annotator=annotator, golden_frame=golden).first()
    return assignment


def golden_annotation_assignment_payload(assignment: GoldenAnnotationAssignment) -> dict:
    if assignment.status == GoldenAnnotationAssignment.STATUS_ASSIGNED:
        assignment.status = GoldenAnnotationAssignment.STATUS_IN_PROGRESS
        if not assignment.started_at:
            assignment.started_at = datetime.utcnow()
        assignment.save()
    golden = assignment.golden_frame
    frame = golden.frame
    return {
        "assignment_id": golden_assignment_public_id(assignment),
        "project_id": str(assignment.project.id),
        "project_title": assignment.project.title,
        "work_item_id": str(golden.source_work_item.id) if golden.source_work_item else str(golden.id),
        "frame_url": frame.frame_uri,
        "frame": {
            "frame_number": frame.frame_number,
            "timestamp_sec": frame.timestamp_sec,
            "width": frame.width,
            "height": frame.height,
        },
        "status": assignment.status,
        "queue_position": None,
        "instructions": assignment.project.instructions,
        "label_schema": assignment.project.label_schema or [],
        "workflow_meta": {},
        "task_batch": {"task_batch_id": "", "items": [], "current_index": 0, "total": 0},
        "draft": assignment.draft_annotation or {"boxes": []},
        "pre_annotations": {},
        "comment": assignment.comment or "",
        "quality_signals": assignment.quality_signals or {},
    }


def submit_golden_annotation_assignment(
    assignment: GoldenAnnotationAssignment,
    label_data: dict,
    comment: str,
    is_final: bool,
) -> tuple[Optional[GoldenAttempt], Optional[dict]]:
    now = datetime.utcnow()
    if not assignment.started_at:
        assignment.started_at = now
    assignment.comment = comment
    assignment.draft_annotation = label_data
    assignment.status = GoldenAnnotationAssignment.STATUS_SUBMITTED if is_final else GoldenAnnotationAssignment.STATUS_DRAFT
    assignment.submitted_at = now if is_final else assignment.submitted_at
    assignment.quality_signals = _assignment_quality_signals(assignment)
    assignment.save()
    if not is_final:
        return None, None

    golden = assignment.golden_frame
    comparison = compare_bbox_annotations(golden.reference_annotation, label_data, assignment.project.iou_threshold)
    score = float(comparison.get("quality_score", comparison.get("f1", 0.0)) or 0.0)
    pass_threshold = max(float(assignment.project.agreement_threshold or 0.0), 0.8)
    passed = score >= pass_threshold
    attempt = GoldenAttempt(
        project=assignment.project,
        golden_frame=golden,
        user=assignment.annotator,
        stage=GoldenAttempt.STAGE_ANNOTATION,
        golden_assignment=assignment,
        submitted_annotation=label_data,
        reference_annotation={"boxes": _normalize_boxes(golden.reference_annotation)},
        score=round(score, 4),
        passed=passed,
        issue_type="annotation_control",
    )
    attempt.save()
    golden.annotation_seen = int(golden.annotation_seen or 0) + 1
    if passed:
        golden.annotation_passed = int(golden.annotation_passed or 0) + 1
    else:
        golden.annotation_failed = int(golden.annotation_failed or 0) + 1
    golden.save()
    return attempt, {
        "state": "golden_checked",
        "metrics": {"quality_score": round(score, 4), "threshold": pass_threshold, "passed": passed, "comparison": comparison},
    }


def _run_video_qc_for_work_item(work_item: WorkItem) -> None:
    current_frame = work_item.frame
    previous_frame = (
        FrameItem.objects(asset=current_frame.asset, frame_number__lt=current_frame.frame_number)
        .order_by("-frame_number")
        .first()
    )
    previous_item = WorkItem.objects(project=work_item.project, frame=previous_frame, status=WorkItem.STATUS_COMPLETED).first() if previous_frame else None
    payload = build_video_qc_payload(work_item, previous_item, iou_threshold=0.3)
    if payload.get("checked") and payload.get("flag_for_review"):
        payload["interpolation_candidate"] = interpolate_boxes(
            _normalize_boxes(previous_item.final_annotation) if previous_item else [],
            _normalize_boxes(work_item.final_annotation),
            alpha=0.5,
        )
    work_item.video_qc = payload
    work_item.save()
    if payload.get("checked"):
        log_security_event(
            project=work_item.project,
            event_type=SecurityEvent.EVENT_VIDEO_QC,
            payload={"work_item_id": str(work_item.id), **payload},
            severity="warning" if payload.get("flag_for_review") else "info",
        )


def _project_readiness_gates(project: Project, overview: dict) -> list[dict]:
    task_type = _task_type(project)
    generic = overview.get("generic_tasks") or {}
    imports = overview.get("imports") or {}
    work_items = overview.get("work_items") or {}
    intervals = overview.get("intervals") or {}
    bbox_validation = overview.get("bbox_validation") or {}
    source_sync = overview.get("source_sync") or {}
    export = overview.get("export") or {}

    if task_type in {TASK_TEXT_ANNOTATION, TASK_CLASSIFICATION, TASK_COMPARISON}:
        return [
            {"key": "project_created", "label": "Проект создан", "ready": True},
            {"key": "tasks_created", "label": "Задания добавлены", "ready": int(generic.get("total") or 0) > 0},
            {"key": "answers_submitted", "label": "Ответы собираются", "ready": int(generic.get("completed") or 0) > 0},
            {"key": "export_ready", "label": "Экспорт доступен", "ready": int(generic.get("completed") or 0) > 0},
        ]

    if task_type == TASK_IMAGE_ANNOTATION:
        return [
            {"key": "project_created", "label": "Проект создан", "ready": True},
            {"key": "images_uploaded", "label": "Изображения загружены", "ready": int(imports.get("assets_total") or 0) > 0},
            {"key": "tasks_created", "label": "Задания созданы", "ready": int(generic.get("total") or 0) > 0},
            {"key": "labels_submitted", "label": "Метки собираются", "ready": int(generic.get("completed") or 0) > 0},
            {"key": "export_ready", "label": "Экспорт доступен", "ready": int(generic.get("completed") or 0) > 0},
        ]

    if task_type == TASK_VIDEO_ANNOTATION:
        return [
            {"key": "project_created", "label": "Проект создан", "ready": True},
            {"key": "video_uploaded", "label": "Видео загружено", "ready": bool(imports.get("video_asset_ids"))},
            {"key": "interval_chunks_assigned", "label": "Интервальные задания выданы", "ready": int(intervals.get("validation_assigned") or 0) > 0 or int(intervals.get("total") or 0) > 0},
            {"key": "intervals_submitted", "label": "Интервалы отправлены", "ready": int(intervals.get("total") or 0) > 0},
            {"key": "export_ready", "label": "Отчёт доступен", "ready": int(intervals.get("total") or 0) > 0},
        ]

    if task_type == TASK_VIDEO_INTERVAL_VALIDATION:
        return [
            {"key": "source_project_selected", "label": "Источник выбран", "ready": bool(source_sync.get("source_project_id"))},
            {"key": "source_synced", "label": "Интервалы синхронизированы", "ready": source_sync.get("status") == "synced"},
            {"key": "validators_assigned", "label": "Проверки назначены", "ready": int(intervals.get("validation_assigned") or 0) > 0},
            {"key": "validation_submitted", "label": "Решения собираются", "ready": int(intervals.get("validation_submitted") or 0) > 0},
            {"key": "report_ready", "label": "Отчёт доступен", "ready": int(intervals.get("approved") or 0) + int(intervals.get("rejected") or 0) > 0},
        ]

    if task_type == TASK_BBOX_VALIDATION:
        return [
            {"key": "source_project_selected", "label": "Источник выбран", "ready": bool(source_sync.get("source_project_id"))},
            {"key": "source_synced", "label": "Разметка синхронизирована", "ready": source_sync.get("status") == "synced"},
            {"key": "validation_batches_assigned", "label": "Пакеты проверки назначены", "ready": int(bbox_validation.get("assigned") or 0) > 0},
            {"key": "validation_submitted", "label": "Проверки собираются", "ready": int(bbox_validation.get("submitted") or 0) > 0},
            {"key": "report_ready", "label": "Отчёт доступен", "ready": int(bbox_validation.get("approved_items") or 0) + int(bbox_validation.get("needs_changes_items") or 0) > 0},
        ]

    return [
        {"key": "project_created", "label": "Проект создан", "ready": True},
        {"key": "media_uploaded", "label": "Медиа загружены", "ready": int(imports.get("assets_total") or 0) > 0},
        {"key": "work_items_created", "label": "Кадры подготовлены", "ready": int(work_items.get("total") or 0) > 0},
        {"key": "assignments_completed", "label": "Разметка выполняется", "ready": int(work_items.get("completed") or 0) > 0},
        {"key": "bbox_validated", "label": "Разметка проверена", "ready": int(work_items.get("validation_approved") or 0) > 0},
        {"key": "export_ready", "label": "Экспорт доступен", "ready": int(export.get("ready_items") or 0) > 0},
    ]


def _project_next_action(project: Project, overview: dict, readiness_gates: list[dict]) -> dict:
    task_type = _task_type(project)
    first_blocked = next((gate for gate in readiness_gates if not gate.get("ready")), None)
    if not first_blocked:
        return {"key": "export", "label": "Экспортировать датасет", "route": f"/projects/{project.id}", "severity": "success"}

    key = str(first_blocked.get("key") or "")
    if key in {"tasks_created", "pairs_created"}:
        return {"key": key, "label": "Добавить задания", "route": f"/projects/{project.id}", "severity": "info"}
    if key in {"images_uploaded", "media_uploaded", "video_uploaded"}:
        return {"key": key, "label": "Загрузить данные", "route": f"/projects/{project.id}", "severity": "info"}
    if key in {"source_project_selected", "source_synced"}:
        return {"key": key, "label": "Синхронизировать проект-источник", "route": f"/projects/{project.id}", "severity": "warning"}
    if task_type == TASK_VIDEO_ANNOTATION:
        return {"key": key, "label": "Открыть интервальную разметку", "route": f"/labeling/intervals?projectId={project.id}&stage=intervals", "severity": "info"}
    if task_type == TASK_VIDEO_INTERVAL_VALIDATION:
        return {"key": key, "label": "Открыть проверку интервалов", "route": f"/labeling/intervals?projectId={project.id}&stage=interval-validation", "severity": "info"}
    if task_type == TASK_BBOX_VALIDATION:
        return {"key": key, "label": "Открыть bbox-валидацию", "route": f"/labeling/bbox-validation?projectId={project.id}", "severity": "info"}
    if task_type in {TASK_TEXT_ANNOTATION, TASK_IMAGE_ANNOTATION, TASK_CLASSIFICATION, TASK_COMPARISON}:
        return {"key": key, "label": "Передать задания исполнителям", "route": f"/labeling/generic/{project.id}", "severity": "info"}
    return {"key": key, "label": "Продолжить bbox-разметку", "route": f"/labeling/projects/{project.id}", "severity": "info"}


def project_overview(project: Project) -> dict:
    imports = list(ImportSession.objects(project=project))
    assets = list(ImportAsset.objects(project=project))
    work_items = list(WorkItem.objects(project=project))
    assignments = list(Assignment.objects(project=project))
    reviews = list(ReviewRecord.objects(project=project))
    intervals = list(VideoInterval.objects(project=project))
    interval_validation_assignments = list(IntervalValidationAssignment.objects(project=project))
    bbox_validation_assignments = list(BBoxValidationAssignment.objects(project=project))
    generic_tasks = {}
    try:
        from apps.projects.services.generic_tasks import generic_task_summary, is_generic_task_project

        if is_generic_task_project(project):
            generic_tasks = generic_task_summary(project)
    except Exception:
        generic_tasks = {}
    raw_annotation_count = (
        WorkAnnotation.objects(
            work_item__in=work_items,
            status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED],
        ).count()
        if work_items
        else 0
    )
    consensus_annotation_count = sum(
        1
        for item in work_items
        if item.status == WorkItem.STATUS_COMPLETED and bool(_normalize_boxes(item.final_annotation))
    )
    validated_dataset_count = sum(
        1
        for item in work_items
        if item.status == WorkItem.STATUS_COMPLETED and item.validation_status == WorkItem.VALIDATION_APPROVED and bool(_normalize_boxes(item.final_annotation))
    )
    validation_report_count = sum(len(item.decisions or {}) for item in bbox_validation_assignments) + sum(
        1 for item in interval_validation_assignments if item.status == IntervalValidationAssignment.STATUS_SUBMITTED
    )
    export_artifacts = [
        {
            "artifact": "raw_annotations",
            "title": "Сырые разметки",
            "ready": raw_annotation_count > 0,
            "items_count": raw_annotation_count,
            "quality_level": "raw",
            "validated": False,
            "message": ""
            if raw_annotation_count > 0
            else "Сырые разметки появятся после первой отправленной bbox-разметки исполнителя.",
            "formats": ["json", "jsonl", "csv", "both"],
        },
        {
            "artifact": "consensus_annotations",
            "title": "Агрегированная разметка",
            "ready": consensus_annotation_count > 0,
            "items_count": consensus_annotation_count,
            "quality_level": "consensus",
            "validated": False,
            "message": ""
            if consensus_annotation_count > 0
            else "Агрегированная разметка появится после завершения consensus по work item.",
            "formats": ["json", "jsonl", "csv", "both"],
        },
        {
            "artifact": "validated_dataset",
            "title": "Проверенный датасет",
            "ready": validated_dataset_count > 0,
            "items_count": validated_dataset_count,
            "quality_level": "validated",
            "validated": True,
            "message": ""
            if validated_dataset_count > 0
            else "Проверенный датасет доступен только после approved validation.",
            "formats": ["coco", "yolo", "voc", "csv", "json", "jsonl", "both"],
        },
    ]
    if _is_task(project, TASK_BBOX_VALIDATION, TASK_VIDEO_INTERVAL_VALIDATION) or validation_report_count > 0:
        export_artifacts.append(
            {
                "artifact": "validation_report",
                "title": "Отчет валидации",
                "ready": validation_report_count > 0,
                "items_count": validation_report_count,
                "quality_level": "validation_report",
                "validated": False,
                "message": ""
                if validation_report_count > 0
                else "Отчет появится после первых отправленных решений валидаторов.",
                "formats": ["json", "jsonl", "csv", "both"],
            }
        )
    interval_agreements = [
        float((interval.metadata or {}).get("validation_agreement") or 0.0)
        for interval in intervals
        if (interval.metadata or {}).get("validation_agreement") is not None
    ]
    bbox_validation_summaries = [
        (item.workflow_meta or {}).get("bbox_validation_summary") or {}
        for item in work_items
        if (item.workflow_meta or {}).get("bbox_validation_summary")
    ]
    bbox_validation_agreements = [
        float(summary.get("agreement") or 0.0)
        for summary in bbox_validation_summaries
        if summary.get("status") != "pending"
    ]
    annotator_stats = []
    for membership in ProjectMembership.objects(project=project, role=ProjectMembership.ROLE_ANNOTATOR, is_active=True):
        user_assignments = [assignment for assignment in assignments if str(assignment.annotator.id) == str(membership.user.id)]
        annotator_stats.append(
            {
                "user_id": str(membership.user.id),
                "username": getattr(membership.user, "username", ""),
                "rating": getattr(membership.user, "rating", 0.0),
                "open_assignments": sum(1 for assignment in user_assignments if assignment.status in [Assignment.STATUS_ASSIGNED, Assignment.STATUS_IN_PROGRESS, Assignment.STATUS_DRAFT]),
                "submitted_assignments": sum(1 for assignment in user_assignments if assignment.status in [Assignment.STATUS_SUBMITTED, Assignment.STATUS_ACCEPTED, Assignment.STATUS_REJECTED]),
                "conflict_rate": getattr(membership.user, "conflict_rate", 0.0),
            }
        )
    overview = {
        "project_id": str(project.id),
        "project": {
            "title": project.title,
            "status": project.status,
            "project_type": project.project_type,
            "annotation_type": project.annotation_type,
            "task_type": _task_type(project),
            "widget_type": getattr(project, "widget_type", "") or "",
            "source_project_id": str(project.source_project.id) if getattr(project, "source_project", None) else None,
            "source_project_title": project.source_project.title if getattr(project, "source_project", None) else "",
        },
        "source_sync": source_sync_summary(project),
        "imports": {
            "total": len(imports),
            "draft": sum(1 for import_session in imports if import_session.status == ImportSession.STATUS_DRAFT),
            "ready": sum(1 for import_session in imports if import_session.status == ImportSession.STATUS_READY),
            "finalized": sum(1 for import_session in imports if import_session.status == ImportSession.STATUS_FINALIZED),
            "failed": sum(1 for import_session in imports if import_session.status == ImportSession.STATUS_FAILED),
            "latest_ready_import_id": str(
                sorted(
                    [import_session for import_session in imports if import_session.status == ImportSession.STATUS_READY],
                    key=lambda import_session: import_session.updated_at or import_session.created_at,
                    reverse=True,
                )[0].id
            )
            if any(import_session.status == ImportSession.STATUS_READY for import_session in imports)
            else "",
            "assets_total": len(assets),
            "video_asset_ids": [str(asset.id) for asset in assets if asset.asset_type == ImportAsset.TYPE_VIDEO],
            "assets_failed": sum(1 for asset in assets if asset.processing_status == ImportAsset.STATUS_FAILED),
            "frames_total": sum(asset.frame_count for asset in assets),
        },
        "work_items": {
            "total": len(work_items),
            "pending": sum(1 for item in work_items if item.status == WorkItem.STATUS_PENDING),
            "in_review": sum(1 for item in work_items if item.status == WorkItem.STATUS_IN_REVIEW),
            "completed": sum(1 for item in work_items if item.status == WorkItem.STATUS_COMPLETED),
            "validation_pending": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_PENDING),
            "validation_approved": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_APPROVED),
            "validation_needs_changes": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_NEEDS_CHANGES),
            "validation_disputed": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_DISPUTED),
            "insufficient_annotators": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS),
            "insufficient_validators": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_INSUFFICIENT_VALIDATORS),
            "average_agreement": round(sum(item.agreement_score for item in work_items) / len(work_items), 4) if work_items else 0.0,
            "workflow_batches_total": len({item.workflow_meta.get("task_batch_id") for item in work_items if item.workflow_meta.get("task_batch_id")}),
            "validation_ready_items": sum(1 for item in work_items if item.workflow_meta.get("validation_ready")),
        },
        "export": {
            "ready_items": validated_dataset_count,
            "blocked_items": sum(1 for item in work_items if not (item.status == WorkItem.STATUS_COMPLETED and item.validation_status == WorkItem.VALIDATION_APPROVED)),
            "readiness_rate": round(
                validated_dataset_count / len(work_items),
                4,
            )
            if work_items
            else 0.0,
            "pending_validation_items": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_PENDING),
            "disputed_items": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_DISPUTED),
            "insufficient_items": sum(
                1
                for item in work_items
                if item.validation_status
                in {
                    WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS,
                    WorkItem.VALIDATION_INSUFFICIENT_VALIDATORS,
                }
            ),
            "artifacts": export_artifacts,
        },
        "intervals": {
            "total": len(intervals),
            "draft": sum(1 for item in intervals if item.status == VideoInterval.STATUS_DRAFT),
            "approved": sum(1 for item in intervals if item.status == VideoInterval.STATUS_APPROVED),
            "rejected": sum(1 for item in intervals if item.status == VideoInterval.STATUS_REJECTED),
            "disputed": sum(1 for item in intervals if item.status == VideoInterval.STATUS_DISPUTED),
            "insufficient_validators": sum(1 for item in intervals if item.status == VideoInterval.STATUS_INSUFFICIENT_VALIDATORS),
            "validation_assigned": sum(1 for item in interval_validation_assignments if item.status == IntervalValidationAssignment.STATUS_ASSIGNED),
            "validation_submitted": sum(1 for item in interval_validation_assignments if item.status == IntervalValidationAssignment.STATUS_SUBMITTED),
            "average_validation_agreement": round(sum(interval_agreements) / len(interval_agreements), 4) if interval_agreements else 0.0,
        },
        "bbox_validation": {
            "assigned": sum(1 for item in bbox_validation_assignments if item.status == BBoxValidationAssignment.STATUS_ASSIGNED),
            "submitted": sum(1 for item in bbox_validation_assignments if item.status == BBoxValidationAssignment.STATUS_SUBMITTED),
            "pending_items": sum(1 for summary in bbox_validation_summaries if summary.get("status") == "pending"),
            "approved_items": sum(1 for summary in bbox_validation_summaries if summary.get("status") == "approved"),
            "needs_changes_items": sum(1 for summary in bbox_validation_summaries if summary.get("status") == "needs_changes"),
            "disputed_items": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_DISPUTED),
            "insufficient_validator_items": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_INSUFFICIENT_VALIDATORS),
            "average_agreement": round(sum(bbox_validation_agreements) / len(bbox_validation_agreements), 4) if bbox_validation_agreements else 0.0,
        },
        "generic_tasks": generic_tasks,
        "golden": {
            "active": GoldenFrame.objects(project=project, status=GoldenFrame.STATUS_ACTIVE).count(),
            "candidates": GoldenFrame.objects(project=project, status=GoldenFrame.STATUS_CANDIDATE).count(),
            "retired": GoldenFrame.objects(project=project, status=GoldenFrame.STATUS_RETIRED).count(),
            "state": "active" if GoldenFrame.objects(project=project, status=GoldenFrame.STATUS_ACTIVE).count() else "bootstrap",
        },
        "workflow_settings": workflow_runtime_settings(project),
        "assignments": {
            "total": len(assignments),
            "assigned": sum(1 for item in assignments if item.status == Assignment.STATUS_ASSIGNED),
            "in_progress": sum(1 for item in assignments if item.status == Assignment.STATUS_IN_PROGRESS),
            "draft": sum(1 for item in assignments if item.status == Assignment.STATUS_DRAFT),
            "submitted": sum(1 for item in assignments if item.status == Assignment.STATUS_SUBMITTED),
            "accepted": sum(1 for item in assignments if item.status == Assignment.STATUS_ACCEPTED),
            "rejected": sum(1 for item in assignments if item.status == Assignment.STATUS_REJECTED),
            "disputed": sum(1 for item in assignments if item.status == Assignment.STATUS_DISPUTED),
        },
        "reviews": {
            "pending": sum(1 for review in reviews if review.status == ReviewRecord.STATUS_PENDING),
            "resolved": sum(1 for review in reviews if review.status == ReviewRecord.STATUS_RESOLVED),
            "golden_average": round(sum(float(review.golden_score or 0.0) for review in reviews) / len(reviews), 4) if reviews else 0.0,
        },
        "annotators": annotator_stats,
    }
    spec = TASK_TYPE_SPECS.get(_task_type(project))
    overview["task_contract"] = spec.to_dict() if spec else {}
    overview["readiness_gates"] = _project_readiness_gates(project, overview)
    overview["next_action"] = _project_next_action(project, overview, overview["readiness_gates"])
    return overview


def ensure_bbox_annotation_assignments(project: Project, max_items: int | None = None) -> int:
    required_assignments = max(1, int(project.assignments_per_task or 1))
    candidates = select_annotators_for_project(project, max(50, required_assignments * 3), stage="bbox_annotation")
    if not candidates:
        return 0
    local_assignment_counts: Dict[str, int] = {
        str(user.id): Assignment.objects(
            project=project,
            annotator=user,
            status__in=[Assignment.STATUS_ASSIGNED, Assignment.STATUS_IN_PROGRESS, Assignment.STATUS_DRAFT],
        ).count()
        for user in candidates
    }
    created = 0
    work_items_query = WorkItem.objects(project=project, status=WorkItem.STATUS_PENDING).order_by("created_at")
    work_items = list(work_items_query.limit(max_items)) if max_items else list(work_items_query)
    queue_position = _next_queue_position(project)
    active_statuses = [
        Assignment.STATUS_ASSIGNED,
        Assignment.STATUS_IN_PROGRESS,
        Assignment.STATUS_DRAFT,
        Assignment.STATUS_SUBMITTED,
        Assignment.STATUS_ACCEPTED,
    ]
    for work_item in work_items:
        active_assignments = list(Assignment.objects(work_item=work_item, status__in=active_statuses))
        if len(active_assignments) >= required_assignments:
            continue
        existing_annotator_ids = {str(assignment.annotator.id) for assignment in Assignment.objects(work_item=work_item)}
        available = sorted(
            [user for user in candidates if str(user.id) not in existing_annotator_ids],
            key=lambda user: (local_assignment_counts.get(str(user.id), 0), str(user.id)),
        )
        missing = required_assignments - len(active_assignments)
        if not available:
            if work_item.validation_status in {
                WorkItem.VALIDATION_PENDING,
                WorkItem.VALIDATION_NEEDS_CHANGES,
                WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS,
            }:
                _mark_work_item_validation_blocked(
                    work_item,
                    WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS,
                    "Not enough independent annotators are available for bbox annotation",
                    {
                        "required_assignments": required_assignments,
                        "active_assignments": len(active_assignments),
                        "candidate_annotators": len(candidates),
                    },
                )
            continue
        for annotator in available[:missing]:
            next_order = Assignment.objects(work_item=work_item).count()
            Assignment(
                project=project,
                work_item=work_item,
                annotator=annotator,
                order_index=next_order,
                queue_position=queue_position,
                status=Assignment.STATUS_ASSIGNED,
            ).save()
            local_assignment_counts[str(annotator.id)] = local_assignment_counts.get(str(annotator.id), 0) + 1
            queue_position += 1
            created += 1
            if work_item.validation_status == WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS:
                work_item.validation_status = WorkItem.VALIDATION_PENDING
                work_item.validation_comment = ""
                _workflow_meta_set(work_item, quality_state=WorkItem.VALIDATION_PENDING, blocked_reason="")
                work_item.save()
            log_security_event(
                project=project,
                event_type=SecurityEvent.EVENT_ASSIGNMENT_DISTRIBUTION,
                payload={"work_item_id": str(work_item.id), "annotator_id": str(annotator.id), "reason": "auto_distribution"},
            )
    return created


def ensure_interval_chunk_assignments(project: Project) -> int:
    if not _is_task(project, TASK_VIDEO_ANNOTATION):
        return 0
    required_annotations = workflow_runtime_settings(project)["interval_annotators_per_chunk"]
    candidates = select_annotators_for_project(project, max(50, required_annotations * 3), stage="interval_annotation")
    if not candidates:
        return 0
    local_counts: Dict[str, int] = {
        str(user.id): VideoChunkAssignment.objects(
            project=project,
            annotator=user,
            status__in=[VideoChunkAssignment.STATUS_ASSIGNED, VideoChunkAssignment.STATUS_IN_PROGRESS],
        ).count()
        for user in candidates
    }
    created = 0
    for task in VideoChunkTask.objects(project=project, status__in=[VideoChunkTask.STATUS_PENDING, VideoChunkTask.STATUS_IN_PROGRESS]).order_by("created_at"):
        task.required_annotations = required_annotations
        task.save()
        active_assignments = list(
            VideoChunkAssignment.objects(
                task=task,
                status__in=[
                    VideoChunkAssignment.STATUS_ASSIGNED,
                    VideoChunkAssignment.STATUS_IN_PROGRESS,
                    VideoChunkAssignment.STATUS_SUBMITTED,
                    VideoChunkAssignment.STATUS_ACCEPTED,
                ],
            )
        )
        if len(active_assignments) >= required_annotations:
            continue
        existing_ids = {str(assignment.annotator.id) for assignment in VideoChunkAssignment.objects(task=task)}
        available = sorted(
            [user for user in candidates if str(user.id) not in existing_ids],
            key=lambda user: (local_counts.get(str(user.id), 0), str(user.id)),
        )
        for annotator in available[: max(0, required_annotations - len(active_assignments))]:
            VideoChunkAssignment(task=task, project=project, annotator=annotator).save()
            local_counts[str(annotator.id)] = local_counts.get(str(annotator.id), 0) + 1
            created += 1
    return created


def _set_source_sync(project: Project, *, status: str, created: int = 0, skipped: int = 0, errors: Optional[List[str]] = None, details: Optional[dict] = None) -> None:
    source_config = getattr(project, "source_config", {}) or {}
    source_config["materialization"] = {
        "status": status,
        "created": int(created or 0),
        "skipped": int(skipped or 0),
        "errors": errors or [],
        "details": details or {},
        "synced_at": datetime.utcnow().isoformat() if status in {"synced", "failed"} else "",
    }
    project.source_config = source_config
    project.save()


def source_sync_summary(project: Project) -> dict:
    source_project = getattr(project, "source_project", None)
    materialization = ((getattr(project, "source_config", {}) or {}).get("materialization") or {})
    requires_source = _is_task(project, TASK_VIDEO_INTERVAL_VALIDATION, TASK_BBOX_VALIDATION)
    return {
        "required": requires_source,
        "status": materialization.get("status") or ("not_synced" if requires_source else "not_required"),
        "created": int(materialization.get("created") or 0),
        "skipped": int(materialization.get("skipped") or 0),
        "errors": materialization.get("errors") or [],
        "details": materialization.get("details") or {},
        "synced_at": materialization.get("synced_at") or "",
        "source_project_id": str(source_project.id) if source_project else None,
        "source_project_title": source_project.title if source_project else "",
    }


def materialize_interval_validation_source(project: Project) -> int:
    source_project = getattr(project, "source_project", None)
    if not source_project or not _is_task(project, TASK_VIDEO_INTERVAL_VALIDATION):
        if _is_task(project, TASK_VIDEO_INTERVAL_VALIDATION):
            _set_source_sync(project, status="failed", errors=["source_project_missing"])
        return 0
    source_config = getattr(project, "source_config", {}) or {}
    statuses = source_config.get("interval_statuses") or [VideoInterval.STATUS_DRAFT]
    created = 0
    skipped = 0
    errors: List[str] = []
    for source_interval in VideoInterval.objects(project=source_project, status__in=statuses).order_by("created_at"):
        source_id = str(source_interval.id)
        exists = [
            interval
            for interval in VideoInterval.objects(project=project)
            if (interval.metadata or {}).get("source_interval_id") == source_id
        ]
        if exists:
            skipped += 1
            continue
        VideoInterval(
            project=project,
            asset=source_interval.asset,
            start_frame=source_interval.start_frame,
            end_frame=source_interval.end_frame,
            start_sec=source_interval.start_sec,
            end_sec=source_interval.end_sec,
            status=VideoInterval.STATUS_DRAFT,
            source=source_interval.source,
            confidence=source_interval.confidence,
            metadata={
                **(source_interval.metadata or {}),
                "source_project_id": str(source_project.id),
                "source_interval_id": source_id,
                "source_asset_id": str(source_interval.asset.id),
            },
            created_by=source_interval.created_by,
        ).save()
        created += 1
    _set_source_sync(
        project,
        status="synced",
        created=created,
        skipped=skipped,
        errors=errors,
        details={"source_type": TASK_VIDEO_ANNOTATION, "statuses": statuses},
    )
    return created


def _source_work_item_author_ids(work_item: WorkItem) -> list[str]:
    authors = [
        str(annotation.annotator.id)
        for annotation in WorkAnnotation.objects(work_item=work_item, status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED])
        if annotation.annotator
    ]
    return sorted(set(authors))


def materialize_bbox_validation_source(project: Project) -> int:
    source_project = getattr(project, "source_project", None)
    if not source_project or not _is_task(project, TASK_BBOX_VALIDATION):
        if _is_task(project, TASK_BBOX_VALIDATION):
            _set_source_sync(project, status="failed", errors=["source_project_missing"])
        return 0
    created = 0
    skipped = 0
    errors: List[str] = []
    source_items = list(
        WorkItem.objects(
            project=source_project,
            status=WorkItem.STATUS_COMPLETED,
        ).order_by("created_at")
    )
    for source_item in source_items:
        boxes = _normalize_boxes(source_item.final_annotation)
        if not boxes:
            skipped += 1
            continue
        source_id = str(source_item.id)
        exists = [
            item
            for item in WorkItem.objects(project=project)
            if (item.workflow_meta or {}).get("source_work_item_id") == source_id
        ]
        if exists:
            skipped += 1
            continue
        WorkItem(
            project=project,
            frame=source_item.frame,
            status=WorkItem.STATUS_COMPLETED,
            agreement_score=source_item.agreement_score,
            final_annotation={"boxes": boxes},
            final_source="source_project",
            pre_annotations={"boxes": boxes},
            validation_status=WorkItem.VALIDATION_PENDING,
            workflow_meta={
                "source_project_id": str(source_project.id),
                "source_work_item_id": source_id,
                "source_frame_id": str(source_item.frame.id),
                "source_author_ids": _source_work_item_author_ids(source_item),
                "validation_ready": True,
            },
        ).save()
        created += 1
    _set_source_sync(
        project,
        status="synced",
        created=created,
        skipped=skipped,
        errors=errors,
        details={"source_type": TASK_BBOX_ANNOTATION, "source_items_total": len(source_items)},
    )
    return created


def sync_project_workflow(project: Project) -> dict:
    """Refresh derived workflow state for old or partially migrated projects."""
    settings = workflow_runtime_settings(project)
    recovered = _recover_stuck_assignments(project)
    try:
        source_intervals_created = materialize_interval_validation_source(project)
        source_bbox_items_created = materialize_bbox_validation_source(project)
    except Exception as exc:
        _set_source_sync(project, status="failed", errors=[str(exc)])
        source_intervals_created = 0
        source_bbox_items_created = 0
    interval_annotation_created = ensure_interval_chunk_assignments(project)
    bbox_annotation_created = ensure_bbox_annotation_assignments(project) if _is_task(project, TASK_BBOX_ANNOTATION) else 0
    evaluated_items = 0
    accepted_items = 0
    requeued_or_blocked_items = 0

    for work_item in WorkItem.objects(project=project, status__in=[WorkItem.STATUS_PENDING, WorkItem.STATUS_IN_REVIEW]):
        submitted_count = WorkAnnotation.objects(work_item=work_item, status=WorkAnnotation.STATUS_SUBMITTED).count()
        if submitted_count < int(project.assignments_per_task or 1):
            continue
        result = evaluate_work_item(work_item)
        if not result:
            continue
        evaluated_items += 1
        if result.get("state") == "accepted":
            accepted_items += 1
        else:
            requeued_or_blocked_items += 1

    bbox_validation_repair = repair_submitted_bbox_validation(project) if _is_task(project, TASK_BBOX_VALIDATION) else 0
    interval_validation_created = ensure_interval_validation_assignments(
        project,
        min_validators=settings["interval_validators_per_item"],
    )
    bbox_validation_created = ensure_bbox_validation_assignments(
        project=project,
        min_validators=settings["bbox_validators_per_batch"],
        real_items_per_batch=settings["bbox_real_items_per_batch"],
        golden_items_per_batch=settings["bbox_golden_items_per_batch"],
    )
    overview = project_overview(project)
    overview["sync"] = {
        "recovered_assignments": recovered,
        "source_intervals_created": source_intervals_created,
        "source_bbox_items_created": source_bbox_items_created,
        "interval_annotation_created": interval_annotation_created,
        "bbox_annotation_created": bbox_annotation_created,
        "evaluated_items": evaluated_items,
        "accepted_items": accepted_items,
        "requeued_or_blocked_items": requeued_or_blocked_items,
        "interval_validation_created": interval_validation_created,
        "bbox_validation_created": bbox_validation_created,
        "bbox_validation_repair": bbox_validation_repair,
    }
    return overview


def _export_exclusion_reason(work_item: WorkItem) -> str:
    if work_item.status != WorkItem.STATUS_COMPLETED:
        return f"status_{work_item.status}"
    if work_item.validation_status != WorkItem.VALIDATION_APPROVED:
        return f"validation_{work_item.validation_status or WorkItem.VALIDATION_PENDING}"
    boxes = _normalize_boxes(work_item.final_annotation)
    if not boxes:
        return "missing_valid_boxes"
    if any(float(box.get("width") or 0) <= 0 or float(box.get("height") or 0) <= 0 for box in boxes):
        return "invalid_box_geometry"
    return ""


def _exportable_work_items(work_items: List[WorkItem]) -> List[WorkItem]:
    return [item for item in work_items if not _export_exclusion_reason(item)]


def _export_image_filename(work_item: WorkItem) -> str:
    suffix = Path(str(work_item.frame.frame_uri or "")).suffix.lower() or ".jpg"
    return f"{str(work_item.frame.id)}{suffix}"


def _split_export_items(project: Project, export_items: List[WorkItem]) -> List[dict]:
    if not export_items:
        return []
    ordered = sorted(
        export_items,
        key=lambda item: hashlib.sha256(f"{project.id}:{item.frame.id}".encode("utf-8")).hexdigest(),
    )
    val_count = 0
    if len(ordered) > 1:
        val_count = max(1, min(len(ordered) - 1, int(round(len(ordered) * 0.2))))
    val_ids = {str(item.id) for item in ordered[:val_count]}
    records = []
    for item in ordered:
        split = "val" if str(item.id) in val_ids else "train"
        image_filename = _export_image_filename(item)
        records.append(
            {
                "work_item": item,
                "split": split,
                "image_filename": image_filename,
                "image_path": f"images/{split}/{image_filename}",
                "label_path": f"labels/{split}/{str(item.frame.id)}.txt",
            }
        )
    return records


def _export_manifest(export_records: List[dict]) -> List[dict]:
    manifest_items = []
    for record in export_records:
        work_item = record["work_item"]
        frame = work_item.frame
        manifest_items.append(
            {
                "work_item_id": str(work_item.id),
                "frame_id": str(frame.id),
                "frame_uri": frame.frame_uri,
                "image_path": record["image_path"],
                "split": record["split"],
                "source_asset_id": str(frame.asset.id),
                "agreement_score": work_item.agreement_score,
                "review_status": work_item.review_status,
                "final_source": work_item.final_source,
                "validation_status": work_item.validation_status,
            }
        )
    return manifest_items


def _quality_report(
    project: Project,
    work_items: List[WorkItem],
    assignments: List[Assignment],
    reviews: List[ReviewRecord],
    artifact: str = "validated_dataset",
) -> dict:
    completed = [item for item in work_items if item.status == WorkItem.STATUS_COMPLETED]
    pending_review = [item for item in work_items if item.status == WorkItem.STATUS_IN_REVIEW]
    rejected = [item for item in work_items if item.review_required and item.status != WorkItem.STATUS_COMPLETED]
    agreement_values = [item.agreement_score for item in completed if item.agreement_score is not None]
    exportable_items = _exportable_work_items(work_items)
    export_records = _split_export_items(project, exportable_items)
    excluded_by_reason: Dict[str, int] = {}
    excluded_items = []
    for item in work_items:
        reason = _export_exclusion_reason(item)
        if not reason:
            continue
        excluded_by_reason[reason] = excluded_by_reason.get(reason, 0) + 1
        excluded_items.append(
            {
                "work_item_id": str(item.id),
                "frame_id": str(item.frame.id),
                "frame_uri": item.frame.frame_uri,
                "reason": reason,
                "status": item.status,
                "validation_status": item.validation_status,
            }
        )
    total = len(work_items)
    return {
        "project_id": str(project.id),
        "version": 2,
        "artifact": artifact,
        "quality_level": "validated" if artifact == "validated_dataset" else "project_result",
        "validated": artifact == "validated_dataset",
        "included": len(exportable_items),
        "excluded": len(excluded_items),
        "warning": ""
        if artifact == "validated_dataset"
        else "This export is a project result artifact and is not a final validated dataset.",
        "work_items_total": total,
        "work_items_completed": len(completed),
        "work_items_in_review": len(pending_review),
        "work_items_rejected_or_flagged": len(rejected),
        "validation": {
            "pending": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_PENDING),
            "approved": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_APPROVED),
            "needs_changes": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_NEEDS_CHANGES),
            "disputed": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_DISPUTED),
            "insufficient_annotators": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS),
            "insufficient_validators": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_INSUFFICIENT_VALIDATORS),
        },
        "completion_rate": round((len(completed) / total), 4) if total else 0.0,
        "average_agreement": round(sum(agreement_values) / len(agreement_values), 4) if agreement_values else 0.0,
        "export": {
            "ready": len(exportable_items) > 0,
            "included": len(exportable_items),
            "excluded": len(excluded_items),
            "message": "" if exportable_items else "No validated approved frames are available for dataset export yet.",
            "split": {
                "train": sum(1 for item in export_records if item["split"] == "train"),
                "val": sum(1 for item in export_records if item["split"] == "val"),
            },
            "excluded_by_reason": excluded_by_reason,
            "excluded_items": excluded_items,
        },
        "assignments": {
            "total": len(assignments),
            "accepted": sum(1 for item in assignments if item.status == Assignment.STATUS_ACCEPTED),
            "rejected": sum(1 for item in assignments if item.status == Assignment.STATUS_REJECTED),
            "submitted": sum(1 for item in assignments if item.status == Assignment.STATUS_SUBMITTED),
        },
        "reviews": {
            "pending": sum(1 for review in reviews if review.status == ReviewRecord.STATUS_PENDING),
            "resolved": sum(1 for review in reviews if review.status == ReviewRecord.STATUS_RESOLVED),
        },
        "golden": {
            "active": GoldenFrame.objects(project=project, status=GoldenFrame.STATUS_ACTIVE).count(),
            "candidates": GoldenFrame.objects(project=project, status=GoldenFrame.STATUS_CANDIDATE).count(),
            "retired": GoldenFrame.objects(project=project, status=GoldenFrame.STATUS_RETIRED).count(),
            "state": "active" if GoldenFrame.objects(project=project, status=GoldenFrame.STATUS_ACTIVE).count() else "bootstrap",
        },
    }


def _frame_payload(work_item: WorkItem) -> dict:
    frame = work_item.frame
    return {
        "frame_id": str(frame.id),
        "frame_uri": frame.frame_uri,
        "source_asset_id": str(frame.asset.id),
        "frame_number": frame.frame_number,
        "timestamp_sec": frame.timestamp_sec,
        "width": frame.width,
        "height": frame.height,
    }


def _artifact_project_payload(project: Project, export_format: str, artifact: str) -> dict:
    return {
        "id": str(project.id),
        "title": project.title,
        "annotation_type": project.annotation_type,
        "task_type": _task_type(project),
        "widget_type": getattr(project, "widget_type", "") or "",
        "source_project_id": str(project.source_project.id) if getattr(project, "source_project", None) else None,
        "source_project_title": project.source_project.title if getattr(project, "source_project", None) else "",
        "export_format": export_format,
        "artifact": artifact,
    }


def _raw_annotation_rows(project: Project) -> List[dict]:
    rows: List[dict] = []
    work_items = list(WorkItem.objects(project=project))
    for annotation in WorkAnnotation.objects(work_item__in=work_items, status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED]).order_by("created_at"):
        work_item = annotation.work_item
        assignment = annotation.assignment
        rows.append(
            {
                "annotation_id": str(annotation.id),
                "assignment_id": str(assignment.id) if assignment else "",
                "work_item_id": str(work_item.id),
                **_frame_payload(work_item),
                "annotator_id": str(annotation.annotator.id) if annotation.annotator else "",
                "annotator_username": getattr(annotation.annotator, "username", "") if annotation.annotator else "",
                "annotation_status": annotation.status,
                "assignment_status": assignment.status if assignment else "",
                "is_final": bool(annotation.is_final),
                "comment": annotation.comment or "",
                "label_data": annotation.label_data or {},
                "boxes": _normalize_boxes(annotation.label_data),
                "work_item_status": work_item.status,
                "validation_status": work_item.validation_status,
                "agreement_score": work_item.agreement_score,
                "created_at": annotation.created_at.isoformat() if annotation.created_at else "",
                "updated_at": annotation.updated_at.isoformat() if annotation.updated_at else "",
            }
        )
    return rows


def _consensus_annotation_rows(project: Project) -> List[dict]:
    rows: List[dict] = []
    for work_item in WorkItem.objects(project=project, status=WorkItem.STATUS_COMPLETED).order_by("created_at"):
        boxes = _normalize_boxes(work_item.final_annotation)
        if not boxes:
            continue
        rows.append(
            {
                "work_item_id": str(work_item.id),
                **_frame_payload(work_item),
                "final_source": work_item.final_source,
                "final_annotation": {"boxes": boxes},
                "boxes": boxes,
                "validation_status": work_item.validation_status,
                "validation_comment": work_item.validation_comment or "",
                "agreement_score": work_item.agreement_score,
                "review_status": work_item.review_status,
                "workflow_meta": work_item.workflow_meta or {},
                "created_at": work_item.created_at.isoformat() if work_item.created_at else "",
                "updated_at": work_item.updated_at.isoformat() if work_item.updated_at else "",
            }
        )
    return rows


def _validation_report_rows(project: Project) -> List[dict]:
    rows: List[dict] = []
    work_item_lookup = {str(item.id): item for item in WorkItem.objects(project=project)}
    for assignment in BBoxValidationAssignment.objects(project=project).order_by("created_at"):
        decisions = assignment.decisions or {}
        if not decisions:
            rows.append(
                {
                    "validation_assignment_id": str(assignment.id),
                    "validation_type": "bbox",
                    "validator_id": str(assignment.validator.id) if assignment.validator else "",
                    "validator_username": getattr(assignment.validator, "username", "") if assignment.validator else "",
                    "assignment_status": assignment.status,
                    "decision": "",
                    "golden_score": assignment.golden_score,
                    "work_item_id": "",
                    "source_project_id": str(project.source_project.id) if getattr(project, "source_project", None) else "",
                    "source_work_item_id": "",
                    "comment": "",
                    "created_at": assignment.created_at.isoformat() if assignment.created_at else "",
                    "updated_at": assignment.updated_at.isoformat() if assignment.updated_at else "",
                }
            )
            continue
        for work_item_id, decision in decisions.items():
            work_item = work_item_lookup.get(str(work_item_id))
            workflow_meta = work_item.workflow_meta if work_item else {}
            row = {
                "validation_assignment_id": str(assignment.id),
                "validation_type": "bbox",
                "validator_id": str(assignment.validator.id) if assignment.validator else "",
                "validator_username": getattr(assignment.validator, "username", "") if assignment.validator else "",
                "assignment_status": assignment.status,
                "decision": decision,
                "golden_score": assignment.golden_score,
                "work_item_id": str(work_item.id) if work_item else str(work_item_id),
                "source_project_id": workflow_meta.get("source_project_id") or (str(project.source_project.id) if getattr(project, "source_project", None) else ""),
                "source_work_item_id": workflow_meta.get("source_work_item_id") or "",
                "source_frame_id": workflow_meta.get("source_frame_id") or "",
                "work_item_validation_status": work_item.validation_status if work_item else "",
                "work_item_validation_comment": work_item.validation_comment if work_item else "",
                "comment": "",
                "created_at": assignment.created_at.isoformat() if assignment.created_at else "",
                "updated_at": assignment.updated_at.isoformat() if assignment.updated_at else "",
            }
            if work_item:
                row.update(_frame_payload(work_item))
            rows.append(row)

    for assignment in IntervalValidationAssignment.objects(project=project).order_by("created_at"):
        interval = assignment.interval
        rows.append(
            {
                "validation_assignment_id": str(assignment.id),
                "validation_type": "video_interval",
                "validator_id": str(assignment.validator.id) if assignment.validator else "",
                "validator_username": getattr(assignment.validator, "username", "") if assignment.validator else "",
                "assignment_status": assignment.status,
                "decision": assignment.decision or "",
                "comment": assignment.comment or "",
                "interval_id": str(interval.id),
                "interval_status": interval.status,
                "source_project_id": (interval.metadata or {}).get("source_project_id") or (str(project.source_project.id) if getattr(project, "source_project", None) else ""),
                "source_interval_id": (interval.metadata or {}).get("source_interval_id") or "",
                "asset_id": str(interval.asset.id),
                "start_frame": interval.start_frame,
                "end_frame": interval.end_frame,
                "start_sec": interval.start_sec,
                "end_sec": interval.end_sec,
                "created_at": assignment.created_at.isoformat() if assignment.created_at else "",
                "updated_at": assignment.updated_at.isoformat() if assignment.updated_at else "",
            }
        )
    return rows


def _tabular_artifact_payload(project: Project, artifact: str, rows: List[dict], export_format: str, quality_level: str, validated: bool, warning: str) -> dict:
    payload = {
        "export_version": 1,
        "generated_at": datetime.utcnow().isoformat(),
        "project": _artifact_project_payload(project, export_format, artifact),
        "quality_report": {
            "project_id": str(project.id),
            "artifact": artifact,
            "quality_level": quality_level,
            "validated": validated,
            "included": len(rows),
            "excluded": 0,
            "ready": len(rows) > 0,
            "warning": warning,
            "message": "" if rows else "No items are available for this project result artifact yet.",
        },
    }
    if export_format in {"json", "both"}:
        payload["json"] = rows
    if export_format in {"jsonl", "both"}:
        payload["jsonl"] = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    if export_format in {"csv", "both"}:
        payload["csv"] = rows
    return payload


def build_project_artifact_export(project: Project, artifact: str, export_format: str = "both") -> dict:
    if artifact == "raw_annotations":
        return _tabular_artifact_payload(
            project,
            artifact,
            _raw_annotation_rows(project),
            export_format,
            quality_level="raw",
            validated=False,
            warning="This export contains individual submitted annotations and is not a final validated dataset.",
        )
    if artifact == "consensus_annotations":
        return _tabular_artifact_payload(
            project,
            artifact,
            _consensus_annotation_rows(project),
            export_format,
            quality_level="consensus",
            validated=False,
            warning="This export contains aggregated project annotations; validation approval is not required for inclusion.",
        )
    if artifact == "validation_report":
        return _tabular_artifact_payload(
            project,
            artifact,
            _validation_report_rows(project),
            export_format,
            quality_level="validation_report",
            validated=False,
            warning="This export is a validation process report, not a final training dataset.",
        )
    return build_dataset_export(project, export_format=export_format)


def build_project_artifact_export_archive(project: Project, artifact: str, export_format: str = "both") -> tuple[str, bytes]:
    payload = build_project_artifact_export(project, artifact=artifact, export_format=export_format)
    archive_stream = io.BytesIO()
    with zipfile.ZipFile(archive_stream, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("export_manifest.json", json.dumps({k: payload[k] for k in ("export_version", "generated_at", "project")}, ensure_ascii=False, indent=2))
        bundle.writestr("quality_report.json", json.dumps(payload.get("quality_report", {}), ensure_ascii=False, indent=2))
        if "json" in payload:
            bundle.writestr(f"{artifact}.json", json.dumps(payload.get("json", []), ensure_ascii=False, indent=2))
        if "jsonl" in payload:
            bundle.writestr(f"{artifact}.jsonl", payload.get("jsonl", ""))
        if "csv" in payload:
            bundle.writestr(f"{artifact}.csv", _csv_rows_to_text(payload.get("csv", [])))
        if not any(key in payload for key in ("json", "jsonl", "csv")):
            bundle.writestr("README_NO_EXPORTABLE_ITEMS.txt", "No items are available for this project result artifact yet.\n")
    return f"project_{project.id}_{artifact}_{export_format}.zip", archive_stream.getvalue()


def _coco_categories(project: Project) -> tuple[list[dict], dict[str, int]]:
    categories = []
    category_lookup = {}
    for index, label in enumerate(project.label_schema or [], start=1):
        name = label.get("name") or label.get("label") or f"label_{index}"
        category_lookup[name] = index
        categories.append({"id": index, "name": name})
    return categories, category_lookup


def _build_coco_export(project: Project, export_records: List[dict]) -> dict:
    categories, category_lookup = _coco_categories(project)
    datasets = {
        "train": {"images": [], "annotations": [], "categories": categories},
        "val": {"images": [], "annotations": [], "categories": categories},
    }
    annotation_ids = {"train": 1, "val": 1}
    for record in export_records:
        work_item = record["work_item"]
        frame = work_item.frame
        image_id = str(frame.id)
        split = record["split"]
        datasets[split]["images"].append(
            {
                "id": image_id,
                "file_name": record["image_path"],
                "width": frame.width,
                "height": frame.height,
                "frame_number": frame.frame_number,
                "timestamp_sec": frame.timestamp_sec,
            }
        )
        boxes = _normalize_boxes(work_item.final_annotation)
        for box in boxes:
            category_id = category_lookup.get(box["label"])
            if not category_id:
                category_id = len(category_lookup) + 1
                category_lookup[box["label"]] = category_id
                categories.append({"id": category_id, "name": box["label"]})
            datasets[split]["annotations"].append(
                {
                    "id": annotation_ids[split],
                    "image_id": image_id,
                    "category_id": category_id,
                    "bbox": [box["x"], box["y"], box["width"], box["height"]],
                    "area": box["width"] * box["height"],
                    "iscrowd": 0,
                }
            )
            annotation_ids[split] += 1
    return {"coco": datasets}


def _build_yolo_export(project: Project, export_records: List[dict]) -> dict:
    category_lookup: Dict[str, int] = {}
    for index, label in enumerate(project.label_schema or []):
        name = str(label.get("name") or label.get("label") or f"label_{index}").strip()
        if name and name not in category_lookup:
            category_lookup[name] = len(category_lookup)
    labels_txt = [name for name, _idx in sorted(category_lookup.items(), key=lambda item: item[1])]
    records: List[dict] = []
    for record in export_records:
        work_item = record["work_item"]
        frame = work_item.frame
        image_width = max(float(frame.width or 0), 1.0)
        image_height = max(float(frame.height or 0), 1.0)
        yolo_lines: List[str] = []
        for box in _normalize_boxes(work_item.final_annotation):
            label = box["label"]
            if label not in category_lookup:
                category_lookup[label] = len(category_lookup)
                labels_txt.append(label)
            class_id = category_lookup[label]
            x_center = (box["x"] + box["width"] / 2.0) / image_width
            y_center = (box["y"] + box["height"] / 2.0) / image_height
            width = box["width"] / image_width
            height = box["height"] / image_height
            yolo_lines.append(f"{class_id} {x_center:.6f} {y_center:.6f} {width:.6f} {height:.6f}")
        records.append(
            {
                "frame_uri": frame.frame_uri,
                "image_path": record["image_path"],
                "label_file": record["label_path"],
                "split": record["split"],
                "lines": yolo_lines,
            }
        )
    return {
        "labels": labels_txt,
        "data_yaml": {
            "path": ".",
            "train": "images/train",
            "val": "images/val",
            "names": labels_txt,
        },
        "records": records,
    }


def _voc_xml(work_item: WorkItem, image_path: str) -> str:
    frame = work_item.frame
    annotation = ET.Element("annotation")
    ET.SubElement(annotation, "filename").text = Path(image_path).name
    ET.SubElement(annotation, "path").text = image_path
    source = ET.SubElement(annotation, "source")
    ET.SubElement(source, "database").text = "Datasets Project"
    size = ET.SubElement(annotation, "size")
    ET.SubElement(size, "width").text = str(int(frame.width or 0))
    ET.SubElement(size, "height").text = str(int(frame.height or 0))
    ET.SubElement(size, "depth").text = "3"
    ET.SubElement(annotation, "segmented").text = "0"
    for box in _normalize_boxes(work_item.final_annotation):
        obj = ET.SubElement(annotation, "object")
        ET.SubElement(obj, "name").text = box["label"]
        ET.SubElement(obj, "pose").text = "Unspecified"
        ET.SubElement(obj, "truncated").text = "0"
        ET.SubElement(obj, "difficult").text = "0"
        bndbox = ET.SubElement(obj, "bndbox")
        ET.SubElement(bndbox, "xmin").text = str(int(round(box["x"])))
        ET.SubElement(bndbox, "ymin").text = str(int(round(box["y"])))
        ET.SubElement(bndbox, "xmax").text = str(int(round(box["x"] + box["width"])))
        ET.SubElement(bndbox, "ymax").text = str(int(round(box["y"] + box["height"])))
    return ET.tostring(annotation, encoding="unicode")


def _build_voc_export(export_records: List[dict]) -> dict:
    records: List[dict] = []
    for record in export_records:
        work_item = record["work_item"]
        annotation_file = f"annotations/voc/{record['split']}/{str(work_item.frame.id)}.xml"
        records.append(
            {
                "split": record["split"],
                "image_path": record["image_path"],
                "annotation_file": annotation_file,
                "xml": _voc_xml(work_item, record["image_path"]),
            }
        )
    return {"records": records}


def _build_csv_export(export_records: List[dict]) -> List[dict]:
    rows: List[dict] = []
    for record in export_records:
        work_item = record["work_item"]
        frame = work_item.frame
        boxes = _normalize_boxes(work_item.final_annotation)
        if not boxes:
            rows.append(
                {
                    "work_item_id": str(work_item.id),
                    "frame_id": str(frame.id),
                    "frame_uri": frame.frame_uri,
                    "image_path": record["image_path"],
                    "split": record["split"],
                    "source_asset_id": str(frame.asset.id),
                    "frame_number": frame.frame_number,
                    "timestamp_sec": frame.timestamp_sec,
                    "label": "",
                    "x": "",
                    "y": "",
                    "width": "",
                    "height": "",
                    "validation_status": work_item.validation_status,
                    "agreement_score": work_item.agreement_score,
                }
            )
            continue
        for box in boxes:
            rows.append(
                {
                    "work_item_id": str(work_item.id),
                    "frame_id": str(frame.id),
                    "frame_uri": frame.frame_uri,
                    "image_path": record["image_path"],
                    "split": record["split"],
                    "source_asset_id": str(frame.asset.id),
                    "frame_number": frame.frame_number,
                    "timestamp_sec": frame.timestamp_sec,
                    "label": box["label"],
                    "x": box["x"],
                    "y": box["y"],
                    "width": box["width"],
                    "height": box["height"],
                    "validation_status": work_item.validation_status,
                    "agreement_score": work_item.agreement_score,
                }
            )
    return rows


def build_dataset_export(project: Project, export_format: str = "both") -> dict:
    work_items = list(WorkItem.objects(project=project))
    export_items = _exportable_work_items(work_items)
    export_records = _split_export_items(project, export_items)
    assignments = list(Assignment.objects(project=project))
    reviews = list(ReviewRecord.objects(project=project))
    payload = {
        "export_version": 2,
        "generated_at": datetime.utcnow().isoformat(),
        "project": {
            "id": str(project.id),
            "title": project.title,
            "annotation_type": project.annotation_type,
            "export_format": export_format,
            "artifact": "validated_dataset",
        },
        "quality_report": _quality_report(project, work_items, assignments, reviews, artifact="validated_dataset"),
        "manifest": _export_manifest(export_records),
    }
    if export_format in {"coco", "both"}:
        payload.update(_build_coco_export(project, export_records))
    if export_format in {"yolo", "both"}:
        payload["yolo"] = _build_yolo_export(project, export_records)
    if export_format in {"voc", "both"}:
        payload["voc"] = _build_voc_export(export_records)
    if export_format in {"json", "jsonl", "both"}:
        rows = payload.get("manifest", [])
        if export_format in {"json", "both"}:
            payload["json"] = rows
        if export_format in {"jsonl", "both"}:
            payload["jsonl"] = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    if export_format in {"csv", "both"}:
        payload["csv"] = _build_csv_export(export_records)
    return payload


def _dump_yolo_yaml(data: dict) -> str:
    names = data.get("names") or []
    lines = [
        f"path: {data.get('path') or '.'}",
        f"train: {data.get('train') or 'images/train'}",
        f"val: {data.get('val') or 'images/val'}",
        "names:",
    ]
    for index, name in enumerate(names):
        safe_name = str(name).replace('"', '\\"')
        lines.append(f'  {index}: "{safe_name}"')
    return "\n".join(lines) + "\n"


def _csv_rows_to_text(rows: List[dict]) -> str:
    if not rows:
        return ""
    stream = io.StringIO()
    headers = list(rows[0].keys())
    writer = csv.DictWriter(stream, fieldnames=headers, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def build_dataset_export_archive(project: Project, export_format: str = "both") -> tuple[str, bytes]:
    payload = build_dataset_export(project, export_format=export_format)
    archive_stream = io.BytesIO()
    with zipfile.ZipFile(archive_stream, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("export_manifest.json", json.dumps({k: payload[k] for k in ("export_version", "generated_at", "project")}, ensure_ascii=False, indent=2))
        quality_report = payload.get("quality_report", {})
        bundle.writestr("quality_report.json", json.dumps(quality_report, ensure_ascii=False, indent=2))
        bundle.writestr("manifest.json", json.dumps(payload.get("manifest", []), ensure_ascii=False, indent=2))
        if not payload.get("manifest"):
            bundle.writestr(
                "README_NO_EXPORTABLE_ITEMS.txt",
                "No validated approved frames are available for dataset export yet. See quality_report.json for excluded items and reasons.\n",
            )
        if "coco" in payload:
            coco = payload["coco"]
            bundle.writestr("annotations/coco/instances_train.json", json.dumps(coco.get("train", {}), ensure_ascii=False, indent=2))
            bundle.writestr("annotations/coco/instances_val.json", json.dumps(coco.get("val", {}), ensure_ascii=False, indent=2))
        if "yolo" in payload:
            yolo = payload["yolo"]
            bundle.writestr("data.yaml", _dump_yolo_yaml(yolo.get("data_yaml", {})))
            bundle.writestr("classes.txt", "\n".join(yolo.get("labels", [])))
            for record in yolo.get("records", []):
                bundle.writestr(record["label_file"], "\n".join(record.get("lines", [])))
        if "voc" in payload:
            for record in payload["voc"].get("records", []):
                bundle.writestr(record["annotation_file"], record.get("xml", ""))
        if "json" in payload:
            bundle.writestr("annotations.json", json.dumps(payload.get("json", []), ensure_ascii=False, indent=2))
        if "jsonl" in payload:
            bundle.writestr("annotations.jsonl", payload.get("jsonl", ""))
        if "csv" in payload:
            bundle.writestr("annotations/csv/annotations.csv", _csv_rows_to_text(payload["csv"]))
        for item in payload.get("manifest", []):
            frame_uri = item.get("frame_uri")
            if not frame_uri:
                continue
            try:
                path = absolute_media_path(frame_uri)
                with open(path, "rb") as source:
                    bundle.writestr(item.get("image_path") or f"images/train/{path.name}", source.read())
            except Exception:
                continue
    archive_name = f"project_{project.id}_{export_format}.zip"
    return archive_name, archive_stream.getvalue()


def build_coco_export(project: Project) -> dict:
    return build_dataset_export(project, export_format="coco")
