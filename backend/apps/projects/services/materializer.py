from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from apps.projects.models import Project
from apps.projects.task_registry import (
    TASK_BBOX_ANNOTATION,
    TASK_BBOX_VALIDATION,
    TASK_CLASSIFICATION,
    TASK_COMPARISON,
    TASK_IMAGE_ANNOTATION,
    TASK_TEXT_ANNOTATION,
    TASK_VIDEO_ANNOTATION,
    TASK_VIDEO_INTERVAL_VALIDATION,
    task_requires_source_project,
)


@dataclass(frozen=True)
class MaterializationResult:
    task_type: str
    action: str
    created: int = 0
    skipped: int = 0
    errors: tuple[str, ...] = ()
    summary: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_type": self.task_type,
            "action": self.action,
            "created": int(self.created or 0),
            "skipped": int(self.skipped or 0),
            "errors": list(self.errors or ()),
            "summary": self.summary or {},
        }


class ProjectTaskMaterializer:
    """Single routing point for turning project inputs into executable tasks.

    The older code split this between cv_annotation workflow helpers and
    generic task helpers. Keeping those implementations intact while routing
    through this class makes task_type/widget_type the product contract.
    """

    def __init__(self, project: Project):
        self.project = project
        self.task_type = str(getattr(project, "task_type", "") or TASK_BBOX_ANNOTATION)

    def materialize_import(self, import_session) -> MaterializationResult:
        if import_session.status == getattr(import_session, "STATUS_FINALIZED", "finalized"):
            summary = import_session.summary or {}
            return MaterializationResult(
                task_type=self.task_type,
                action="already_finalized",
                created=0,
                skipped=int(summary.get("total") or summary.get("work_items_created") or 0),
                summary=summary,
            )

        if self.task_type == TASK_IMAGE_ANNOTATION:
            from apps.cv_annotation.models import ImportSession
            from apps.projects.services.generic_tasks import create_image_tasks_from_import

            summary = create_image_tasks_from_import(import_session)
            import_session.summary = summary
            import_session.status = ImportSession.STATUS_FINALIZED
            import_session.save()
            return MaterializationResult(
                task_type=self.task_type,
                action="image_import_to_generic_tasks",
                created=int(summary.get("created") or 0),
                skipped=int(summary.get("skipped") or 0),
                errors=tuple(summary.get("errors") or ()),
                summary=summary,
            )

        if self.task_type == TASK_VIDEO_ANNOTATION:
            from apps.cv_annotation.models import ImportAsset, ImportSession
            from apps.cv_annotation.services.workflow import build_import_preview

            processed_assets = list(
                ImportAsset.objects(
                    import_session=import_session,
                    processing_status=ImportAsset.STATUS_PROCESSED,
                    asset_type=ImportAsset.TYPE_VIDEO,
                )
            )
            chunk_summaries = [
                (asset.metadata or {}).get("chunk_tasks") or {}
                for asset in processed_assets
            ]
            summary = {
                "video_assets_processed": len(processed_assets),
                "chunk_tasks_created": sum(int(item.get("tasks_created") or 0) for item in chunk_summaries),
                "assignments_created": sum(int(item.get("assignments_created") or 0) for item in chunk_summaries),
                "chunk_tasks": chunk_summaries,
            }
            import_session.preview = build_import_preview(import_session)
            import_session.summary = summary
            import_session.status = ImportSession.STATUS_FINALIZED if processed_assets else ImportSession.STATUS_FAILED
            import_session.save()
            return MaterializationResult(
                task_type=self.task_type,
                action="video_import_to_interval_chunks",
                created=int(summary["chunk_tasks_created"]),
                skipped=0,
                errors=tuple(import_session.errors or ()),
                summary=summary,
            )

        if self.task_type == TASK_BBOX_ANNOTATION:
            from apps.cv_annotation.services.workflow import create_work_items_for_import

            summary = create_work_items_for_import(import_session)
            return MaterializationResult(
                task_type=self.task_type,
                action="media_import_to_bbox_work_items",
                created=int(summary.get("work_items_created") or 0),
                skipped=int(summary.get("work_items_skipped") or summary.get("skipped") or 0),
                errors=tuple(summary.get("errors") or ()),
                summary=summary,
            )

        if self.task_type == TASK_BBOX_VALIDATION:
            from apps.cv_annotation.services.workflow import create_bbox_validation_items_for_import

            summary = create_bbox_validation_items_for_import(import_session)
            return MaterializationResult(
                task_type=self.task_type,
                action="validation_upload_to_bbox_validation_items",
                created=int(summary.get("work_items_created") or 0),
                skipped=int(summary.get("work_items_skipped") or 0),
                errors=tuple(summary.get("errors") or ()),
                summary=summary,
            )

        if self.task_type == TASK_VIDEO_INTERVAL_VALIDATION:
            from apps.cv_annotation.services.workflow import create_interval_validation_items_for_import

            summary = create_interval_validation_items_for_import(import_session)
            return MaterializationResult(
                task_type=self.task_type,
                action="validation_upload_to_interval_validation_items",
                created=int(summary.get("intervals_created") or 0),
                skipped=int(summary.get("intervals_skipped") or 0),
                errors=tuple(summary.get("errors") or ()),
                summary=summary,
            )

        summary = {
            "work_items_created": 0,
            "assignments_created": 0,
            "skipped_for_task_type": self.task_type,
            "message": "This project type does not materialize tasks from media imports.",
        }
        import_session.summary = summary
        from apps.cv_annotation.models import ImportSession

        import_session.status = ImportSession.STATUS_FINALIZED
        import_session.save()
        return MaterializationResult(task_type=self.task_type, action="noop_import", summary=summary)

    def materialize_generic_items(self, items) -> MaterializationResult:
        if self.task_type not in {TASK_TEXT_ANNOTATION, TASK_IMAGE_ANNOTATION, TASK_CLASSIFICATION, TASK_COMPARISON}:
            return MaterializationResult(
                task_type=self.task_type,
                action="generic_items_unsupported",
                errors=("task_type_does_not_accept_generic_items",),
                summary={"message": "This task type does not accept manual or CSV generic items."},
            )

        from apps.projects.services.generic_tasks import create_generic_tasks_from_items

        summary = create_generic_tasks_from_items(self.project, items)
        return MaterializationResult(
            task_type=self.task_type,
            action="manual_or_csv_to_generic_tasks",
            created=int(summary.get("created") or 0),
            skipped=int(summary.get("skipped") or 0),
            errors=tuple(summary.get("errors") or ()),
            summary=summary,
        )

    def materialize_source(self) -> MaterializationResult:
        if not task_requires_source_project(self.task_type):
            return MaterializationResult(task_type=self.task_type, action="source_not_required")

        if self.task_type == TASK_VIDEO_INTERVAL_VALIDATION:
            from apps.cv_annotation.services.workflow import materialize_interval_validation_source, source_sync_summary

            created = materialize_interval_validation_source(self.project)
            summary = source_sync_summary(self.project)
            return MaterializationResult(
                task_type=self.task_type,
                action="source_intervals_to_validation",
                created=created,
                skipped=int(summary.get("skipped") or 0),
                errors=tuple(summary.get("errors") or ()),
                summary=summary,
            )

        if self.task_type == TASK_BBOX_VALIDATION:
            from apps.cv_annotation.services.workflow import materialize_bbox_validation_source, source_sync_summary

            created = materialize_bbox_validation_source(self.project)
            summary = source_sync_summary(self.project)
            return MaterializationResult(
                task_type=self.task_type,
                action="source_boxes_to_validation",
                created=created,
                skipped=int(summary.get("skipped") or 0),
                errors=tuple(summary.get("errors") or ()),
                summary=summary,
            )

        if self.task_type == TASK_BBOX_ANNOTATION:
            from apps.cv_annotation.services.workflow import materialize_bbox_annotation_interval_source, source_sync_summary

            created = materialize_bbox_annotation_interval_source(self.project)
            summary = source_sync_summary(self.project)
            return MaterializationResult(
                task_type=self.task_type,
                action="source_intervals_to_bbox_frames",
                created=created,
                skipped=int(summary.get("skipped") or 0),
                errors=tuple(summary.get("errors") or ()),
                summary=summary,
            )

        return MaterializationResult(task_type=self.task_type, action="source_unsupported")

    def sync(self) -> dict[str, Any]:
        if self.task_type in {TASK_TEXT_ANNOTATION, TASK_IMAGE_ANNOTATION, TASK_CLASSIFICATION, TASK_COMPARISON}:
            from apps.cv_annotation.services.workflow import project_overview

            overview = project_overview(self.project)
            overview["sync"] = {
                "action": "generic_project_synced",
                "generic_tasks_total": int((overview.get("generic_tasks") or {}).get("total") or 0),
                "created": 0,
                "skipped": 0,
                "errors": [],
            }
            return overview

        from apps.cv_annotation.services.workflow import sync_project_workflow

        return sync_project_workflow(self.project)
