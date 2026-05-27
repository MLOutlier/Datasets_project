from __future__ import annotations

from datetime import datetime
import csv
import io
import json
import secrets

from bson import ObjectId
from django.http import HttpRequest, HttpResponse
from mongoengine import Q
from rest_framework import permissions, status
from rest_framework.decorators import action
from rest_framework.renderers import BaseRenderer, JSONRenderer
from rest_framework.response import Response
from rest_framework.viewsets import ViewSet

from ..datasets_core.models import Dataset
from ..labeling.models import Annotation, LabelingSession
from ..labeling.serializers import AnnotationSerializer
from ..users.models import User
from ..users.views import authenticate_from_jwt
from .models import Project, ProjectInstructionAsset, ProjectMembership, Task
from .serializers import ProjectSerializer, TaskSerializer
from .services.instructions import acknowledge_instructions, instruction_asset_payload, instruction_bundle, touch_instruction_version
from .services.generic_tasks import (
    build_generic_project_export,
    build_generic_project_export_archive,
    create_generic_tasks_from_items,
    generic_task_summary,
    is_generic_task_project,
    validate_generic_submission,
)
from .services.instructions_upload import InstructionUploadError, save_project_instruction, save_project_instruction_asset
from .services.materializer import ProjectTaskMaterializer
from .export_utils import export_project_dataset
from .task_registry import is_source_task_allowed, source_task_types_for_task, task_type_registry_payload

PAGE_SIZE = 20


class _VocRenderer(BaseRenderer):
    media_type = "application/zip"
    format = "voc"
    render_style = "binary"

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return b""


class _CocoRenderer(BaseRenderer):
    media_type = "application/zip"
    format = "coco"
    render_style = "binary"

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return b""


class _YoloRenderer(BaseRenderer):
    media_type = "application/zip"
    format = "yolo"
    render_style = "binary"

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return b""


class _TfRecordRenderer(BaseRenderer):
    media_type = "application/octet-stream"
    format = "tfrecord"
    render_style = "binary"

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return b""


class JWTRequiredMixin:
    permission_classes = [permissions.AllowAny]

    def _get_user(self, request: HttpRequest):
        try:
            user = authenticate_from_jwt(request)
            request.user = user
            return user
        except PermissionError:
            return None

    def _require_user(self, request: HttpRequest):
        user = self._get_user(request)
        if not user:
            return None, Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        return user, None


