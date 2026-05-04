from __future__ import annotations

from datetime import datetime
import hashlib
import io
import json
import random
import zipfile
from typing import Dict, Iterable, List, Optional, Tuple

from bson import ObjectId
from mongoengine import Q

from apps.projects.models import Project, ProjectMembership
from apps.users.models import User
from ..models import (
    Assignment,
    BBoxValidationAssignment,
    FrameItem,
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
            asset.metadata["chunk_tasks"] = create_video_chunk_tasks_for_asset(asset)
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


def create_video_chunk_tasks_for_asset(asset: ImportAsset, chunk_size_frames: int = 300) -> dict:
    if asset.asset_type != ImportAsset.TYPE_VIDEO:
        return {"tasks_created": 0, "assignments_created": 0}
    project = asset.project
    frames = list(FrameItem.objects(project=project, asset=asset).order_by("frame_number"))
    if not frames:
        return {"tasks_created": 0, "assignments_created": 0}
    existing = list(VideoChunkTask.objects(project=project, asset=asset))
    for task in existing:
        assignments = list(VideoChunkAssignment.objects(task=task))
        if assignments:
            VideoChunkAnnotation.objects(assignment__in=assignments).delete()
            VideoChunkAssignment.objects(id__in=[item.id for item in assignments]).delete()
        task.delete()
    tasks_created = 0
    assignments_created = 0
    annotators = select_annotators_for_project(project, max(1, int(project.assignments_per_task or 1)))
    for chunk_index, start in enumerate(range(0, len(frames), chunk_size_frames)):
        end = min(start + chunk_size_frames - 1, len(frames) - 1)
        task = VideoChunkTask(
            project=project,
            asset=asset,
            chunk_index=chunk_index,
            start_frame=int(frames[start].frame_number),
            end_frame=int(frames[end].frame_number),
            required_annotations=1,
        )
        task.save()
        tasks_created += 1
        for annotator in annotators[:1]:
            VideoChunkAssignment(task=task, project=project, annotator=annotator).save()
            assignments_created += 1
    return {"tasks_created": tasks_created, "assignments_created": assignments_created}


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
    created_intervals = 0
    for entry in intervals:
        start_frame = int(entry["start_frame"])
        end_frame = int(entry["end_frame"])
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
            metadata={"chunk_task_id": str(assignment.task.id)},
            created_by=assignment.annotator,
        )
        interval.save()
        created_intervals += 1
    assignment.task.status = VideoChunkTask.STATUS_COMPLETED
    assignment.task.save()
    return {"annotation_id": str(annotation.id), "intervals_created": created_intervals}


def ensure_interval_validation_assignments(project: Project, min_validators: int = 3) -> int:
    created = 0
    intervals = list(VideoInterval.objects(project=project, status=VideoInterval.STATUS_DRAFT))
    for interval in intervals:
        if not interval.created_by:
            continue
        existing = list(IntervalValidationAssignment.objects(interval=interval))
        existing_validator_ids = {str(item.validator.id) for item in existing}
        candidates = [
            user
            for user in select_annotators_for_project(project, max(10, min_validators * 3))
            if str(user.id) != str(interval.created_by.id if interval.created_by else "")
            and str(user.id) not in existing_validator_ids
        ]
        for validator in candidates[: max(0, min_validators - len(existing))]:
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
            "start_frame": item.interval.start_frame,
            "end_frame": item.interval.end_frame,
            "start_sec": float(item.interval.start_sec or 0.0),
            "end_sec": float(item.interval.end_sec or 0.0),
            "frame_interval_sec": float(item.project.frame_interval_sec or 1.0),
            "status": item.status,
        }
        for item in assignments
    ]


