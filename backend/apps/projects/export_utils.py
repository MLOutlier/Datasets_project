import logging

from bson import ObjectId
from django.http import HttpResponse
from django.http.response import FileResponse
from rest_framework import status
from rest_framework.response import Response

from .export_standards import collect_project_export_bundle, export_tfrecord
from .models import Project
from .services.generic_tasks import (
    build_generic_project_export,
    build_generic_project_export_archive,
    is_generic_task_project,
)

logger = logging.getLogger(__name__)

GENERIC_EXPORT_FORMATS = {"json", "jsonl", "csv", "both"}
CV_EXPORT_FORMATS = {"coco", "yolo", "voc", "tfrecord", "csv", "json", "jsonl", "both"}
CV_ARTIFACT_EXPORT_FORMATS = {"json", "jsonl", "csv", "both"}
CV_EXPORT_ARTIFACTS = {"raw_annotations", "consensus_annotations", "validated_dataset", "validation_report"}


def _request_param(request, name: str, default: str = "") -> str:
    params = getattr(request, "query_params", None) or getattr(request, "GET", None)
    if params is None:
        return default
    return str(params.get(name, default) or default)


def _as_archive(request) -> bool:
    return _request_param(request, "download").strip().lower() in {"1", "true", "yes"}


def _project_for_export(project_id: str, user):
    if not ObjectId.is_valid(project_id):
        return None, Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)
    project = Project.objects(id=ObjectId(project_id)).first()
    if not project:
        return None, Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    if getattr(user, "role", "") != "admin" and str(project.owner.id) != str(user.id):
        return None, Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    return project, None


def _log_export(project, user, export_format: str, entrypoint: str, archive: bool, **extra) -> None:
    try:
        from apps.cv_annotation.models import SecurityEvent
        from apps.cv_annotation.services.security import log_security_event

        log_security_event(
            project=project,
            actor=user,
            event_type=SecurityEvent.EVENT_EXPORT_GENERATED,
            payload={"format": export_format, "archive": archive, "entrypoint": entrypoint, **extra},
        )
    except Exception as exc:
        logger.warning("Failed to log export event for project %s: %s", project.id, exc)


def _zip_response(filename: str, payload: bytes) -> HttpResponse:
    response = HttpResponse(payload, content_type="application/zip")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


def export_project_dataset(project_id, user, request, entrypoint: str = "projects"):
    """
    Export annotated dataset of a project.
    Returns an archive/file response for downloads and a JSON payload otherwise.
    """
    try:
        logger.info("Export dataset called for project %s", project_id)
        project, error_response = _project_for_export(project_id, user)
        if error_response is not None:
            return error_response

        export_format = (_request_param(request, "format") or "both").strip().lower()
        artifact = (_request_param(request, "artifact") or "validated_dataset").strip().lower()
        logger.info("Export format: %s, artifact: %s", export_format, artifact)

        if artifact not in CV_EXPORT_ARTIFACTS:
            return Response(
                {"detail": "Invalid export artifact. Use raw_annotations, consensus_annotations, validated_dataset or validation_report"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if is_generic_task_project(project):
            if artifact != "validated_dataset":
                return Response(
                    {"detail": "Generic projects currently support only the default validated_dataset export artifact"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if export_format not in GENERIC_EXPORT_FORMATS:
                return Response(
                    {"detail": "Invalid generic export format. Use json, jsonl, csv or both"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if _as_archive(request):
                archive_name, archive_bytes = build_generic_project_export_archive(project, export_format=export_format)
                _log_export(project, user, export_format, entrypoint, archive=True, filename=archive_name, generic=True, artifact=artifact)
                return _zip_response(archive_name, archive_bytes)
            payload = build_generic_project_export(project, export_format=export_format)
            _log_export(
                project,
                user,
                export_format,
                entrypoint,
                archive=False,
                version=payload.get("export_version"),
                generic=True,
                artifact=artifact,
            )
            return Response(payload, status=status.HTTP_200_OK)

        if artifact != "validated_dataset":
            if export_format not in CV_ARTIFACT_EXPORT_FORMATS:
                return Response(
                    {"detail": "Invalid artifact export format. Use json, jsonl, csv or both"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            from apps.cv_annotation.services.workflow import build_project_artifact_export, build_project_artifact_export_archive

            if _as_archive(request):
                archive_name, archive_bytes = build_project_artifact_export_archive(project, artifact=artifact, export_format=export_format)
                _log_export(project, user, export_format, entrypoint, archive=True, filename=archive_name, artifact=artifact)
                return _zip_response(archive_name, archive_bytes)
            payload = build_project_artifact_export(project, artifact=artifact, export_format=export_format)
            _log_export(project, user, export_format, entrypoint, archive=False, version=payload.get("export_version"), artifact=artifact)
            return Response(payload, status=status.HTTP_200_OK)

        if export_format not in CV_EXPORT_FORMATS:
            return Response(
                {"detail": "Invalid export format. Use coco, yolo, voc, tfrecord, csv, json, jsonl or both"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if export_format == "tfrecord":
            bundle = collect_project_export_bundle(project)
            path, filename, warnings = export_tfrecord(bundle)
            response = FileResponse(open(path, "rb"), content_type="application/octet-stream", as_attachment=True, filename=filename)
            response["X-Export-Warnings"] = str(int(warnings))
            _log_export(project, user, export_format, entrypoint, archive=True, filename=filename, warnings=warnings, artifact=artifact)
            return response

        from apps.cv_annotation.services.workflow import build_dataset_export, build_dataset_export_archive

        if _as_archive(request):
            archive_name, archive_bytes = build_dataset_export_archive(project, export_format=export_format)
            _log_export(project, user, export_format, entrypoint, archive=True, filename=archive_name, artifact=artifact)
            return _zip_response(archive_name, archive_bytes)

        payload = build_dataset_export(project, export_format=export_format)
        _log_export(project, user, export_format, entrypoint, archive=False, version=payload.get("export_version"), artifact=artifact)
        return Response(payload, status=status.HTTP_200_OK)

    except Exception as exc:
        import traceback

        logger.error("Unexpected error in export_dataset: %s", str(exc))
        logger.error(traceback.format_exc())
        return Response(
            {"detail": "Internal server error: %s" % str(exc)},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