class ProjectViewSet(JWTRequiredMixin, ViewSet):
    def _sync_cv_workflow(self, project: Project) -> None:
        if project.project_type != Project.TYPE_CV:
            return
        ProjectTaskMaterializer(project).sync()

    def _project_for_instruction_owner(self, user: User, pk: str):
        if not ObjectId.is_valid(pk):
            return None
        if user.role == User.ROLE_ADMIN:
            return Project.objects(id=ObjectId(pk)).first()
        return Project.objects(id=ObjectId(pk), owner=user).first()

    def _source_option_payload(self, project: Project, task_type: str) -> dict:
        from apps.cv_annotation.models import VideoInterval, WorkItem

        source_task_type = getattr(project, "task_type", "bbox_annotation") or "bbox_annotation"
        details = {}
        ready_count = 0
        if task_type == "video_interval_validation":
            ready_count = VideoInterval.objects(project=project, status__in=[VideoInterval.STATUS_DRAFT, VideoInterval.STATUS_APPROVED]).count()
            details = {"intervals": ready_count}
        elif task_type == "bbox_annotation":
            ready_count = VideoInterval.objects(project=project, status=VideoInterval.STATUS_APPROVED).count()
            details = {"approved_intervals": ready_count}
        elif task_type == "bbox_validation":
            ready_count = WorkItem.objects(project=project, status=WorkItem.STATUS_COMPLETED).count()
            details = {"completed_work_items": ready_count}
        return {
            "id": str(project.id),
            "title": project.title,
            "task_type": source_task_type,
            "status": project.status,
            "ready": ready_count > 0,
            "ready_count": int(ready_count or 0),
            "details": details,
            "created_at": project.created_at,
            "updated_at": project.updated_at,
        }

    def get_queryset_for_user(self, user: User):
        if user.role in (User.ROLE_ADMIN,):
            return Project.objects.order_by("-created_at")
        if user.role == User.ROLE_CUSTOMER:
            return Project.objects(owner=user).order_by("-created_at")
        accessible_ids = list(
            ProjectMembership.objects(user=user, is_active=True).scalar("project")
        )
        return Project.objects(id__in=accessible_ids, status__ne=Project.STATUS_PAUSED).order_by("-created_at")

    def _paginate(self, qs, request):
        try:
            limit = int(request.query_params.get("limit", PAGE_SIZE))
        except ValueError:
            limit = PAGE_SIZE
        limit = max(1, min(limit, 100))
        try:
            offset = int(request.query_params.get("offset", 0))
        except ValueError:
            offset = 0
        total = qs.count()
        items = list(qs.skip(offset).limit(limit))
        return items, {"limit": limit, "offset": offset, "total": total}

    def list(self, request, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        qs = self.get_queryset_for_user(user)
        search = str(request.query_params.get("search") or "").strip()
        status_filter = str(request.query_params.get("status") or "").strip()
        task_type_filter = str(request.query_params.get("task_type") or "").strip()
        annotation_type_filter = str(request.query_params.get("annotation_type") or "").strip()
        if search:
            qs = qs.filter(Q(title__icontains=search) | Q(description__icontains=search))
        if status_filter:
            qs = qs.filter(status=status_filter)
        if task_type_filter:
            qs = qs.filter(task_type=task_type_filter)
        if annotation_type_filter:
            qs = qs.filter(annotation_type=annotation_type_filter)
        items, meta = self._paginate(qs, request)
        serializer = ProjectSerializer(items, many=True, context={"request": request})
        return Response({"items": serializer.data, **meta}, status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="task-registry")
    def task_registry(self, request, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        return Response(task_type_registry_payload(), status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="source-options")
    def source_options(self, request, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        task_type = str(request.query_params.get("task_type") or "")
        allowed_source_types = source_task_types_for_task(task_type)
        if not allowed_source_types:
            return Response({"items": [], "task_type": task_type, "source_task_types": []}, status=status.HTTP_200_OK)
        qs = Project.objects.order_by("-created_at") if user.role == User.ROLE_ADMIN else Project.objects(owner=user).order_by("-created_at")
        projects = [
            project
            for project in qs
            if is_source_task_allowed(task_type, getattr(project, "task_type", "bbox_annotation") or "bbox_annotation")
        ]
        items = [self._source_option_payload(project, task_type) for project in projects]
        ready_items = [item for item in items if item.get("ready")]
        return Response(
            {
                "items": ready_items,
                "task_type": task_type,
                "source_task_types": list(allowed_source_types),
            },
            status=status.HTTP_200_OK,
        )

    def create(self, request, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if user.role not in (User.ROLE_CUSTOMER, User.ROLE_ADMIN):
            return Response({"detail": "Only customers can create projects"}, status=status.HTTP_403_FORBIDDEN)
        serializer = ProjectSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        project = serializer.create(serializer.validated_data)
        self._sync_cv_workflow(project)
        try:
            from apps.cv_annotation.models import SecurityEvent
            from apps.cv_annotation.services.security import log_security_event

            log_security_event(
                project=project,
                actor=user,
                event_type="project_created",
                payload={
                    "task_type": getattr(project, "task_type", ""),
                    "widget_type": getattr(project, "widget_type", ""),
                    "project_type": project.project_type,
                    "annotation_type": project.annotation_type,
                },
                severity="info",
            )
        except Exception:
            pass
        return Response(ProjectSerializer(project, context={"request": request}).data, status=status.HTTP_201_CREATED)

    def retrieve(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid id"}, status=status.HTTP_400_BAD_REQUEST)
        project = self.get_queryset_for_user(user).filter(id=ObjectId(pk)).first()
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(ProjectSerializer(project, context={"request": request}).data, status=status.HTTP_200_OK)

    def update(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        project = Project.objects(id=ObjectId(pk), owner=user).first()
        if not project and user.role != User.ROLE_ADMIN:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role == User.ROLE_ADMIN and not project:
            project = Project.objects(id=ObjectId(pk)).first()
        serializer = ProjectSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        updated = serializer.update(project, serializer.validated_data)
        self._sync_cv_workflow(updated)
        return Response(ProjectSerializer(updated, context={"request": request}).data, status=status.HTTP_200_OK)

    def partial_update(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        project = Project.objects(id=ObjectId(pk), owner=user).first()
        if not project and user.role != User.ROLE_ADMIN:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role == User.ROLE_ADMIN and not project:
            project = Project.objects(id=ObjectId(pk)).first()
        serializer = ProjectSerializer(project, data=request.data, context={"request": request}, partial=True)
        serializer.is_valid(raise_exception=True)
        updated = serializer.update(project, serializer.validated_data)
        self._sync_cv_workflow(updated)
        return Response(ProjectSerializer(updated, context={"request": request}).data, status=status.HTTP_200_OK)

    def destroy(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        project = Project.objects(id=ObjectId(pk), owner=user).first()
        if not project and user.role != User.ROLE_ADMIN:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role == User.ROLE_ADMIN and not project:
            project = Project.objects(id=ObjectId(pk)).first()
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        project.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="pause")
    def pause(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)
        project = Project.objects(id=ObjectId(pk)).first()
        if not project or (user.role != User.ROLE_ADMIN and str(project.owner.id) != str(user.id)):
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        project.status = Project.STATUS_PAUSED
        project.save()
        return Response(ProjectSerializer(project, context={"request": request}).data, status=status.HTTP_200_OK)

    @action(detail=True, methods=["post"], url_path="resume")
    def resume(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)
        project = Project.objects(id=ObjectId(pk)).first()
        if not project or (user.role != User.ROLE_ADMIN and str(project.owner.id) != str(user.id)):
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        project.status = Project.STATUS_ACTIVE
        project.save()
        return Response(ProjectSerializer(project, context={"request": request}).data, status=status.HTTP_200_OK)

    @action(
        detail=True,
        methods=["get"],
        url_path="export",
        renderer_classes=[JSONRenderer, _VocRenderer, _CocoRenderer, _YoloRenderer, _TfRecordRenderer],
    )
    def export(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        return export_project_dataset(pk, user, request, entrypoint="projects")

    @action(detail=True, methods=["post"], url_path="instructions/upload")
    def instructions_upload(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)

        project = None
        if user.role == User.ROLE_ADMIN:
            project = Project.objects(id=ObjectId(pk)).first()
        else:
            project = Project.objects(id=ObjectId(pk), owner=user).first()

        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)

        if user.role not in (User.ROLE_CUSTOMER, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)

        if "file" not in request.FILES:
            return Response({"detail": "file is required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            payload, _path = save_project_instruction(request.FILES["file"], str(project.id))
        except InstructionUploadError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        project.instructions_file_uri = payload["file_uri"]
        project.instructions_file_name = payload["file_name"]
        project.instructions_version = int(project.instructions_version or 0) + 1
        project.instructions_updated_at = datetime.utcnow()
        project.save()
        ProjectInstructionAsset(
            project=project,
            created_by=user,
            asset_type=ProjectInstructionAsset.TYPE_INSTRUCTION,
            title=payload["file_name"],
            file_uri=payload["file_uri"],
            file_name=payload["file_name"],
            mime_type=payload.get("mime_type", ""),
            file_size=int(payload.get("file_size") or 0),
        ).save()

        return Response(
            {
                "instructions_file_uri": project.instructions_file_uri,
                "instructions_file_name": project.instructions_file_name,
                "instructions_version": project.instructions_version,
                "instructions_updated_at": project.instructions_updated_at,
            },
            status=status.HTTP_200_OK,
        )

    @action(detail=True, methods=["get", "patch"], url_path="instructions")
    def instructions(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)
        project = self.get_queryset_for_user(user).filter(id=ObjectId(pk)).first()
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if request.method.lower() == "patch":
            if user.role not in (User.ROLE_CUSTOMER, User.ROLE_ADMIN) or (user.role != User.ROLE_ADMIN and str(project.owner.id) != str(user.id)):
                return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
            project.instructions = str(request.data.get("instructions") or "")
            touch_instruction_version(project)
        return Response(instruction_bundle(project, user), status=status.HTTP_200_OK)

    @action(detail=True, methods=["post"], url_path="instructions/assets")
    def instructions_assets(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        project = self._project_for_instruction_owner(user, pk)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        asset_type = str(request.data.get("asset_type") or ProjectInstructionAsset.TYPE_INSTRUCTION)
        if asset_type not in {
            ProjectInstructionAsset.TYPE_INSTRUCTION,
            ProjectInstructionAsset.TYPE_LINK,
            ProjectInstructionAsset.TYPE_EMBEDDED,
        }:
            return Response({"detail": "Unsupported instruction asset type"}, status=status.HTTP_400_BAD_REQUEST)
        payload = {
            "file_uri": "",
            "file_name": "",
            "mime_type": "",
            "file_size": "0",
        }
        if "file" in request.FILES:
            try:
                payload, _path = save_project_instruction_asset(request.FILES["file"], str(project.id))
            except InstructionUploadError as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
            asset_type = ProjectInstructionAsset.TYPE_INSTRUCTION
        asset = ProjectInstructionAsset(
            project=project,
            created_by=user,
            asset_type=asset_type,
            title=str(request.data.get("title") or payload.get("file_name") or ""),
            body=str(request.data.get("body") or ""),
            url=str(request.data.get("url") or ""),
            file_uri=payload["file_uri"],
            file_name=payload["file_name"],
            mime_type=payload["mime_type"],
            file_size=int(payload["file_size"] or 0),
        )
        asset.save()
        touch_instruction_version(project)
        return Response({"asset": instruction_asset_payload(asset), "bundle": instruction_bundle(project, user)}, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="instructions/examples")
    def instructions_examples(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        project = self._project_for_instruction_owner(user, pk)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        example_type = str(request.data.get("example_type") or "good").lower()
        asset_type = {
            "good": ProjectInstructionAsset.TYPE_GOOD_EXAMPLE,
            "bad": ProjectInstructionAsset.TYPE_BAD_EXAMPLE,
            "annotated": ProjectInstructionAsset.TYPE_ANNOTATED_EXAMPLE,
        }.get(example_type)
        if not asset_type:
            return Response({"detail": "example_type must be good, bad, or annotated"}, status=status.HTTP_400_BAD_REQUEST)
        payload = {
            "file_uri": "",
            "file_name": "",
            "mime_type": "",
            "file_size": "0",
        }
        if "file" in request.FILES:
            try:
                payload, _path = save_project_instruction_asset(request.FILES["file"], str(project.id), folder="instruction-examples")
            except InstructionUploadError as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        label_data = request.data.get("label_data") or {}
        if isinstance(label_data, str):
            try:
                label_data = json.loads(label_data) if label_data.strip() else {}
            except json.JSONDecodeError:
                return Response({"detail": "label_data must be a valid JSON object"}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(label_data, dict):
            return Response({"detail": "label_data must be an object"}, status=status.HTTP_400_BAD_REQUEST)
        asset = ProjectInstructionAsset(
            project=project,
            created_by=user,
            asset_type=asset_type,
            title=str(request.data.get("title") or payload.get("file_name") or ""),
            body=str(request.data.get("body") or ""),
            url=str(request.data.get("url") or ""),
            file_uri=payload["file_uri"],
            file_name=payload["file_name"],
            mime_type=payload["mime_type"],
            file_size=int(payload["file_size"] or 0),
            label_data=label_data,
        )
        asset.save()
        touch_instruction_version(project)
        return Response({"asset": instruction_asset_payload(asset), "bundle": instruction_bundle(project, user)}, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get"], url_path="tasks/next")
    def tasks_next(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)
        project = self.get_queryset_for_user(user).filter(id=ObjectId(pk)).first()
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role == User.ROLE_ANNOTATOR and project.status == Project.STATUS_PAUSED:
            return Response({"detail": "Project is paused", "code": "project_paused"}, status=status.HTTP_423_LOCKED)
        if user.role == User.ROLE_ANNOTATOR:
            task = Task.objects(project=project, annotator=user, status=Task.STATUS_IN_PROGRESS).order_by("-difficulty_score", "created_at").first()
            if not task:
                task = Task.objects(project=project, status=Task.STATUS_PENDING).filter(
                    Q(annotator=None) | Q(annotator=user)
                ).order_by("-difficulty_score", "created_at").first()
            if task and task.status == Task.STATUS_PENDING:
                task.annotator = user
                task.status = Task.STATUS_IN_PROGRESS
                task.save()
        else:
            task = Task.objects(project=project, status__in=[Task.STATUS_IN_PROGRESS, Task.STATUS_PENDING]).order_by("-difficulty_score", "created_at").first()
        if not task:
            return Response({"detail": "No pending tasks available"}, status=status.HTTP_404_NOT_FOUND)
        return Response(TaskSerializer(task, context={"request": request}).data, status=status.HTTP_200_OK)

    @action(detail=True, methods=["get", "post"], url_path="generic-tasks")
    def generic_tasks(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)
        project = Project.objects(id=ObjectId(pk)).first()
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role != User.ROLE_ADMIN and str(project.owner.id) != str(user.id):
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if not is_generic_task_project(project):
            return Response({"detail": "Generic tasks are available only for generic task types"}, status=status.HTTP_400_BAD_REQUEST)

        if request.method.lower() == "get":
            tasks = list(Task.objects(project=project).order_by("-created_at").limit(100))
            return Response(
                {
                    "summary": generic_task_summary(project),
                    "items": TaskSerializer(tasks, many=True, context={"request": request}).data,
                },
                status=status.HTTP_200_OK,
            )

        items = request.data.get("items") if hasattr(request.data, "get") else None
        if "file" in request.FILES:
            raw_data = request.FILES["file"].read()
            try:
                text = raw_data.decode("utf-8-sig")
            except Exception:
                return Response({"detail": "CSV must be utf-8 encoded"}, status=status.HTTP_400_BAD_REQUEST)
            reader = csv.DictReader(io.StringIO(text))
            if reader.fieldnames:
                items = [dict(row) for row in reader]
            else:
                items = [line.strip() for line in text.splitlines() if line.strip()]
        elif isinstance(items, str):
            stripped = items.strip()
            if stripped.startswith("["):
                try:
                    items = json.loads(stripped)
                except json.JSONDecodeError:
                    return Response({"detail": "items must be valid JSON array or a newline list"}, status=status.HTTP_400_BAD_REQUEST)
            else:
                items = [line.strip() for line in stripped.splitlines() if line.strip()]
        if not isinstance(items, list) or not items:
            return Response({"detail": "Provide non-empty items list or CSV file"}, status=status.HTTP_400_BAD_REQUEST)
        materialized = ProjectTaskMaterializer(project).materialize_generic_items(items)
        result = materialized.summary or {}
        return Response(
            {
                "summary": generic_task_summary(project),
                **result,
                "materialization": materialized.to_dict(),
            },
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["post"], url_path="participants/import-csv")
    def participants_import_csv(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if user.role not in (User.ROLE_CUSTOMER, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)
        project = Project.objects(id=ObjectId(pk), owner=user).first() if user.role != User.ROLE_ADMIN else Project.objects(id=ObjectId(pk)).first()
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if "file" not in request.FILES:
            return Response({"detail": "file is required"}, status=status.HTTP_400_BAD_REQUEST)
        raw_data = request.FILES["file"].read()
        try:
            text = raw_data.decode("utf-8-sig")
        except Exception:
            return Response({"detail": "CSV must be utf-8 encoded"}, status=status.HTTP_400_BAD_REQUEST)
        reader = csv.DictReader(io.StringIO(text))
        required_fields = {"email"}
        if not required_fields.issubset(set(reader.fieldnames or [])):
            return Response({"detail": "CSV must include email"}, status=status.HTTP_400_BAD_REQUEST)
        created = 0
        linked = 0
        skipped = 0
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=["email", "username", "password", "status"])
        writer.writeheader()

        def _split_groups(value: str) -> list[str]:
            return [item.strip() for item in str(value or "").replace(";", ",").split(",") if item.strip()]

        def _username_from_email(email_value: str) -> str:
            base = (email_value.split("@", 1)[0] or "annotator").strip().lower()
            base = "".join(ch for ch in base if ch.isalnum() or ch in "._-") or "annotator"
            candidate = base
            index = 1
            while User.objects(username=candidate).first():
                candidate = f"{base}{index}"
                index += 1
            return candidate

        def _username_from_name(name_value: str) -> str:
            base = str(name_value or "").strip().lower().replace(" ", ".")
            base = "".join(ch for ch in base if ch.isalnum() or ch in "._-") or "annotator"
            candidate = base
            index = 1
            while User.objects(username=candidate).first():
                candidate = f"{base}{index}"
                index += 1
            return candidate

        def _unique_username(raw_username: str, email_value: str) -> str:
            base = raw_username or _username_from_email(email_value)
            if not User.objects(username=base).first():
                return base
            return _username_from_email(email_value)

        for row in reader:
            email = (row.get("email") or "").strip().lower()
            username = (row.get("username") or "").strip()
            if not username and (row.get("name") or "").strip():
                username = _username_from_name(row.get("name") or "")
            if not username:
                username = _username_from_email(email)
            else:
                username = _unique_username(username, email)
            role = (row.get("role") or User.ROLE_ANNOTATOR).strip().lower()
            group_name = (row.get("group") or row.get("group_name") or "").strip()
            groups = _split_groups(row.get("groups") or group_name)
            if group_name and group_name not in groups:
                groups.insert(0, group_name)
            specialization = (row.get("specialization") or "").strip()
            if role not in (User.ROLE_ANNOTATOR, User.ROLE_REVIEWER) or not email:
                skipped += 1
                continue
            participant = User.objects(email=email).first()
            password = ""
            row_status = "linked_existing"
            if not participant:
                password = secrets.token_urlsafe(12)
                participant = User(email=email, username=username, role=role, group_name=group_name, groups=groups, specialization=specialization)
                participant.set_password(password)
                participant.save()
                created += 1
                row_status = "created"
            else:
                current_groups = list(getattr(participant, "groups", []) or [])
                merged_groups = list(dict.fromkeys([*current_groups, *groups]))
                if merged_groups != current_groups:
                    participant.groups = merged_groups
                if group_name and not participant.group_name:
                    participant.group_name = group_name
                if specialization and not participant.specialization:
                    participant.specialization = specialization
                participant.save()
            membership_role = ProjectMembership.ROLE_ANNOTATOR if role == User.ROLE_ANNOTATOR else ProjectMembership.ROLE_REVIEWER
            membership = ProjectMembership.objects(project=project, user=participant, role=membership_role).first()
            if not membership:
                membership = ProjectMembership(project=project, user=participant, role=membership_role)
                linked += 1
            membership.group_name = group_name or membership.group_name
            current_membership_groups = list(getattr(membership, "groups", []) or [])
            membership.groups = list(dict.fromkeys([*current_membership_groups, *groups]))
            membership.specialization = specialization or membership.specialization
            membership.is_active = True
            membership.save()
            if membership_role == ProjectMembership.ROLE_ANNOTATOR and all(str(item.id) != str(participant.id) for item in (project.allowed_annotators or [])):
                project.allowed_annotators = [*(project.allowed_annotators or []), participant]
                project.save()
            if membership_role == ProjectMembership.ROLE_REVIEWER and all(str(item.id) != str(participant.id) for item in (project.allowed_reviewers or [])):
                project.allowed_reviewers = [*(project.allowed_reviewers or []), participant]
                project.save()
            writer.writerow({"email": participant.email, "username": participant.username, "password": password, "status": row_status})
        self._sync_cv_workflow(project)
        response = HttpResponse(output.getvalue(), content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="project_{project.id}_participant_credentials.csv"'
        response["X-Created-Users"] = str(created)
        response["X-Linked-Memberships"] = str(linked)
        response["X-Skipped-Rows"] = str(skipped)
        return response

    @action(detail=True, methods=["post"], url_path="assignments/manual-distribute")
    def assignments_manual_distribute(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if user.role not in (User.ROLE_CUSTOMER, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)
        project = Project.objects(id=ObjectId(pk), owner=user).first() if user.role != User.ROLE_ADMIN else Project.objects(id=ObjectId(pk)).first()
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        annotator_ids = request.data.get("annotator_ids") or []
        max_items = int(request.data.get("max_items", 50))
        if not isinstance(annotator_ids, list) or not annotator_ids:
            return Response({"detail": "annotator_ids must be a non-empty list"}, status=status.HTTP_400_BAD_REQUEST)
        from apps.cv_annotation.models import Assignment, WorkItem

        annotators = []
        allowed_ids = {str(item.id) for item in (project.allowed_annotators or [])}
        for raw_id in annotator_ids:
            if ObjectId.is_valid(raw_id):
                participant = User.objects(id=ObjectId(raw_id), role=User.ROLE_ANNOTATOR, is_active=True).first()
                if participant and (not allowed_ids or str(participant.id) in allowed_ids):
                    annotators.append(participant)
        if not annotators:
            return Response({"detail": "No valid annotators found"}, status=status.HTTP_400_BAD_REQUEST)

        pending_items = list(WorkItem.objects(project=project, status=WorkItem.STATUS_PENDING).limit(max_items))
        created_assignments = 0
        pointer = 0
        for work_item in pending_items:
            annotator = annotators[pointer % len(annotators)]
            pointer += 1
            membership = ProjectMembership.objects(
                project=project,
                user=annotator,
                role=ProjectMembership.ROLE_ANNOTATOR,
            ).first()
            if not membership:
                membership = ProjectMembership(
                    project=project,
                    user=annotator,
                    role=ProjectMembership.ROLE_ANNOTATOR,
                )
            membership.is_active = True
            membership.specialization = annotator.specialization
            membership.group_name = annotator.group_name
            membership.save()
            exists = Assignment.objects(project=project, work_item=work_item, annotator=annotator).first()
            if exists:
                continue
            next_order = Assignment.objects(project=project, work_item=work_item).count()
            Assignment(project=project, work_item=work_item, annotator=annotator, status=Assignment.STATUS_ASSIGNED, order_index=next_order).save()
            created_assignments += 1
        return Response({"work_items_considered": len(pending_items), "assignments_created": created_assignments}, status=status.HTTP_200_OK)
    # =============================================================================
    # ЛИДЕРБОРД ПРОЕКТА
    # =============================================================================
    @action(detail=True, methods=["get"], url_path="leaderboard")
    def leaderboard(self, request, pk: str = None, *args, **kwargs) -> Response:
        """
        Получить лидерборд проекта.
        GET /api/projects/{id}/leaderboard/
        
        Возвращает топ-10 аннотаторов проекта с метриками:
        - completed_tasks: количество выполненных задач
        - average_f1: средний F1-score
        - total_annotations: общее количество аннотаций
        - rating: рейтинг
        """
        user, resp = self._require_user(request)
        if resp:
            return resp
        
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid project id"}, status=status.HTTP_400_BAD_REQUEST)
        
        project = Project.objects(id=ObjectId(pk)).first()
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        
        # Проверка доступа к проекту
        if user.role not in (User.ROLE_ADMIN, User.ROLE_CUSTOMER):
            is_member = ProjectMembership.objects(
                project=project, user=user, is_active=True
            ).first()
            if not is_member and str(project.owner.id) != str(user.id):
                return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
        
        from ..quality.models import QualityMetric
        
        # Получаем все задачи проекта
        project_tasks = Task.objects(project=project)
        project_task_ids = [t.id for t in project_tasks]
        
        if not project_task_ids:
            return Response({
                'leaderboard': [],
                'current_user': None,
                'total_participants': 0,
            })
        
        # Получаем аннотаторов проекта (всех, кто сделал хотя бы одну аннотацию)
        annotator_ids = list(
            Annotation.objects(task__in=project_task_ids).distinct("annotator")
        )
        
        leaderboard = []
        for ann_id in annotator_ids:
            ann = User.objects(id=ann_id).first()
            if not ann:
                continue
            
            # Аннотации этого пользователя в проекте
            ann_annotations = Annotation.objects(
                annotator=ann,
                task__in=project_task_ids
            )
            
            # Количество выполненных аннотаций (не черновиков)
            completed = ann_annotations.filter(
                status__in=["submitted", "accepted", "pending_review"]
            ).count()
            
            # Уникальные задачи, которые размечал пользователь
            unique_tasks = len(set(a.task.id for a in ann_annotations))
            
            # Средний F1-score по метрикам качества для задач этого пользователя
            user_task_ids = [a.task.id for a in ann_annotations]
            metrics = QualityMetric.objects(task__in=user_task_ids)
            if metrics.count() > 0:
                avg_f1 = round(sum(m.f1 for m in metrics) / metrics.count(), 3)
            else:
                avg_f1 = 0.0
            
            leaderboard.append({
                'user_id': str(ann.id),
                'username': ann.username,
                'email': ann.email,
                'rating': round(ann.rating or 0.0, 2),
                'completed_tasks': completed,
                'unique_tasks': unique_tasks,
                'total_annotations': ann_annotations.count(),
                'average_f1': avg_f1,
            })
        
        # Сортировка: сначала по среднему F1, потом по количеству выполненных задач
        leaderboard.sort(key=lambda x: (x['average_f1'], x['completed_tasks']), reverse=True)
        
        # Топ-10
        top_10 = leaderboard[:10]
        
        # Добавляем позицию
        for i, entry in enumerate(top_10):
            entry['position'] = i + 1
        
        # Находим текущего пользователя (если он есть в списке)
        current_user_entry = None
        for idx, entry in enumerate(leaderboard):
            if entry['user_id'] == str(user.id):
                current_user_entry = entry
                current_user_entry['position'] = idx + 1
                break
        
        return Response({
            'leaderboard': top_10,
            'current_user': current_user_entry,
            'total_participants': len(leaderboard),
        })

    @action(detail=True, methods=["get"], url_path="export-legacy")
    def export_dataset(self, request, pk=None, *args, **kwargs) -> Response:
        """Export annotated dataset of the project."""
        user, resp = self._require_user(request)
        if resp:
            return resp
        return Response(
            {"detail": "Legacy endpoint disabled. Use /export?format=voc|coco|yolo|tfrecord"},
            status=status.HTTP_400_BAD_REQUEST,
        )


class TaskViewSet(JWTRequiredMixin, ViewSet):
    def _base_qs(self, user: User):
        if user.role == User.ROLE_ADMIN:
            return Task.objects.order_by("-created_at")
        if user.role == User.ROLE_ANNOTATOR:
            return Task.objects(annotator=user).order_by("-created_at")
        user_dataset_ids = list(Dataset.objects(owner=user).scalar("id"))
        if not user_dataset_ids:
            return Task.objects(status="does_not_exist")
        return Task.objects(dataset__in=user_dataset_ids).order_by("-created_at")

    def _paginate(self, qs, request):
        try:
            limit = int(request.query_params.get("limit", PAGE_SIZE))
        except ValueError:
            limit = PAGE_SIZE
        limit = max(1, min(limit, 100))
        try:
            offset = int(request.query_params.get("offset", 0))
        except ValueError:
            offset = 0
        total = qs.count()
        items = list(qs.skip(offset).limit(limit))
        return items, {"limit": limit, "offset": offset, "total": total}

    def list(self, request, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        qs = self._base_qs(user)
        status_filter = request.query_params.get("status")
        if status_filter:
            qs = qs.filter(status=status_filter)
        if not status_filter:
            qs = qs.order_by("-difficulty_score", "-created_at")
        items, meta = self._paginate(qs, request)
        serializer = TaskSerializer(items, many=True, context={"request": request})
        return Response({"items": serializer.data, **meta}, status=status.HTTP_200_OK)

    def create(self, request, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        serializer = TaskSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        task = serializer.create(serializer.validated_data)
        return Response(TaskSerializer(task, context={"request": request}).data, status=status.HTTP_201_CREATED)

    def retrieve(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid id"}, status=status.HTTP_400_BAD_REQUEST)
        task = self._base_qs(user).filter(id=ObjectId(pk)).first()
        if not task:
            return Response({"detail": "Task not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(TaskSerializer(task, context={"request": request}).data, status=status.HTTP_200_OK)

    def _has_access(self, task, user):
        """Проверка доступа пользователя к задаче через проект или датасет."""
        if task.project:
            return str(task.project.owner.id) == str(user.id)
        return str(task.dataset.owner.id) == str(user.id)

    def update(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        task = self._base_qs(user).filter(id=ObjectId(pk)).first()
        if not task:
            return Response({"detail": "Task not found"}, status=status.HTTP_404_NOT_FOUND)
        serializer = TaskSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        updated = serializer.update(task, serializer.validated_data)
        return Response(TaskSerializer(updated, context={"request": request}).data, status=status.HTTP_200_OK)

    def partial_update(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        task = self._base_qs(user).filter(id=ObjectId(pk)).first()
        if not task:
            return Response({"detail": "Task not found"}, status=status.HTTP_404_NOT_FOUND)
        serializer = TaskSerializer(task, data=request.data, context={"request": request}, partial=True)
        serializer.is_valid(raise_exception=True)
        updated = serializer.update(task, serializer.validated_data)
        return Response(TaskSerializer(updated, context={"request": request}).data, status=status.HTTP_200_OK)

    @action(detail=True, methods=["patch"], url_path="annotate")
    def annotate(self, request, pk: str = None, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp
        if not ObjectId.is_valid(pk):
            return Response({"detail": "Invalid task id"}, status=status.HTTP_400_BAD_REQUEST)
        task = Task.objects(id=ObjectId(pk)).first()
        if not task:
            return Response({"detail": "Task not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role != User.ROLE_ANNOTATOR:
            return Response({"detail": "Forbidden: only annotator"}, status=status.HTTP_403_FORBIDDEN)
        if task.annotator and str(task.annotator.id) != str(user.id):
            return Response({"detail": "Task is assigned to another annotator"}, status=status.HTTP_403_FORBIDDEN)
        if task.project and task.project.project_type == Project.TYPE_CV:
            return Response(
                {"detail": "CV projects use /api/annotator/assignments/{assignment_id}/submit/ workflow"},
                status=status.HTTP_409_CONFLICT,
            )
        if task.project and is_generic_task_project(task.project):
            validation_error = validate_generic_submission(task.project, request.data.get("label_data") or {})
            if validation_error:
                return Response({"detail": validation_error}, status=status.HTTP_400_BAD_REQUEST)

        session = LabelingSession.objects(task=task, annotator=user, status=LabelingSession.STATUS_ACTIVE).first()
        if not session:
            session = LabelingSession(annotator=user, task=task, dataset=task.dataset, status=LabelingSession.STATUS_ACTIVE)
            session.save()

        data = dict(request.data)
        data["task_id"] = str(task.id)
        data["dataset_id"] = str(task.dataset.id)
        data["session_id"] = str(session.id)

        serializer = AnnotationSerializer(data=data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        annotation = serializer.create(serializer.validated_data)

        if annotation.is_final or annotation.status == Annotation.STATUS_PENDING_REVIEW:
            if task.status in (Task.STATUS_IN_PROGRESS, Task.STATUS_PENDING):
                task.status = Task.STATUS_REVIEW if annotation.status == Annotation.STATUS_PENDING_REVIEW else Task.STATUS_COMPLETED
                task.save()
            if annotation.is_final and session:
                session.complete()

        return Response(serializer.to_representation(annotation), status=status.HTTP_201_CREATED)