def submit_interval_validation(assignment: IntervalValidationAssignment, decision: str, comment: str = "", min_validators: int = 3) -> dict:
    if not assignment.interval.created_by:
        assignment.status = IntervalValidationAssignment.STATUS_SUBMITTED
        assignment.comment = "Skipped auto interval without human author"
        assignment.save()
        return {"assignment_id": str(assignment.id), "interval_status": assignment.interval.status, "skipped": True}
    assignment.decision = decision
    assignment.comment = comment
    assignment.status = IntervalValidationAssignment.STATUS_SUBMITTED
    assignment.save()
    interval = assignment.interval
    votes = list(IntervalValidationAssignment.objects(interval=interval, status=IntervalValidationAssignment.STATUS_SUBMITTED))
    if len(votes) >= min_validators:
        approvals = sum(1 for vote in votes if vote.decision == VideoInterval.STATUS_APPROVED)
        rejects = len(votes) - approvals
        interval.status = VideoInterval.STATUS_APPROVED if approvals >= rejects else VideoInterval.STATUS_REJECTED
        interval.validated_at = datetime.utcnow()
        interval.metadata = {
            **(interval.metadata or {}),
            "validation_votes": len(votes),
            "validation_approved": approvals,
            "validation_rejected": rejects,
        }
        interval.save()
        if interval.status == VideoInterval.STATUS_APPROVED:
            _create_work_items_from_approved_interval(interval)
    return {"assignment_id": str(assignment.id), "interval_status": interval.status}


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
    candidate_annotators = select_annotators_for_project(project, max(required_assignments, 50))
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


def select_annotators_for_project(project: Project, limit: int) -> List[User]:
    membership_qs = ProjectMembership.objects(project=project, role=ProjectMembership.ROLE_ANNOTATOR, is_active=True)
    memberships = list(membership_qs)
    allowed_ids = {str(user.id) for user in (project.allowed_annotators or [])}
    rules = project.participant_rules or {}
    assignment_scope = str(rules.get("assignment_scope") or "selected_only").strip().lower()
    required_specialization = str(rules.get("specialization") or "").strip().lower()
    required_group = str(rules.get("group") or "").strip().lower()

    if allowed_ids and assignment_scope != "all":
        memberships = [membership for membership in memberships if str(membership.user.id) in allowed_ids]

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


def _build_asset_batches(asset: ImportAsset, frames: List[FrameItem], project: Project) -> List[dict]:
    settings = _workflow_settings(project)
    task_batch_size = settings["task_batch_size"]
    min_sequence_size = settings["min_sequence_size"]
    batches: List[dict] = []
    total_batches = (len(frames) + task_batch_size - 1) // task_batch_size if frames else 0
    for batch_number, start in enumerate(range(0, len(frames), task_batch_size), start=1):
        batch_frames = frames[start : start + task_batch_size]
        batch_id = f"{asset.id}:batch:{batch_number}"
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
                        "asset_id": str(asset.id),
                    },
                }
            )
    return batches


def create_work_items_for_import(import_session: ImportSession) -> Dict[str, int]:
    project = import_session.project
    processed_assets = list(ImportAsset.objects(import_session=import_session, processing_status=ImportAsset.STATUS_PROCESSED))
    frame_ids = []
    created_work_items = 0
    created_assignments = 0
    workflow_batches_total = 0
    validation_ready_items = 0
    queue_position = _next_queue_position(project)
    for asset in processed_assets:
        if asset.asset_type == ImportAsset.TYPE_VIDEO:
            approved_intervals = list(
                VideoInterval.objects(project=project, asset=asset, status=VideoInterval.STATUS_APPROVED).order_by("start_frame")
            )
            approved_ranges = [(int(interval.start_frame), int(interval.end_frame)) for interval in approved_intervals]
            asset_frames = [
                frame
                for frame in FrameItem.objects(project=project, asset=asset).order_by("frame_number", "created_at")
                if any(start <= int(frame.frame_number) <= end for start, end in approved_ranges)
            ]
        else:
            asset_frames = list(FrameItem.objects(project=project, asset=asset).order_by("frame_number", "created_at"))
        batch_entries = _build_asset_batches(asset, asset_frames, project)
        if batch_entries:
            workflow_batches_total += max(int(item["workflow_meta"]["task_batch_number"]) for item in batch_entries)
        for entry in batch_entries:
            frame = entry["frame"]
            workflow_meta = entry["workflow_meta"]
            work_item = WorkItem.objects(project=project, frame=frame).first()
            if not work_item:
                work_item = WorkItem(project=project, frame=frame)
                work_item.workflow_meta = workflow_meta
                work_item.validation_status = WorkItem.VALIDATION_PENDING
                ai_enabled = bool((project.participant_rules or {}).get("ai_prelabel_enabled", True))
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
            selected_annotators = select_annotators_for_project(project, project.assignments_per_task)
            existing_annotators = {str(assignment.annotator.id) for assignment in Assignment.objects(work_item=work_item)}
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
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0, "matches": []}

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
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "matches": matches,
        "count_a": len(boxes_a),
        "count_b": len(boxes_b),
    }


def _assignment_quality_signals(assignment: Assignment) -> dict:
    elapsed_sec = None
    if assignment.started_at and assignment.submitted_at:
        elapsed_sec = max(0.0, (assignment.submitted_at - assignment.started_at).total_seconds())
    return {
        "elapsed_sec": round(elapsed_sec, 3) if elapsed_sec is not None else None,
        "too_fast": bool(elapsed_sec is not None and elapsed_sec < 2.0),
    }


def update_user_quality(user: User, agreement: float, disputed: bool = False) -> None:
    completed = int(user.completed_assignments or 0) + 1
    current_rating = float(user.rating or 0.0)
    user.rating = round(((current_rating * (completed - 1)) + agreement) / completed, 4)
    if disputed:
        previous_conflicts = float(user.conflict_rate or 0.0) * (completed - 1)
        user.conflict_rate = round((previous_conflicts + 1.0) / completed, 4)
    else:
        previous_conflicts = float(user.conflict_rate or 0.0) * (completed - 1)
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
            pair_scores.append(comparison["f1"])
            pair_metrics.append({"a": str(annotation_a.id), "b": str(annotation_b.id), "metrics": comparison})
    consensus_f1 = round(sum(pair_scores) / len(pair_scores), 4) if pair_scores else 0.0
    work_item.agreement_score = consensus_f1
    if consensus_f1 >= work_item.project.agreement_threshold:
        work_item.status = WorkItem.STATUS_COMPLETED
        work_item.review_required = False
        work_item.review_status = "auto_accepted"
        work_item.validation_status = WorkItem.VALIDATION_PENDING
        work_item.validation_comment = ""
        work_item.validated_by = None
        work_item.validated_at = None
        work_item.final_annotation = annotations[0].label_data
        work_item.final_source = "annotator_consensus"
        work_item.save()

        for annotation in annotations:
            annotation.status = WorkAnnotation.STATUS_ACCEPTED
            annotation.save()
            annotation.assignment.status = Assignment.STATUS_ACCEPTED
            annotation.assignment.save()
            update_user_quality(annotation.annotator, consensus_f1, disputed=False)
        _run_video_qc_for_work_item(work_item)
        return {"state": "accepted", "metrics": {"f1": consensus_f1, "pairs": pair_metrics}}
    requeued_assignments = requeue_low_agreement_work_item(work_item, annotations, consensus_f1, pair_metrics=pair_metrics)
    return {
        "state": "requeued",
        "metrics": {"f1": consensus_f1, "pairs": pair_metrics},
        "requeued_assignments": requeued_assignments,
    }


def requeue_low_agreement_work_item(work_item: WorkItem, annotations: List[WorkAnnotation], consensus_f1: float, pair_metrics: List[dict] | None = None) -> int:
    return requeue_work_item_for_validation(work_item, actor=None, reason="low_agreement")


def requeue_work_item_for_validation(work_item: WorkItem, actor: User | None = None, reason: str = "validation_needs_changes") -> int:
    project = work_item.project
    queue_position = _next_queue_position(project)
    existing_assignments = list(Assignment.objects(work_item=work_item).order_by("order_index", "created_at"))
    for assignment in existing_assignments:
        annotation = WorkAnnotation.objects(assignment=assignment).first()
        if annotation:
            annotation.status = WorkAnnotation.STATUS_REJECTED
            annotation.is_final = False
            annotation.save()
        assignment.status = Assignment.STATUS_DISPUTED
        assignment.started_at = None
        assignment.submitted_at = None
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
    work_item.save()

    created = 0
    required_assignments = max(1, int(project.assignments_per_task or 1))
    existing_annotator_ids = {str(item.annotator.id) for item in existing_assignments}
    fresh_candidates = [
        user
        for user in select_annotators_for_project(project, max(required_assignments * 3, len(existing_assignments) + required_assignments))
        if str(user.id) not in existing_annotator_ids
    ]
    next_order = Assignment.objects(work_item=work_item).count()
    for annotator in fresh_candidates[:required_assignments]:
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
    if created < required_assignments:
        reusable_assignments = sorted(existing_assignments, key=lambda item: (item.order_index, item.created_at))
        for assignment in reusable_assignments[: required_assignments - created]:
            assignment.status = Assignment.STATUS_ASSIGNED
            assignment.started_at = None
            assignment.submitted_at = None
            assignment.queue_position = queue_position
            assignment.quality_signals = {
                **(assignment.quality_signals or {}),
                "requeue_reason": reason,
                "requeue_count": int((assignment.quality_signals or {}).get("requeue_count") or 0) + 1,
            }
            assignment.save()
            queue_position += 1
            created += 1
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


def _ensure_golden_frames(project: Project, target_count: int = 10) -> List[GoldenFrame]:
    active = list(GoldenFrame.objects(project=project, is_active=True).order_by("created_at"))
    if len(active) >= target_count:
        return active

    existing_frame_ids = {str(item.frame.id) for item in active}
    candidates = list(
        WorkItem.objects(
            project=project,
            status=WorkItem.STATUS_COMPLETED,
        ).order_by("created_at")
    )
    for work_item in candidates:
        if len(active) >= target_count:
            break
        if str(work_item.frame.id) in existing_frame_ids:
            continue
        reference = work_item.final_annotation or {}
        GoldenFrame(project=project, frame=work_item.frame, reference_annotation=reference).save()
        active.append(GoldenFrame.objects(project=project, frame=work_item.frame, is_active=True).first())
        existing_frame_ids.add(str(work_item.frame.id))
    return [item for item in active if item]


def _bbox_validation_real_payload(work_item: WorkItem) -> dict:
    return _work_item_payload(work_item)


def _bbox_validation_golden_payload(golden: GoldenFrame) -> dict:
    frame = golden.frame
    return {
        "golden_id": str(golden.id),
        "frame_id": str(frame.id),
        "frame_url": frame.frame_uri,
        "frame_number": frame.frame_number,
        "timestamp_sec": frame.timestamp_sec,
        "width": frame.width,
        "height": frame.height,
        "candidate_annotation": {"boxes": _normalize_boxes(golden.reference_annotation)},
    }


def ensure_bbox_validation_assignments(project: Project, min_validators: int = 3, real_items_per_batch: int = 20, golden_items_per_batch: int = 10) -> int:
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
    golden_frames = _ensure_golden_frames(project, golden_items_per_batch)
    for start in range(0, len(completed_items), real_items_per_batch):
        items = completed_items[start : start + real_items_per_batch]
        candidates = [
            user
            for user in select_annotators_for_project(project, max(15, min_validators * 3))
        ]
        for validator in candidates:
            eligible_items = []
            for item in items:
                authored = WorkAnnotation.objects(
                    work_item=item,
                    annotator=validator,
                    status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED],
                ).first()
                if not authored:
                    eligible_items.append(item)
            real_ids = [str(item.id) for item in eligible_items[:real_items_per_batch]]
            if not real_ids:
                continue
            existing = BBoxValidationAssignment.objects(project=project, validator=validator, work_item_ids=real_ids).first()
            if existing:
                continue
            golden_ids = [str(frame.id) for frame in golden_frames[:golden_items_per_batch]]
            BBoxValidationAssignment(
                project=project,
                validator=validator,
                work_item_ids=real_ids,
                golden_frame_ids=golden_ids,
                status=BBoxValidationAssignment.STATUS_ASSIGNED,
            ).save()
            created += 1
    return created


def _required_bbox_validation_votes(work_item: WorkItem, min_validators: int = 3) -> int:
    authors = {
        str(annotation.annotator.id)
        for annotation in WorkAnnotation.objects(work_item=work_item, status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED])
        if annotation.annotator
    }
    candidates = select_annotators_for_project(work_item.project, 50)
    eligible = [user for user in candidates if str(user.id) not in authors]
    return max(1, min(min_validators, len(eligible)))


def bbox_validation_queue_for_annotator(user: User) -> List[dict]:
    assignments = list(BBoxValidationAssignment.objects(validator=user, status=BBoxValidationAssignment.STATUS_ASSIGNED).order_by("created_at"))
    payload = []
    for item in assignments:
        real_items = [
            work_item
            for work_item in WorkItem.objects(project=item.project, id__in=[ObjectId(work_item_id) for work_item_id in item.work_item_ids if ObjectId.is_valid(work_item_id)])
        ]
        real_lookup = {str(work_item.id): work_item for work_item in real_items}
        ordered_real = [real_lookup[work_item_id] for work_item_id in item.work_item_ids if work_item_id in real_lookup]
        golden_items = [
            golden
            for golden in GoldenFrame.objects(project=item.project, id__in=[ObjectId(golden_id) for golden_id in item.golden_frame_ids if ObjectId.is_valid(golden_id)], is_active=True)
        ]
        golden_lookup = {str(golden.id): golden for golden in golden_items}
        ordered_golden = [golden_lookup[golden_id] for golden_id in item.golden_frame_ids if golden_id in golden_lookup]
        payload.append(
            {
                "assignment_id": str(item.id),
                "project_id": str(item.project.id),
                "project_title": item.project.title,
                "real_items": item.work_item_ids,
                "golden_items": item.golden_frame_ids,
                "real_item_details": [_bbox_validation_real_payload(work_item) for work_item in ordered_real],
                "golden_item_details": [_bbox_validation_golden_payload(golden) for golden in ordered_golden],
                "real_count": len(item.work_item_ids),
                "golden_count": len(item.golden_frame_ids),
            }
        )
    return payload


def submit_bbox_validation_assignment(
    assignment: BBoxValidationAssignment,
    decisions: Dict[str, str],
    golden_decisions: Dict[str, str],
    min_score: float = 0.8,
) -> dict:
    golden_frames = list(
        GoldenFrame.objects(
            project=assignment.project,
            id__in=[ObjectId(golden_id) for golden_id in assignment.golden_frame_ids if ObjectId.is_valid(golden_id)],
            is_active=True,
        )
    )
    golden_total = max(len(golden_frames), 1)
    golden_correct = 0
    for golden in golden_frames:
        decision = str(golden_decisions.get(str(golden.id), "")).strip().lower()
        reference_boxes = _normalize_boxes(golden.reference_annotation)
        expected_decision = "approve" if reference_boxes or golden.reference_annotation == {"boxes": []} else "needs_changes"
        if decision == expected_decision:
            golden_correct += 1
    score = round(golden_correct / golden_total, 4)
    assignment.decisions = decisions
    assignment.golden_decisions = golden_decisions
    assignment.golden_score = score
    assignment.status = BBoxValidationAssignment.STATUS_SUBMITTED
    assignment.save()
    if score < min_score:
        return {"assignment_id": str(assignment.id), "status": "rejected_by_golden", "golden_score": score}
    approved_count = 0
    requeued_count = 0
    pending_count = 0
    for work_item_id in assignment.work_item_ids:
        if not ObjectId.is_valid(work_item_id):
            continue
        work_item = WorkItem.objects(id=ObjectId(work_item_id), project=assignment.project).first()
        if not work_item:
            continue
        decision = str(decisions.get(work_item_id, "approve")).strip().lower()
        validators_meta = (work_item.workflow_meta or {}).get("bbox_validation_votes") or []
        validators_meta.append({"validator_id": str(assignment.validator.id), "decision": decision})
        meta = work_item.workflow_meta or {}
        meta["bbox_validation_votes"] = validators_meta
        work_item.workflow_meta = meta

        submitted_votes = [
            vote
            for vote in validators_meta
            if str(vote.get("decision") or "").strip().lower() in {"approve", "needs_changes"}
        ]
        required_votes = _required_bbox_validation_votes(work_item, min_validators=3)
        if len(submitted_votes) < required_votes:
            work_item.save()
            pending_count += 1
            continue

        needs_changes_votes = sum(1 for vote in submitted_votes if vote.get("decision") == "needs_changes")
        approve_votes = len(submitted_votes) - needs_changes_votes
        if needs_changes_votes > approve_votes:
            requeue_work_item_for_validation(work_item, actor=assignment.validator, reason="bbox_validation_needs_changes")
            requeued_count += 1
        else:
            work_item.validation_status = WorkItem.VALIDATION_APPROVED
            work_item.validated_by = assignment.validator
            work_item.validated_at = datetime.utcnow()
            work_item.save()
            approved_count += 1
    return {
        "assignment_id": str(assignment.id),
        "status": "submitted",
        "golden_score": score,
        "approved_items": approved_count,
        "requeued_items": requeued_count,
        "pending_items": pending_count,
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
        ensure_bbox_validation_assignments(
            project=assignment.project,
            min_validators=3,
            real_items_per_batch=20,
            golden_items_per_batch=10,
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
    golden_frames = list(GoldenFrame.objects(id__in=golden_ids, is_active=True))
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


def project_overview(project: Project) -> dict:
    imports = list(ImportSession.objects(project=project))
    assets = list(ImportAsset.objects(project=project))
    work_items = list(WorkItem.objects(project=project))
    assignments = list(Assignment.objects(project=project))
    reviews = list(ReviewRecord.objects(project=project))
    intervals = list(VideoInterval.objects(project=project))
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
    return {
        "project_id": str(project.id),
        "project": {
            "title": project.title,
            "status": project.status,
            "project_type": project.project_type,
            "annotation_type": project.annotation_type,
        },
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
            "average_agreement": round(sum(item.agreement_score for item in work_items) / len(work_items), 4) if work_items else 0.0,
            "workflow_batches_total": len({item.workflow_meta.get("task_batch_id") for item in work_items if item.workflow_meta.get("task_batch_id")}),
            "validation_ready_items": sum(1 for item in work_items if item.workflow_meta.get("validation_ready")),
        },
        "intervals": {
            "total": len(intervals),
            "draft": sum(1 for item in intervals if item.status == VideoInterval.STATUS_DRAFT),
            "approved": sum(1 for item in intervals if item.status == VideoInterval.STATUS_APPROVED),
            "rejected": sum(1 for item in intervals if item.status == VideoInterval.STATUS_REJECTED),
        },
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


def _quality_report(project: Project, work_items: List[WorkItem], assignments: List[Assignment], reviews: List[ReviewRecord]) -> dict:
    completed = [item for item in work_items if item.status == WorkItem.STATUS_COMPLETED]
    pending_review = [item for item in work_items if item.status == WorkItem.STATUS_IN_REVIEW]
    rejected = [item for item in work_items if item.review_required and item.status != WorkItem.STATUS_COMPLETED]
    agreement_values = [item.agreement_score for item in completed if item.agreement_score is not None]
    total = len(work_items)
    return {
        "project_id": str(project.id),
        "work_items_total": total,
        "work_items_completed": len(completed),
        "work_items_in_review": len(pending_review),
        "work_items_rejected_or_flagged": len(rejected),
        "validation": {
            "pending": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_PENDING),
            "approved": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_APPROVED),
            "needs_changes": sum(1 for item in work_items if item.validation_status == WorkItem.VALIDATION_NEEDS_CHANGES),
        },
        "completion_rate": round((len(completed) / total), 4) if total else 0.0,
        "average_agreement": round(sum(agreement_values) / len(agreement_values), 4) if agreement_values else 0.0,
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
    }


def _build_coco_export(project: Project, completed_items: List[WorkItem]) -> dict:
    categories = []
    category_lookup = {}
    for index, label in enumerate(project.label_schema or [], start=1):
        name = label.get("name") or label.get("label") or f"label_{index}"
        category_lookup[name] = index
        categories.append({"id": index, "name": name})

    images = []
    annotations = []
    manifest_items = []
    annotation_id = 1
    for work_item in completed_items:
        frame = work_item.frame
        image_id = str(frame.id)
        images.append(
            {
                "id": image_id,
                "file_name": frame.frame_uri,
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
            annotations.append(
                {
                    "id": annotation_id,
                    "image_id": image_id,
                    "category_id": category_id,
                    "bbox": [box["x"], box["y"], box["width"], box["height"]],
                    "area": box["width"] * box["height"],
                    "iscrowd": 0,
                }
            )
            annotation_id += 1
        manifest_items.append(
            {
                "work_item_id": str(work_item.id),
                "frame_uri": frame.frame_uri,
                "source_asset_id": str(frame.asset.id),
                "agreement_score": work_item.agreement_score,
                "review_status": work_item.review_status,
                "final_source": work_item.final_source,
                "validation_status": work_item.validation_status,
            }
        )
    return {"manifest": manifest_items, "coco": {"images": images, "annotations": annotations, "categories": categories}}


def _build_yolo_export(project: Project, completed_items: List[WorkItem]) -> dict:
    category_lookup: Dict[str, int] = {}
    for index, label in enumerate(project.label_schema or []):
        name = str(label.get("name") or label.get("label") or f"label_{index}").strip()
        if name and name not in category_lookup:
            category_lookup[name] = len(category_lookup)
    labels_txt = [name for name, _idx in sorted(category_lookup.items(), key=lambda item: item[1])]
    records: List[dict] = []
    for work_item in completed_items:
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
                "label_file": f"labels/{str(frame.id)}.txt",
                "lines": yolo_lines,
            }
        )
    return {
        "labels": labels_txt,
        "data_yaml": {
            "path": f"project_{project.id}",
            "train": "images/train",
            "val": "images/val",
            "names": labels_txt,
        },
        "records": records,
    }


def _build_voc_export(completed_items: List[WorkItem]) -> dict:
    records: List[dict] = []
    for work_item in completed_items:
        frame = work_item.frame
        objects = []
        for box in _normalize_boxes(work_item.final_annotation):
            objects.append(
                {
                    "name": box["label"],
                    "bndbox": {
                        "xmin": int(round(box["x"])),
                        "ymin": int(round(box["y"])),
                        "xmax": int(round(box["x"] + box["width"])),
                        "ymax": int(round(box["y"] + box["height"])),
                    },
                }
            )
        records.append(
            {
                "filename": frame.frame_uri,
                "size": {"width": frame.width, "height": frame.height, "depth": 3},
                "objects": objects,
            }
        )
    return {"records": records}


def _build_csv_export(completed_items: List[WorkItem]) -> List[dict]:
    rows: List[dict] = []
    for work_item in completed_items:
        frame = work_item.frame
        boxes = _normalize_boxes(work_item.final_annotation)
        if not boxes:
            rows.append(
                {
                    "work_item_id": str(work_item.id),
                    "frame_id": str(frame.id),
                    "frame_uri": frame.frame_uri,
                    "frame_number": frame.frame_number,
                    "timestamp_sec": frame.timestamp_sec,
                    "label": "",
                    "x": "",
                    "y": "",
                    "width": "",
                    "height": "",
                    "validation_status": work_item.validation_status,
                }
            )
            continue
        for box in boxes:
            rows.append(
                {
                    "work_item_id": str(work_item.id),
                    "frame_id": str(frame.id),
                    "frame_uri": frame.frame_uri,
                    "frame_number": frame.frame_number,
                    "timestamp_sec": frame.timestamp_sec,
                    "label": box["label"],
                    "x": box["x"],
                    "y": box["y"],
                    "width": box["width"],
                    "height": box["height"],
                    "validation_status": work_item.validation_status,
                }
            )
    return rows


def build_dataset_export(project: Project, export_format: str = "both") -> dict:
    completed_items = list(WorkItem.objects(project=project, status=WorkItem.STATUS_COMPLETED))
    assignments = list(Assignment.objects(project=project))
    reviews = list(ReviewRecord.objects(project=project))
    payload = {
        "project": {
            "id": str(project.id),
            "title": project.title,
            "annotation_type": project.annotation_type,
            "export_format": export_format,
        },
        "quality_report": _quality_report(project, completed_items, assignments, reviews),
    }
    if export_format in {"coco", "both"}:
        payload.update(_build_coco_export(project, completed_items))
    if export_format in {"yolo", "both"}:
        payload["yolo"] = _build_yolo_export(project, completed_items)
    if export_format in {"voc", "both"}:
        payload["voc"] = _build_voc_export(completed_items)
    if export_format in {"csv", "both"}:
        payload["csv"] = _build_csv_export(completed_items)
    return payload


def build_dataset_export_archive(project: Project, export_format: str = "both") -> tuple[str, bytes]:
    payload = build_dataset_export(project, export_format=export_format)
    archive_stream = io.BytesIO()
    with zipfile.ZipFile(archive_stream, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        quality_report = payload.get("quality_report", {})
        bundle.writestr("quality_report.json", json.dumps(quality_report, ensure_ascii=False, indent=2))
        if "coco" in payload:
            bundle.writestr("annotations/coco.json", json.dumps(payload["coco"], ensure_ascii=False, indent=2))
        if "yolo" in payload:
            yolo = payload["yolo"]
            bundle.writestr("annotations/yolo/data.yaml", json.dumps(yolo.get("data_yaml", {}), ensure_ascii=False, indent=2))
            for record in yolo.get("records", []):
                bundle.writestr(f"annotations/yolo/{record['label_file']}", "\n".join(record.get("lines", [])))
        if "voc" in payload:
            bundle.writestr("annotations/voc/voc.json", json.dumps(payload["voc"], ensure_ascii=False, indent=2))
        if "csv" in payload:
            csv_rows = payload["csv"]
            if csv_rows:
                headers = list(csv_rows[0].keys())
                lines = [",".join(headers)]
                for row in csv_rows:
                    values = [str(row.get(column, "")) for column in headers]
                    lines.append(",".join(values))
                bundle.writestr("annotations/csv/annotations.csv", "\n".join(lines))
        for item in payload.get("manifest", []):
            frame_uri = item.get("frame_uri")
            if not frame_uri:
                continue
            try:
                path = absolute_media_path(frame_uri)
                with open(path, "rb") as source:
                    target_name = f"images/train/{path.name}"
                    bundle.writestr(target_name, source.read())
            except Exception:
                continue
    archive_name = f"project_{project.id}_{export_format}.zip"
    return archive_name, archive_stream.getvalue()


def build_coco_export(project: Project) -> dict:
    return build_dataset_export(project, export_format="coco")
