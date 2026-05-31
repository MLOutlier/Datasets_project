from __future__ import annotations

from bson import ObjectId
from django.http import HttpResponse, JsonResponse
from django.http import HttpRequest
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.projects.models import Project, ProjectMembership, Task
from apps.projects.export_utils import export_project_dataset
from apps.projects.services.generic_tasks import (
    build_generic_project_export,
    build_generic_project_export_archive,
    is_generic_task_project,
)
from apps.projects.services.instructions import acknowledge_instructions, instruction_bundle
from apps.projects.services.materializer import ProjectTaskMaterializer
from apps.projects.task_registry import (
    TASK_BBOX_ANNOTATION,
    TASK_BBOX_VALIDATION,
    TASK_CLASSIFICATION,
    TASK_COMPARISON,
    TASK_IMAGE_ANNOTATION,
    TASK_TEXT_ANNOTATION,
    TASK_VIDEO_ANNOTATION,
    TASK_VIDEO_INTERVAL_VALIDATION,
)
from apps.users.models import User
from apps.users.views import authenticate_from_jwt
from .models import (
    Assignment,
    BBoxValidationAssignment,
    FrameItem,
    GoldenAnnotationAssignment,
    GoldenFrame,
    ImportAsset,
    ImportSession,
    IntervalValidationAssignment,
    ReviewRecord,
    SecurityEvent,
    VideoChunkAssignment,
    VideoChunkTask,
    VideoInterval,
    WorkAnnotation,
    WorkItem,
)
from .serializers import (
    AssignmentSubmitSerializer,
    BBoxValidationSubmitSerializer,
    ImportFinalizeSerializer,
    IntervalValidationDecisionSerializer,
    ReviewResolveSerializer,
    ValidationBatchResolveSerializer,
    VideoChunkSubmitSerializer,
    VideoIntervalUpsertSerializer,
    VideoIntervalValidationSerializer,
)
from .services.upload import save_project_file
from .services.workflow import (
    annotator_batch_payload,
    build_dataset_export_archive,
    build_dataset_export,
    build_import_preview,
    bbox_validation_queue_for_annotator,
    create_manual_golden_frame,
    ensure_bbox_validation_assignments,
    ensure_interval_validation_assignments,
    generate_auto_intervals_for_asset,
    list_video_intervals,
    list_golden_candidates,
    golden_annotation_assignment_payload,
    golden_assignment_public_id,
    maybe_create_hidden_golden_assignment,
    annotator_interval_chunk_queue,
    parse_validation_annotation_upload,
    parse_golden_assignment_public_id,
    process_import_asset,
    project_user_access_state,
    project_overview,
    promote_golden_candidate,
    record_instruction_review_for_access,
    retire_golden_frame,
    resolve_review,
    submit_golden_annotation_assignment,
    submit_bbox_validation_assignment,
    submit_interval_chunk_assignment,
    submit_interval_validation,
    validator_interval_queue,
    resolve_validation_batch,
    save_assignment_annotation,
    upsert_video_intervals,
    validate_video_intervals,
    validation_batch_detail,
    validation_queue,
    _recover_stuck_assignments,
    workflow_runtime_settings,
)
from .services.security import log_security_event


class AuthenticatedAPIView(APIView):
    permission_classes = [permissions.AllowAny]

    def get_user(self, request: HttpRequest) -> User:
        user = authenticate_from_jwt(request)
        request.user = user
        return user

    def get_project_for_user(self, user: User, project_id: str, require_owner: bool = False) -> Project | None:
        if not ObjectId.is_valid(project_id):
            return None
        project = Project.objects(id=ObjectId(project_id)).first()
        if not project:
            return None
        if user.role == User.ROLE_ADMIN:
            return project
        if require_owner:
            return project if str(project.owner.id) == str(user.id) else None
        if str(project.owner.id) == str(user.id):
            return project
        membership = ProjectMembership.objects(project=project, user=user, is_active=True).first()
        if membership:
            return project
        if user.role == User.ROLE_ANNOTATOR:
            assignment = Assignment.objects(project=project, annotator=user).first()
            if assignment:
                return project
            if VideoChunkAssignment.objects(project=project, annotator=user).first():
                return project
            if IntervalValidationAssignment.objects(project=project, validator=user).first():
                return project
            if BBoxValidationAssignment.objects(project=project, validator=user).first():
                return project
        return None

    def project_paused_response(self) -> Response:
        return Response({"detail": "Project is paused", "code": "project_paused"}, status=status.HTTP_423_LOCKED)

    def access_gate_response(self, project: Project, user: User, *, allow_qualification: bool = False) -> Response | None:
        if user.role != User.ROLE_ANNOTATOR:
            return None
        state = project_user_access_state(project, user)
        code = state.get("status")
        if code in {"qualified", "warning"}:
            return None
        if allow_qualification and code == "qualification_required":
            return None
        message = {
            "instruction_required": "Instruction acknowledgement required",
            "qualification_required": "Qualification golden task required",
            "retraining_required": "Instruction retraining required",
            "blocked": "Project access is blocked",
        }.get(str(code), "Project access is not available")
        return Response({"detail": message, "code": code, "access_state": state}, status=status.HTTP_423_LOCKED)

    def project_id_is_not_paused(self, project_id: str) -> bool:
        if not ObjectId.is_valid(str(project_id)):
            return False
        project = Project.objects(id=ObjectId(str(project_id))).first()
        return bool(project and project.status != Project.STATUS_PAUSED)


def project_export_endpoint(request: HttpRequest, project_id: str):
    if request.method != "GET":
        return JsonResponse({"detail": "Method not allowed"}, status=405)
    try:
        user = authenticate_from_jwt(request)
    except PermissionError:
        return JsonResponse({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
    # Проверка роли customer
    if getattr(user, "role", "") not in ("customer", "admin"):
        return JsonResponse({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
    from apps.projects.export_utils import _request_param, export_project_dataset, export_project_images
    export_format = (_request_param(request, "format") or "").strip().lower()
    if export_format == "images":
        return export_project_images(project_id, user, request)
    return export_project_dataset(project_id, user, request, entrypoint="function")


def project_export_images_endpoint(request: HttpRequest, project_id: str):
    if request.method != "GET":
        return JsonResponse({"detail": "Method not allowed"}, status=405)
    try:
        user = authenticate_from_jwt(request)
    except PermissionError:
        return JsonResponse({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
    if getattr(user, "role", "") not in ("customer", "admin"):
        return JsonResponse({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
    from apps.projects.export_utils import export_project_images
    return export_project_images(project_id, user, request)


class ProjectImportView(AuthenticatedAPIView):
    def post(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)

        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if "file" not in request.FILES:
            return Response({"detail": "file is required"}, status=status.HTTP_400_BAD_REQUEST)

        import_session_id = request.data.get("import_id")
        import_session = None
        if import_session_id and ObjectId.is_valid(import_session_id):
            import_session = ImportSession.objects(id=ObjectId(import_session_id), project=project).first()
        if not import_session or import_session.status in (ImportSession.STATUS_FINALIZED, ImportSession.STATUS_FAILED):
            import_session = ImportSession(project=project, created_by=user)
            import_session.save()

        validation_annotations = {}
        annotation_upload = request.FILES.get("annotation_file") or request.FILES.get("annotations")
        if annotation_upload:
            validation_annotations = parse_validation_annotation_upload(annotation_upload)
            if validation_annotations.get("errors"):
                return Response(
                    {"detail": "annotation_file is invalid", "errors": validation_annotations.get("errors") or []},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            payload = save_project_file(request.FILES["file"], str(project.id), str(import_session.id))
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except OSError:
            return Response(
                {"detail": "Upload storage is not writable. Check MEDIA_ROOT permissions."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        asset = ImportAsset(
            import_session=import_session,
            project=project,
            file_uri=payload["file_uri"],
            file_name=payload["file_name"],
            file_size=int(payload["file_size"]),
            mime_type=payload["mime_type"],
            asset_type=payload["asset_type"],
        )
        asset.save()
        processed = process_import_asset(asset, project.frame_interval_sec)
        previous_summary = import_session.summary or {}
        preview = build_import_preview(import_session)
        if validation_annotations:
            previous_summary["validation_upload_annotations"] = validation_annotations
            preview["validation_annotations"] = {
                "items_total": int(validation_annotations.get("items_total") or 0),
                "boxes_total": int(validation_annotations.get("boxes_total") or 0),
                "intervals_total": int(validation_annotations.get("intervals_total") or 0),
                "errors": validation_annotations.get("errors") or [],
            }
        import_session.preview = preview
        import_session.summary = {
            **previous_summary,
            "last_asset_id": str(processed.id),
            "assets_processed": preview["assets_processed"],
            "assets_failed": preview["assets_failed"],
            "frames_total": preview["frames_total"],
        }
        import_session.status = ImportSession.STATUS_READY if preview["assets_processed"] > 0 else ImportSession.STATUS_FAILED
        import_session.errors = preview.get("errors", [])
        import_session.save()

        return Response(
            {
                "import_id": str(import_session.id),
                "asset_id": str(processed.id),
                "asset_status": processed.processing_status,
                "error_message": processed.error_message,
                "preview": preview,
            },
            status=status.HTTP_201_CREATED,
        )


class ProjectImportFinalizeView(AuthenticatedAPIView):
    def post(self, request, project_id: str, import_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if not ObjectId.is_valid(import_id):
            return Response({"detail": "Invalid import id"}, status=status.HTTP_400_BAD_REQUEST)
        import_session = ImportSession.objects(id=ObjectId(import_id), project=project).first()
        if not import_session:
            return Response({"detail": "Import session not found"}, status=status.HTTP_404_NOT_FOUND)
        result = ProjectTaskMaterializer(project).materialize_import(import_session)
        summary = result.summary or {}
        log_security_event(
            project=project,
            actor=user,
            event_type="import_finalized",
            payload={"import_id": str(import_session.id), **result.to_dict()},
        )
        return Response(
            {
                "import_id": str(import_session.id),
                "status": import_session.status,
                "summary": summary,
                "overview": project_overview(project),
            },
            status=status.HTTP_200_OK,
        )


class ProjectOverviewView(AuthenticatedAPIView):
    def get(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        _recover_stuck_assignments(project)
        return Response(project_overview(project), status=status.HTTP_200_OK)


class ProjectWorkflowSyncView(AuthenticatedAPIView):
    def post(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        overview = ProjectTaskMaterializer(project).sync()
        log_security_event(
            project=project,
            actor=user,
            event_type="workflow_synced",
            payload={
                "task_type": getattr(project, "task_type", ""),
                "widget_type": getattr(project, "widget_type", ""),
                "sync": overview.get("sync", {}),
                "source_sync": overview.get("source_sync", {}),
            },
        )
        return Response(overview, status=status.HTTP_200_OK)


class ProjectVideoIntervalsView(AuthenticatedAPIView):
    def get(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        asset_id = str(request.query_params.get("asset_id") or "").strip()
        status_filter = str(request.query_params.get("status") or "").strip() or None
        asset = None
        if asset_id:
            if not ObjectId.is_valid(asset_id):
                return Response({"detail": "Invalid asset id"}, status=status.HTTP_400_BAD_REQUEST)
            asset = ImportAsset.objects(id=ObjectId(asset_id), project=project).first()
            if not asset:
                return Response({"detail": "Asset not found"}, status=status.HTTP_404_NOT_FOUND)
        intervals = list_video_intervals(project, asset=asset, status=status_filter)
        payload = [
            {
                "id": str(interval.id),
                "asset_id": str(interval.asset.id),
                "status": interval.status,
                "source": interval.source,
                "confidence": float(interval.confidence or 0.0),
                "start_frame": int(interval.start_frame),
                "end_frame": int(interval.end_frame),
                "start_sec": float(interval.start_sec or 0.0),
                "end_sec": float(interval.end_sec or 0.0),
                "metadata": interval.metadata or {},
                "validated_at": interval.validated_at,
            }
            for interval in intervals
        ]
        return Response({"items": payload}, status=status.HTTP_200_OK)

    def post(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        asset_id = str(request.data.get("asset_id") or "").strip()
        if not ObjectId.is_valid(asset_id):
            return Response({"detail": "Invalid asset id"}, status=status.HTTP_400_BAD_REQUEST)
        asset = ImportAsset.objects(id=ObjectId(asset_id), project=project).first()
        if not asset or asset.asset_type != ImportAsset.TYPE_VIDEO:
            return Response({"detail": "Video asset not found"}, status=status.HTTP_404_NOT_FOUND)
        intervals_payload = request.data.get("intervals") or []
        if not isinstance(intervals_payload, list):
            return Response({"detail": "intervals must be a list"}, status=status.HTTP_400_BAD_REQUEST)
        validated_items = []
        for item in intervals_payload:
            serializer = VideoIntervalUpsertSerializer(data=item)
            serializer.is_valid(raise_exception=True)
            validated_items.append(serializer.validated_data)
        result = upsert_video_intervals(project, asset, user, validated_items)
        return Response(result, status=status.HTTP_200_OK)


class ProjectVideoIntervalsAutoDraftView(AuthenticatedAPIView):
    def post(self, request, project_id: str, asset_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if not ObjectId.is_valid(asset_id):
            return Response({"detail": "Invalid asset id"}, status=status.HTTP_400_BAD_REQUEST)
        asset = ImportAsset.objects(id=ObjectId(asset_id), project=project).first()
        if not asset or asset.asset_type != ImportAsset.TYPE_VIDEO:
            return Response({"detail": "Video asset not found"}, status=status.HTTP_404_NOT_FOUND)
        result = generate_auto_intervals_for_asset(asset, created_by=user)
        return Response(result, status=status.HTTP_200_OK)


class ProjectVideoIntervalsValidateView(AuthenticatedAPIView):
    def post(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role not in (User.ROLE_REVIEWER, User.ROLE_ADMIN, User.ROLE_CUSTOMER):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        serializer = VideoIntervalValidationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = validate_video_intervals(
            project,
            actor=user,
            interval_ids=serializer.validated_data["interval_ids"],
            decision=serializer.validated_data["decision"],
            comment=serializer.validated_data.get("comment", ""),
        )
        return Response(result, status=status.HTTP_200_OK)


class AnnotatorIntervalChunkQueueView(AuthenticatedAPIView):
    def get(self, request):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if user.role not in (User.ROLE_ANNOTATOR, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        items = annotator_interval_chunk_queue(user) if user.role == User.ROLE_ANNOTATOR else annotator_interval_chunk_queue(user)
        if user.role == User.ROLE_ANNOTATOR:
            filtered_items = []
            for item in items:
                project_id = str(item.get("project_id") or "")
                project = Project.objects(id=ObjectId(project_id)).first() if ObjectId.is_valid(project_id) else None
                if project and self.project_id_is_not_paused(project_id) and not self.access_gate_response(project, user):
                    filtered_items.append(item)
            items = filtered_items
        return Response({"items": items}, status=status.HTTP_200_OK)


class AnnotatorIntervalChunkSubmitView(AuthenticatedAPIView):
    def post(self, request, assignment_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if not ObjectId.is_valid(assignment_id):
            return Response({"detail": "Invalid assignment id"}, status=status.HTTP_400_BAD_REQUEST)
        assignment = VideoChunkAssignment.objects(id=ObjectId(assignment_id)).first()
        if not assignment:
            return Response({"detail": "Assignment not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role != User.ROLE_ADMIN and str(assignment.annotator.id) != str(user.id):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        gate = self.access_gate_response(assignment.project, user)
        if gate:
            return gate
        serializer = VideoChunkSubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = submit_interval_chunk_assignment(
            assignment,
            intervals=serializer.validated_data["intervals"],
            comment=serializer.validated_data.get("comment", ""),
        )
        settings = workflow_runtime_settings(assignment.project)
        ensure_interval_validation_assignments(assignment.project, min_validators=settings["interval_validators_per_item"])
        return Response(result, status=status.HTTP_200_OK)


class IntervalValidationQueueView(AuthenticatedAPIView):
    def get(self, request):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if user.role not in (User.ROLE_ANNOTATOR, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if user.role == User.ROLE_ADMIN:
            projects = list(Project.objects)
        else:
            projects = [
                membership.project
                for membership in ProjectMembership.objects(user=user, is_active=True)
                if membership.project.status != Project.STATUS_PAUSED and not self.access_gate_response(membership.project, user)
            ]
        for project in projects:
            settings = workflow_runtime_settings(project)
            ensure_interval_validation_assignments(project, min_validators=settings["interval_validators_per_item"])
        items = validator_interval_queue(user)
        if user.role == User.ROLE_ANNOTATOR:
            items = [item for item in items if self.project_id_is_not_paused(str(item.get("project_id") or ""))]
        return Response({"items": items}, status=status.HTTP_200_OK)


class IntervalValidationSubmitView(AuthenticatedAPIView):
    def post(self, request, assignment_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if not ObjectId.is_valid(assignment_id):
            return Response({"detail": "Invalid assignment id"}, status=status.HTTP_400_BAD_REQUEST)
        assignment = IntervalValidationAssignment.objects(id=ObjectId(assignment_id)).first()
        if not assignment:
            return Response({"detail": "Assignment not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role != User.ROLE_ADMIN and str(assignment.validator.id) != str(user.id):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if user.role == User.ROLE_ANNOTATOR and assignment.project.status == Project.STATUS_PAUSED:
            return self.project_paused_response()
        gate = self.access_gate_response(assignment.project, user)
        if gate:
            return gate
        serializer = IntervalValidationDecisionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        settings = workflow_runtime_settings(assignment.project)
        try:
            result = submit_interval_validation(
                assignment,
                decision=serializer.validated_data["decision"],
                comment=serializer.validated_data.get("comment", ""),
                min_validators=settings["interval_validators_per_item"],
            )
        except PermissionError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        return Response(result, status=status.HTTP_200_OK)


class BBoxValidationQueueView(AuthenticatedAPIView):
    def get(self, request):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if user.role not in (User.ROLE_ANNOTATOR, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if user.role == User.ROLE_ADMIN:
            projects = list(Project.objects)
        else:
            member_projects = [membership.project for membership in ProjectMembership.objects(user=user, is_active=True)]
            owner_projects = list(Project.objects(owner=user))
            projects = list({str(item.id): item for item in [*member_projects, *owner_projects]}.values())
            projects = [project for project in projects if project.status != Project.STATUS_PAUSED]
            projects = [project for project in projects if not self.access_gate_response(project, user)]
        for project in projects:
            settings = workflow_runtime_settings(project)
            ensure_bbox_validation_assignments(
                project=project,
                min_validators=settings["bbox_validators_per_batch"],
                real_items_per_batch=settings["bbox_real_items_per_batch"],
                golden_items_per_batch=settings["bbox_golden_items_per_batch"],
            )
        items = bbox_validation_queue_for_annotator(user)
        if user.role == User.ROLE_ANNOTATOR:
            items = [item for item in items if self.project_id_is_not_paused(str(item.get("project_id") or ""))]
        return Response({"items": items}, status=status.HTTP_200_OK)


class BBoxValidationSubmitView(AuthenticatedAPIView):
    def post(self, request, assignment_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if not ObjectId.is_valid(assignment_id):
            return Response({"detail": "Invalid assignment id"}, status=status.HTTP_400_BAD_REQUEST)
        assignment = BBoxValidationAssignment.objects(id=ObjectId(assignment_id)).first()
        if not assignment:
            return Response({"detail": "Assignment not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role != User.ROLE_ADMIN and str(assignment.validator.id) != str(user.id):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if user.role == User.ROLE_ANNOTATOR and assignment.project.status == Project.STATUS_PAUSED:
            return self.project_paused_response()
        gate = self.access_gate_response(assignment.project, user)
        if gate:
            return gate
        serializer = BBoxValidationSubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        settings = workflow_runtime_settings(assignment.project)
        try:
            result = submit_bbox_validation_assignment(
                assignment,
                decisions=serializer.validated_data.get("decisions", {}),
                golden_decisions=serializer.validated_data.get("golden_decisions", {}),
                min_score=settings["golden_min_score"],
                min_validators=settings["bbox_validators_per_batch"],
            )
        except PermissionError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        return Response(result, status=status.HTTP_200_OK)


class ProjectExportView(AuthenticatedAPIView):
    def get(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        return export_project_dataset(project_id, user, request, entrypoint="cv_view")


class ProjectGoldenCandidatesView(AuthenticatedAPIView):
    def get(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        candidates = list_golden_candidates(project)
        payload = {
            "items": candidates,
            "active_count": sum(1 for item in candidates if item.get("status") == "active"),
            "candidate_count": sum(1 for item in candidates if item.get("status") == "candidate"),
            "retired_count": sum(1 for item in candidates if item.get("status") == "retired"),
        }
        return Response(payload, status=status.HTTP_200_OK)

    def post(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        try:
            payload = create_manual_golden_frame(
                project=project,
                frame_id=str(request.data.get("frame_id") or ""),
                actor=user,
                reference_annotation=request.data.get("reference_annotation") or {},
                probe_annotation=request.data.get("probe_annotation") or None,
                case_type=str(request.data.get("case_type") or GoldenFrame.CASE_POSITIVE),
                expected_decision=str(request.data.get("expected_decision") or ""),
                issue_type=str(request.data.get("issue_type") or ""),
                usage=str(request.data.get("usage") or GoldenFrame.USAGE_CONTROL),
                status=str(request.data.get("status") or GoldenFrame.STATUS_CANDIDATE),
                review_notes=str(request.data.get("review_notes") or ""),
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(payload, status=status.HTTP_201_CREATED)


class ProjectGoldenSourceFramesView(AuthenticatedAPIView):
    def get(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        search = str(request.query_params.get("search") or "").strip().lower()
        try:
            limit = max(1, min(int(request.query_params.get("limit", 60)), 200))
        except ValueError:
            limit = 60
        try:
            offset = max(0, int(request.query_params.get("offset", 0)))
        except ValueError:
            offset = 0
        frames_by_id = {
            str(frame.id): frame
            for frame in FrameItem.objects(project=project).order_by("asset", "frame_number")
        }
        work_items_by_frame = {}
        for work_item in WorkItem.objects(project=project).order_by("created_at"):
            frame = getattr(work_item, "frame", None)
            if not frame:
                continue
            frame_id = str(frame.id)
            frames_by_id.setdefault(frame_id, frame)
            work_items_by_frame.setdefault(frame_id, work_item)
        frames = sorted(
            frames_by_id.values(),
            key=lambda frame: (
                str(frame.asset.id) if getattr(frame, "asset", None) else "",
                int(frame.frame_number or 0),
                str(frame.id),
            ),
        )
        if search:
            frames = [
                frame for frame in frames
                if search in str(frame.frame_number).lower()
                or search in str(frame.frame_uri or "").lower()
                or search in (str(frame.asset.id).lower() if getattr(frame, "asset", None) else "")
            ]
        total = len(frames)
        frames = frames[offset:offset + limit]
        golden_by_frame = {str(item.frame.id): item for item in GoldenFrame.objects(project=project, frame__in=frames)}
        items = []
        for frame in frames:
            frame_id = str(frame.id)
            golden = golden_by_frame.get(frame_id)
            work_item = work_items_by_frame.get(frame_id)
            annotation = {}
            if work_item:
                annotation = work_item.final_annotation or work_item.pre_annotations or {}
            items.append({
                "frame_id": frame_id,
                "frame_url": frame.frame_uri,
                "frame_number": frame.frame_number,
                "timestamp_sec": float(frame.timestamp_sec or 0.0),
                "width": frame.width,
                "height": frame.height,
                "asset_id": str(frame.asset.id) if getattr(frame, "asset", None) else "",
                "golden_frame_id": str(golden.id) if golden else "",
                "golden_status": golden.status if golden else "none",
                "case_type": golden.case_type if golden else "",
                "issue_type": golden.issue_type if golden else "",
                "reference_annotation": golden.reference_annotation if golden else annotation,
                "candidate_score": float(getattr(golden, "candidate_score", 0.0) or 0.0) if golden else 0.0,
            })
        return Response({"items": items, "limit": limit, "offset": offset, "total": total}, status=status.HTTP_200_OK)


class ProjectGoldenCandidatePromoteView(AuthenticatedAPIView):
    def post(self, request, project_id: str, golden_frame_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        review_notes = str(request.data.get("review_notes") or "").strip()
        try:
            result = promote_golden_candidate(project, golden_frame_id, actor=user, review_notes=review_notes)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(result, status=status.HTTP_200_OK)


class ProjectGoldenRetireView(AuthenticatedAPIView):
    def post(self, request, project_id: str, golden_frame_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        review_notes = str(request.data.get("review_notes") or "").strip()
        try:
            result = retire_golden_frame(project, golden_frame_id, actor=user, review_notes=review_notes)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(result, status=status.HTTP_200_OK)


class AnnotatorQueueView(AuthenticatedAPIView):
    def get(self, request):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if user.role not in (User.ROLE_ANNOTATOR, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        projects = list(Project.objects) if user.role == User.ROLE_ADMIN else [
            membership.project
            for membership in ProjectMembership.objects(user=user, is_active=True)
            if membership.project.status != Project.STATUS_PAUSED
        ]
        for project in projects:
            _recover_stuck_assignments(project)
        assignments = Assignment.objects(annotator=user).order_by("status", "created_at") if user.role == User.ROLE_ANNOTATOR else Assignment.objects.order_by("status", "created_at")
        items = []
        for assignment in assignments:
            project = assignment.project
            if user.role == User.ROLE_ANNOTATOR and project.status == Project.STATUS_PAUSED:
                continue
            frame = assignment.work_item.frame
            items.append(
                {
                    "assignment_id": str(assignment.id),
                    "project_id": str(project.id),
                    "project_title": project.title,
                    "work_item_id": str(assignment.work_item.id),
                    "frame_url": frame.frame_uri,
                    "status": assignment.status,
                    "instruction": project.instructions,
                    "label_schema": project.label_schema or [],
                    "created_at": assignment.created_at,
                }
            )
        return Response({"items": items}, status=status.HTTP_200_OK)


class AnnotatorProjectsView(AuthenticatedAPIView):
    def get(self, request):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if user.role not in (User.ROLE_ANNOTATOR, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)

        stage_specs = {
            TASK_VIDEO_ANNOTATION: {
                "title": "Разметка интервалов",
                "route": lambda project_id: f"/labeling/intervals?projectId={project_id}&stage=intervals",
            },
            TASK_VIDEO_INTERVAL_VALIDATION: {
                "title": "Валидация интервалов",
                "route": lambda project_id: f"/labeling/intervals?projectId={project_id}&stage=interval-validation",
            },
            TASK_BBOX_ANNOTATION: {
                "title": "Разметка объектов",
                "route": lambda project_id: f"/labeling/projects/{project_id}",
            },
            TASK_BBOX_VALIDATION: {
                "title": "Валидация объектов",
                "route": lambda project_id: f"/labeling/bbox-validation?projectId={project_id}",
            },
            TASK_TEXT_ANNOTATION: {
                "title": "Текстовая разметка",
                "route": lambda project_id: f"/labeling/generic/{project_id}",
            },
            TASK_IMAGE_ANNOTATION: {
                "title": "Разметка изображений",
                "route": lambda project_id: f"/labeling/generic/{project_id}",
            },
            TASK_CLASSIFICATION: {
                "title": "Классификация",
                "route": lambda project_id: f"/labeling/generic/{project_id}",
            },
            TASK_COMPARISON: {
                "title": "Сравнение",
                "route": lambda project_id: f"/labeling/generic/{project_id}",
            },
        }
        stage_api_names = {
            TASK_VIDEO_ANNOTATION: "interval_annotation",
            TASK_VIDEO_INTERVAL_VALIDATION: "interval_validation",
        }

        projects: dict[str, Project] = {}

        def remember_project(project: Project) -> Project:
            projects[str(project.id)] = project
            return project

        def base_stage(project: Project, stage: str, last_activity_at=None) -> dict:
            project_id = str(project.id)
            spec = stage_specs[stage]
            api_stage = stage_api_names.get(stage, stage)
            return {
                "stage_project_id": f"{project_id}:{api_stage}",
                "parent_project_id": project_id,
                "project_id": project_id,
                "project_title": spec["title"],
                "stage": api_stage,
                "task_type": getattr(project, "task_type", "bbox_annotation") or "bbox_annotation",
                "widget_type": getattr(project, "widget_type", "bbox") or "bbox",
                "stage_title": spec["title"],
                "linked_project_title": project.title,
                "route": spec["route"](project_id),
                "project_status": project.status,
                "instructions": project.instructions,
                "instructions_file_uri": project.instructions_file_uri or "",
                "instructions_file_name": project.instructions_file_name or "",
                "label_schema": project.label_schema or [],
                "available_count": 0,
                "active_count": 0,
                "draft_count": 0,
                "submitted_count": 0,
                "accepted_count": 0,
                "rejected_count": 0,
                "completed_count": 0,
                "batch_count": 0,
                "validation_ready_count": 0,
                "total_assignments": 0,
                "interval_chunk_count": 0,
                "interval_validation_count": 0,
                "bbox_validation_count": 0,
                "next_assignment_id": None,
                "active_assignment_id": None,
                "last_activity_at": last_activity_at or project.updated_at or project.created_at,
            }

        grouped: dict[str, dict[str, dict]] = {}
        cv_pipeline_stages = [
            TASK_VIDEO_ANNOTATION,
            TASK_VIDEO_INTERVAL_VALIDATION,
            TASK_BBOX_ANNOTATION,
            TASK_BBOX_VALIDATION,
        ]

        def display_stages_for_project(project: Project) -> list[str]:
            task_type = getattr(project, "task_type", TASK_BBOX_ANNOTATION) or TASK_BBOX_ANNOTATION
            if (
                getattr(project, "project_type", "") == Project.TYPE_CV
                and getattr(project, "annotation_type", "") == Project.ANNOTATION_BBOX
                and task_type == TASK_BBOX_ANNOTATION
            ):
                return cv_pipeline_stages
            return [task_type if task_type in stage_specs else TASK_BBOX_ANNOTATION]

        def ensure_stage(project: Project, stage: str, last_activity_at=None) -> dict:
            project = remember_project(project)
            project_id = str(project.id)
            if project_id not in grouped:
                grouped[project_id] = {}
            if stage not in grouped[project_id]:
                grouped[project_id][stage] = base_stage(project, stage, last_activity_at)
            bucket = grouped[project_id][stage]
            if last_activity_at and last_activity_at > bucket["last_activity_at"]:
                bucket["last_activity_at"] = last_activity_at
            return bucket

        if user.role == User.ROLE_ANNOTATOR:
            memberships = ProjectMembership.objects(user=user, role=ProjectMembership.ROLE_ANNOTATOR, is_active=True)
            for membership in memberships:
                if membership.project.status == Project.STATUS_PAUSED:
                    continue
                for stage in display_stages_for_project(membership.project):
                    ensure_stage(membership.project, stage, membership.updated_at or membership.created_at)
        else:
            for project in Project.objects:
                for stage in display_stages_for_project(project):
                    ensure_stage(project, stage, project.updated_at or project.created_at)

        assignments = list(
            Assignment.objects(annotator=user).order_by("queue_position", "-updated_at", "-created_at")
            if user.role == User.ROLE_ANNOTATOR
            else Assignment.objects.order_by("queue_position", "-updated_at", "-created_at")
        )

        for assignment in assignments:
            project = assignment.project
            if user.role == User.ROLE_ANNOTATOR and project.status == Project.STATUS_PAUSED:
                continue
            stage = getattr(project, "task_type", TASK_BBOX_ANNOTATION) or TASK_BBOX_ANNOTATION
            bucket = ensure_stage(project, stage if stage in stage_specs else TASK_BBOX_ANNOTATION, assignment.updated_at or assignment.created_at)
            workflow_meta = assignment.work_item.workflow_meta or {}
            if workflow_meta.get("validation_ready"):
                bucket["validation_ready_count"] += 1

            bucket["total_assignments"] += 1
            if assignment.status == Assignment.STATUS_ASSIGNED:
                bucket["available_count"] += 1
                if not bucket["next_assignment_id"]:
                    bucket["next_assignment_id"] = str(assignment.id)
            elif assignment.status == Assignment.STATUS_DRAFT:
                bucket["draft_count"] += 1
                bucket["active_count"] += 1
                if not bucket["active_assignment_id"]:
                    bucket["active_assignment_id"] = str(assignment.id)
            elif assignment.status == Assignment.STATUS_IN_PROGRESS:
                bucket["active_count"] += 1
                if not bucket["active_assignment_id"]:
                    bucket["active_assignment_id"] = str(assignment.id)
            elif assignment.status == Assignment.STATUS_SUBMITTED:
                bucket["submitted_count"] += 1
            elif assignment.status == Assignment.STATUS_ACCEPTED:
                bucket["accepted_count"] += 1
            elif assignment.status == Assignment.STATUS_REJECTED:
                bucket["rejected_count"] += 1

            bucket["completed_count"] = bucket["accepted_count"] + bucket["rejected_count"]
            bucket["batch_count"] = len(
                {
                    item.work_item.workflow_meta.get("task_batch_id")
                    for item in assignments
                    if str(item.project.id) == str(project.id) and item.work_item.workflow_meta.get("task_batch_id")
                }
            )
            assignment_updated = assignment.updated_at or assignment.created_at
            if assignment_updated and assignment_updated > bucket["last_activity_at"]:
                bucket["last_activity_at"] = assignment_updated

        interval_chunk_assignments = list(
            VideoChunkAssignment.objects(annotator=user, status__in=[VideoChunkAssignment.STATUS_ASSIGNED, VideoChunkAssignment.STATUS_IN_PROGRESS]).order_by("created_at")
            if user.role == User.ROLE_ANNOTATOR
            else VideoChunkAssignment.objects(status__in=[VideoChunkAssignment.STATUS_ASSIGNED, VideoChunkAssignment.STATUS_IN_PROGRESS]).order_by("created_at")
        )
        for assignment in interval_chunk_assignments:
            if user.role == User.ROLE_ANNOTATOR and assignment.project.status == Project.STATUS_PAUSED:
                continue
            bucket = ensure_stage(assignment.project, TASK_VIDEO_ANNOTATION, assignment.updated_at or assignment.created_at)
            bucket["interval_chunk_count"] += 1
            bucket["available_count"] += 1
            bucket["total_assignments"] += 1

        interval_validation_assignments = list(
            IntervalValidationAssignment.objects(validator=user, status=IntervalValidationAssignment.STATUS_ASSIGNED).order_by("created_at")
            if user.role == User.ROLE_ANNOTATOR
            else IntervalValidationAssignment.objects(status=IntervalValidationAssignment.STATUS_ASSIGNED).order_by("created_at")
        )
        for assignment in interval_validation_assignments:
            if user.role == User.ROLE_ANNOTATOR and assignment.project.status == Project.STATUS_PAUSED:
                continue
            if not assignment.interval.created_by:
                continue
            if user.role == User.ROLE_ANNOTATOR and str(assignment.interval.created_by.id) == str(user.id):
                continue
            bucket = ensure_stage(assignment.project, TASK_VIDEO_INTERVAL_VALIDATION, assignment.updated_at or assignment.created_at)
            bucket["interval_validation_count"] += 1
            bucket["available_count"] += 1
            bucket["total_assignments"] += 1

        bbox_validation_assignments = list(
            BBoxValidationAssignment.objects(validator=user, status=BBoxValidationAssignment.STATUS_ASSIGNED).order_by("created_at")
            if user.role == User.ROLE_ANNOTATOR
            else BBoxValidationAssignment.objects(status=BBoxValidationAssignment.STATUS_ASSIGNED).order_by("created_at")
        )
        for assignment in bbox_validation_assignments:
            if user.role == User.ROLE_ANNOTATOR and assignment.project.status == Project.STATUS_PAUSED:
                continue
            bucket = ensure_stage(assignment.project, TASK_BBOX_VALIDATION, assignment.updated_at or assignment.created_at)
            bucket["bbox_validation_count"] += 1
            bucket["available_count"] += 1
            bucket["total_assignments"] += 1

        generic_stages = {TASK_TEXT_ANNOTATION, TASK_IMAGE_ANNOTATION, TASK_CLASSIFICATION, TASK_COMPARISON}
        for project in projects.values():
            stage = getattr(project, "task_type", TASK_BBOX_ANNOTATION) or TASK_BBOX_ANNOTATION
            if stage not in generic_stages:
                continue
            bucket = ensure_stage(project, stage, project.updated_at or project.created_at)
            tasks = list(Task.objects(project=project))
            if user.role == User.ROLE_ANNOTATOR:
                tasks = [task for task in tasks if task.annotator is None or str(task.annotator.id) == str(user.id)]
            bucket["available_count"] += sum(1 for task in tasks if task.status == Task.STATUS_PENDING)
            bucket["active_count"] += sum(1 for task in tasks if task.status == Task.STATUS_IN_PROGRESS)
            bucket["submitted_count"] += sum(1 for task in tasks if task.status == Task.STATUS_REVIEW)
            bucket["accepted_count"] += sum(1 for task in tasks if task.status == Task.STATUS_COMPLETED)
            bucket["rejected_count"] += sum(1 for task in tasks if task.status == Task.STATUS_REJECTED)
            bucket["completed_count"] = bucket["accepted_count"] + bucket["rejected_count"]
            bucket["total_assignments"] += len(tasks)

        available_projects = []
        active_projects = []
        completed_projects = []
        project_has_open_work: dict[str, bool] = {}
        for project_id, stages in grouped.items():
            project_has_open_work[project_id] = any(
                bucket["available_count"] > 0
                or bucket["active_count"] > 0
                or bucket["draft_count"] > 0
                for bucket in stages.values()
            )

        for project_id, stages in grouped.items():
            project = projects.get(project_id)
            for stage, bucket in stages.items():
                has_stage_history = any(
                    bucket[key] > 0
                    for key in [
                        "available_count",
                        "active_count",
                        "draft_count",
                        "submitted_count",
                        "accepted_count",
                        "rejected_count",
                        "completed_count",
                        "interval_chunk_count",
                        "interval_validation_count",
                        "bbox_validation_count",
                        "total_assignments",
                    ]
                )
                if not has_stage_history and not project_has_open_work.get(project_id, False):
                    continue
                pipeline_pending = False
                if project:
                    if stage == TASK_VIDEO_ANNOTATION:
                        pipeline_pending = VideoChunkAssignment.objects(project=project, status__in=[VideoChunkAssignment.STATUS_ASSIGNED, VideoChunkAssignment.STATUS_IN_PROGRESS]).count() > 0
                    elif stage == TASK_VIDEO_INTERVAL_VALIDATION:
                        pipeline_pending = any(interval.created_by for interval in VideoInterval.objects(project=project, status=VideoInterval.STATUS_DRAFT))
                    elif stage == TASK_BBOX_ANNOTATION:
                        pipeline_pending = Assignment.objects(project=project, status__in=[Assignment.STATUS_ASSIGNED, Assignment.STATUS_IN_PROGRESS, Assignment.STATUS_DRAFT]).count() > 0
                    elif stage in generic_stages:
                        pipeline_pending = Task.objects(project=project, status__in=[Task.STATUS_PENDING, Task.STATUS_IN_PROGRESS]).count() > 0
                    elif stage == TASK_BBOX_VALIDATION:
                        pipeline_pending = WorkItem.objects(project=project, status=WorkItem.STATUS_COMPLETED, validation_status=WorkItem.VALIDATION_PENDING).count() > 0
                if bucket["active_assignment_id"] or (pipeline_pending and bucket["available_count"] == 0):
                    active_projects.append(bucket)
                elif bucket["available_count"] > 0:
                    available_projects.append(bucket)
                else:
                    completed_projects.append(bucket)

        sort_key = lambda item: (item.get("linked_project_title", ""), item.get("stage", ""))
        active_projects.sort(key=sort_key)
        available_projects.sort(key=sort_key)
        completed_projects.sort(key=sort_key)
        return Response(
            {
                "available_projects": available_projects,
                "active_projects": active_projects,
                "completed_projects": completed_projects,
            },
            status=status.HTTP_200_OK,
        )


class AnnotatorProjectDetailView(AuthenticatedAPIView):
    def get(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role == User.ROLE_ANNOTATOR and project.status == Project.STATUS_PAUSED:
            return self.project_paused_response()
        if user.role not in (User.ROLE_ANNOTATOR, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        _recover_stuck_assignments(project)

        assignments_qs = Assignment.objects(project=project, annotator=user).order_by("queue_position", "created_at") if user.role == User.ROLE_ANNOTATOR else Assignment.objects(project=project).order_by("queue_position", "created_at")
        assignments = list(assignments_qs)
        next_assignment = next((item for item in assignments if item.status == Assignment.STATUS_ASSIGNED), None)
        active_assignment = next((item for item in assignments if item.status in [Assignment.STATUS_IN_PROGRESS, Assignment.STATUS_DRAFT]), None)
        interval_chunk_count = (
            VideoChunkAssignment.objects(project=project, annotator=user, status__in=[VideoChunkAssignment.STATUS_ASSIGNED, VideoChunkAssignment.STATUS_IN_PROGRESS]).count()
            if user.role == User.ROLE_ANNOTATOR
            else VideoChunkAssignment.objects(project=project, status__in=[VideoChunkAssignment.STATUS_ASSIGNED, VideoChunkAssignment.STATUS_IN_PROGRESS]).count()
        )
        interval_validation_count = (
            sum(
                1
                for item in IntervalValidationAssignment.objects(project=project, validator=user, status=IntervalValidationAssignment.STATUS_ASSIGNED)
                if item.interval.created_by and str(item.interval.created_by.id) != str(user.id)
            )
            if user.role == User.ROLE_ANNOTATOR
            else sum(1 for item in IntervalValidationAssignment.objects(project=project, status=IntervalValidationAssignment.STATUS_ASSIGNED) if item.interval.created_by)
        )
        bbox_validation_count = (
            BBoxValidationAssignment.objects(project=project, validator=user, status=BBoxValidationAssignment.STATUS_ASSIGNED).count()
            if user.role == User.ROLE_ANNOTATOR
            else BBoxValidationAssignment.objects(project=project, status=BBoxValidationAssignment.STATUS_ASSIGNED).count()
        )
        generic_tasks = list(Task.objects(project=project))
        if user.role == User.ROLE_ANNOTATOR:
            generic_tasks = [task for task in generic_tasks if task.annotator is None or str(task.annotator.id) == str(user.id)]
        overview = project_overview(project)

        payload = {
            "project_id": str(project.id),
            "project_title": project.title,
            "project_status": project.status,
            "task_type": getattr(project, "task_type", "bbox_annotation") or "bbox_annotation",
            "widget_type": getattr(project, "widget_type", "bbox") or "bbox",
            "source_project_id": str(project.source_project.id) if getattr(project, "source_project", None) else None,
            "source_project_title": project.source_project.title if getattr(project, "source_project", None) else "",
            "description": project.description,
            "instructions": project.instructions,
            "instructions_file_uri": project.instructions_file_uri or "",
            "instructions_file_name": project.instructions_file_name or "",
            "instructions_version": int(project.instructions_version or 0),
            "instructions_updated_at": project.instructions_updated_at,
            "instructions_bundle": instruction_bundle(project, user),
            "label_schema": project.label_schema or [],
            "frame_interval_sec": project.frame_interval_sec,
            "participant_rules": project.participant_rules or {},
            "stats": {
                "available_count": sum(1 for item in assignments if item.status == Assignment.STATUS_ASSIGNED) + sum(1 for task in generic_tasks if task.status == Task.STATUS_PENDING),
                "active_count": sum(1 for item in assignments if item.status in [Assignment.STATUS_IN_PROGRESS, Assignment.STATUS_DRAFT]) + sum(1 for task in generic_tasks if task.status == Task.STATUS_IN_PROGRESS),
                "submitted_count": sum(1 for item in assignments if item.status == Assignment.STATUS_SUBMITTED) + sum(1 for task in generic_tasks if task.status == Task.STATUS_REVIEW),
                "accepted_count": sum(1 for item in assignments if item.status == Assignment.STATUS_ACCEPTED) + sum(1 for task in generic_tasks if task.status == Task.STATUS_COMPLETED),
                "rejected_count": sum(1 for item in assignments if item.status == Assignment.STATUS_REJECTED) + sum(1 for task in generic_tasks if task.status == Task.STATUS_REJECTED),
                "completed_count": sum(1 for item in assignments if item.status in [Assignment.STATUS_ACCEPTED, Assignment.STATUS_REJECTED]) + sum(1 for task in generic_tasks if task.status in [Task.STATUS_COMPLETED, Task.STATUS_REJECTED]),
                "total_assignments": len(assignments) + len(generic_tasks),
                "batch_count": len({item.work_item.workflow_meta.get("task_batch_id") for item in assignments if item.work_item.workflow_meta.get("task_batch_id")}),
                "validation_ready_count": sum(1 for item in assignments if item.work_item.workflow_meta.get("validation_ready")),
                "validation_pending_count": sum(1 for item in WorkItem.objects(project=project) if item.validation_status == WorkItem.VALIDATION_PENDING),
                "validation_approved_count": sum(1 for item in WorkItem.objects(project=project) if item.validation_status == WorkItem.VALIDATION_APPROVED),
                "validation_needs_changes_count": sum(1 for item in WorkItem.objects(project=project) if item.validation_status == WorkItem.VALIDATION_NEEDS_CHANGES),
                "interval_chunk_count": interval_chunk_count,
                "interval_validation_count": interval_validation_count,
                "bbox_validation_count": bbox_validation_count,
                "interval_agreement": (overview.get("intervals") or {}).get("average_validation_agreement", 0.0),
                "bbox_annotation_agreement": (overview.get("work_items") or {}).get("average_agreement", 0.0),
                "bbox_validation_agreement": (overview.get("bbox_validation") or {}).get("average_agreement", 0.0),
            },
            "workflow": overview.get("work_items", {}),
            "next_assignment_id": str(next_assignment.id) if next_assignment else None,
            "active_assignment_id": str(active_assignment.id) if active_assignment else None,
        }
        return Response(payload, status=status.HTTP_200_OK)


class AnnotatorProjectInstructionAckView(AuthenticatedAPIView):
    def post(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role == User.ROLE_ANNOTATOR and project.status == Project.STATUS_PAUSED:
            return self.project_paused_response()
        if user.role not in (User.ROLE_ANNOTATOR, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        acknowledge_instructions(project, user)
        record_instruction_review_for_access(project, user)
        return Response(instruction_bundle(project, user), status=status.HTTP_200_OK)


class AnnotatorProjectNextAssignmentView(AuthenticatedAPIView):
    def get(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role == User.ROLE_ANNOTATOR and project.status == Project.STATUS_PAUSED:
            return self.project_paused_response()
        if user.role not in (User.ROLE_ANNOTATOR, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        _recover_stuck_assignments(project)
        gate = self.access_gate_response(project, user, allow_qualification=True)
        if gate:
            return gate

        assignments = list(
            Assignment.objects(project=project, annotator=user).order_by("queue_position", "created_at")
            if user.role == User.ROLE_ANNOTATOR
            else Assignment.objects(project=project).order_by("queue_position", "created_at")
        )
        active_assignment = next((item for item in assignments if item.status in [Assignment.STATUS_IN_PROGRESS, Assignment.STATUS_DRAFT]), None)
        if active_assignment:
            return Response({"assignment_id": str(active_assignment.id), "source": "active"}, status=status.HTTP_200_OK)

        golden_assignment = maybe_create_hidden_golden_assignment(project, user)
        if golden_assignment:
            return Response({"assignment_id": golden_assignment_public_id(golden_assignment), "source": "golden_annotation"}, status=status.HTTP_200_OK)
        gate = self.access_gate_response(project, user)
        if gate:
            return gate

        next_assignment = next((item for item in assignments if item.status == Assignment.STATUS_ASSIGNED), None)
        if next_assignment:
            return Response({"assignment_id": str(next_assignment.id), "source": "available"}, status=status.HTTP_200_OK)

        return Response({"detail": "No assignments available in this project"}, status=status.HTTP_404_NOT_FOUND)


class AnnotatorAssignmentDetailView(AuthenticatedAPIView):
    def get(self, request, assignment_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        golden_assignment_id = parse_golden_assignment_public_id(assignment_id)
        if golden_assignment_id:
            if not ObjectId.is_valid(golden_assignment_id):
                return Response({"detail": "Invalid assignment id"}, status=status.HTTP_400_BAD_REQUEST)
            golden_assignment = GoldenAnnotationAssignment.objects(id=ObjectId(golden_assignment_id)).first()
            if not golden_assignment:
                return Response({"detail": "Assignment not found"}, status=status.HTTP_404_NOT_FOUND)
            if user.role != User.ROLE_ADMIN and str(golden_assignment.annotator.id) != str(user.id):
                return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
            if user.role == User.ROLE_ANNOTATOR and golden_assignment.project.status == Project.STATUS_PAUSED:
                return self.project_paused_response()
            gate = self.access_gate_response(golden_assignment.project, user, allow_qualification=True)
            if gate:
                return gate
            return Response(golden_annotation_assignment_payload(golden_assignment), status=status.HTTP_200_OK)
        if not ObjectId.is_valid(assignment_id):
            return Response({"detail": "Invalid assignment id"}, status=status.HTTP_400_BAD_REQUEST)
        assignment = Assignment.objects(id=ObjectId(assignment_id)).first()
        if not assignment:
            return Response({"detail": "Assignment not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role != User.ROLE_ADMIN and str(assignment.annotator.id) != str(user.id):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if user.role == User.ROLE_ANNOTATOR and assignment.project.status == Project.STATUS_PAUSED:
            return self.project_paused_response()
        if user.role == User.ROLE_ANNOTATOR and assignment.project.status == Project.STATUS_PAUSED:
            return self.project_paused_response()
        gate = self.access_gate_response(assignment.project, user)
        if gate:
            return gate
        if assignment.status == Assignment.STATUS_ASSIGNED:
            assignment.status = Assignment.STATUS_IN_PROGRESS
            assignment.save()
        annotation = WorkAnnotation.objects(assignment=assignment).first()
        draft_payload = annotation.label_data if annotation and annotation.status == WorkAnnotation.STATUS_DRAFT else {"boxes": []}
        draft_comment = annotation.comment if annotation and annotation.status == WorkAnnotation.STATUS_DRAFT else ""
        pre_annotations = assignment.work_item.pre_annotations or {}
        preannotation_payload = {}
        if pre_annotations and pre_annotations.get("boxes"):
            preannotation_payload = pre_annotations
        return Response(
            {
                "assignment_id": str(assignment.id),
                "project_id": str(assignment.project.id),
                "project_title": assignment.project.title,
                "work_item_id": str(assignment.work_item.id),
                "frame_url": assignment.work_item.frame.frame_uri,
                "frame": {
                    "frame_number": assignment.work_item.frame.frame_number,
                    "timestamp_sec": assignment.work_item.frame.timestamp_sec,
                    "width": assignment.work_item.frame.width,
                    "height": assignment.work_item.frame.height,
                },
                "status": assignment.status,
                "queue_position": assignment.queue_position,
                "instructions": assignment.project.instructions,
                "instructions_bundle": instruction_bundle(assignment.project, user),
                "label_schema": assignment.project.label_schema or [],
                "workflow_meta": assignment.work_item.workflow_meta or {},
                "task_batch": annotator_batch_payload(assignment.project, assignment.annotator, assignment),
                "draft": draft_payload,
                "pre_annotations": preannotation_payload,
                "comment": draft_comment,
                "quality_signals": assignment.quality_signals or {},
            },
            status=status.HTTP_200_OK,
        )


class AnnotatorAssignmentSubmitView(AuthenticatedAPIView):
    def post(self, request, assignment_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        golden_assignment_id = parse_golden_assignment_public_id(assignment_id)
        if golden_assignment_id:
            if not ObjectId.is_valid(golden_assignment_id):
                return Response({"detail": "Invalid assignment id"}, status=status.HTTP_400_BAD_REQUEST)
            golden_assignment = GoldenAnnotationAssignment.objects(id=ObjectId(golden_assignment_id)).first()
            if not golden_assignment:
                return Response({"detail": "Assignment not found"}, status=status.HTTP_404_NOT_FOUND)
            if user.role != User.ROLE_ADMIN and str(golden_assignment.annotator.id) != str(user.id):
                return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
            if user.role == User.ROLE_ANNOTATOR and golden_assignment.project.status == Project.STATUS_PAUSED:
                return self.project_paused_response()
            gate = self.access_gate_response(golden_assignment.project, user, allow_qualification=True)
            if gate:
                return gate
            serializer = AssignmentSubmitSerializer(
                data=request.data,
                context={"assignment": None, "frame": golden_assignment.golden_frame.frame, "label_schema": golden_assignment.project.label_schema or []},
            )
            serializer.is_valid(raise_exception=True)
            attempt, evaluation = submit_golden_annotation_assignment(
                golden_assignment,
                serializer.validated_data["label_data"],
                serializer.validated_data.get("comment", ""),
                serializer.validated_data.get("is_final", True),
            )
            return Response(
                {
                    "annotation_id": str(attempt.id) if attempt else golden_assignment_public_id(golden_assignment),
                    "assignment_status": golden_assignment.status,
                    "annotation_status": "submitted" if attempt else "draft",
                    "evaluation": evaluation,
                },
                status=status.HTTP_200_OK,
            )
        if not ObjectId.is_valid(assignment_id):
            return Response({"detail": "Invalid assignment id"}, status=status.HTTP_400_BAD_REQUEST)
        assignment = Assignment.objects(id=ObjectId(assignment_id)).first()
        if not assignment:
            return Response({"detail": "Assignment not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role != User.ROLE_ADMIN and str(assignment.annotator.id) != str(user.id):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if user.role == User.ROLE_ANNOTATOR and assignment.project.status == Project.STATUS_PAUSED:
            return self.project_paused_response()
        gate = self.access_gate_response(assignment.project, user)
        if gate:
            return gate
        serializer = AssignmentSubmitSerializer(data=request.data, context={"assignment": assignment})
        serializer.is_valid(raise_exception=True)
        annotation, evaluation = save_assignment_annotation(
            assignment,
            serializer.validated_data["label_data"],
            serializer.validated_data.get("comment", ""),
            serializer.validated_data.get("is_final", True),
        )
        return Response(
            {
                "annotation_id": str(annotation.id),
                "assignment_status": assignment.status,
                "annotation_status": annotation.status,
                "evaluation": evaluation,
            },
            status=status.HTTP_200_OK,
        )


class ReviewerQueueView(AuthenticatedAPIView):
    def get(self, request):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if user.role not in (User.ROLE_REVIEWER, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if user.role == User.ROLE_ADMIN:
            reviews = ReviewRecord.objects(status=ReviewRecord.STATUS_PENDING).order_by("created_at")
        else:
            project_ids = list(ProjectMembership.objects(user=user, role=ProjectMembership.ROLE_REVIEWER, is_active=True).scalar("project"))
            reviews = ReviewRecord.objects(project__in=project_ids, status=ReviewRecord.STATUS_PENDING).order_by("created_at")
        items = []
        for review in reviews:
            annotations = list(WorkAnnotation.objects(work_item=review.work_item, status=WorkAnnotation.STATUS_SUBMITTED))
            items.append(
                {
                    "review_id": str(review.id),
                    "project_id": str(review.project.id),
                    "project_title": review.project.title,
                    "work_item_id": str(review.work_item.id),
                    "frame_url": review.work_item.frame.frame_uri,
                    "agreement_score": review.agreement_score,
                    "metrics": review.metrics,
                    "golden_total": review.golden_total,
                    "golden_errors": review.golden_errors,
                    "golden_score": review.golden_score,
                    "annotations": [
                        {
                            "annotation_id": str(annotation.id),
                            "annotator_id": str(annotation.annotator.id),
                            "annotator_username": annotation.annotator.username,
                            "label_data": annotation.label_data,
                            "comment": annotation.comment,
                        }
                        for annotation in annotations
                    ],
                }
            )
        return Response({"items": items}, status=status.HTTP_200_OK)


class ReviewDetailView(AuthenticatedAPIView):
    def get(self, request, review_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if not ObjectId.is_valid(review_id):
            return Response({"detail": "Invalid review id"}, status=status.HTTP_400_BAD_REQUEST)
        review = ReviewRecord.objects(id=ObjectId(review_id)).first()
        if not review:
            return Response({"detail": "Review not found"}, status=status.HTTP_404_NOT_FOUND)
        project = review.project
        if user.role != User.ROLE_ADMIN:
            membership = ProjectMembership.objects(project=project, user=user, role=ProjectMembership.ROLE_REVIEWER, is_active=True).first()
            if user.role != User.ROLE_REVIEWER or not membership:
                return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        annotations = list(WorkAnnotation.objects(work_item=review.work_item))
        return Response(
            {
                "review_id": str(review.id),
                "project_id": str(project.id),
                "project_title": project.title,
                "frame_url": review.work_item.frame.frame_uri,
                "agreement_score": review.agreement_score,
                "metrics": review.metrics,
                "golden_total": review.golden_total,
                "golden_errors": review.golden_errors,
                "golden_score": review.golden_score,
                "resolution": review.resolution,
                "status": review.status,
                "annotations": [
                    {
                        "annotation_id": str(annotation.id),
                        "annotator_id": str(annotation.annotator.id),
                        "annotator_username": annotation.annotator.username,
                        "label_data": annotation.label_data,
                        "comment": annotation.comment,
                        "status": annotation.status,
                    }
                    for annotation in annotations
                ],
            },
            status=status.HTTP_200_OK,
        )


class ReviewResolveView(AuthenticatedAPIView):
    def post(self, request, review_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if user.role not in (User.ROLE_REVIEWER, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        if not ObjectId.is_valid(review_id):
            return Response({"detail": "Invalid review id"}, status=status.HTTP_400_BAD_REQUEST)
        review = ReviewRecord.objects(id=ObjectId(review_id)).first()
        if not review:
            return Response({"detail": "Review not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role == User.ROLE_REVIEWER:
            membership = ProjectMembership.objects(project=review.project, user=user, role=ProjectMembership.ROLE_REVIEWER, is_active=True).first()
            if not membership:
                return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        serializer = ReviewResolveSerializer(data=request.data, context={"review": review})
        serializer.is_valid(raise_exception=True)
        result = resolve_review(review, user, serializer.validated_data["resolution"])
        return Response(result, status=status.HTTP_200_OK)


class ValidationQueueView(AuthenticatedAPIView):
    def get(self, request):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        if user.role not in (User.ROLE_CUSTOMER, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        projects = list(Project.objects(owner=user)) if user.role == User.ROLE_CUSTOMER else list(Project.objects)
        return Response({"items": validation_queue(projects)}, status=status.HTTP_200_OK)


class ValidationBatchDetailView(AuthenticatedAPIView):
    def get(self, request, project_id: str, task_batch_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True if user.role == User.ROLE_CUSTOMER else False)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role not in (User.ROLE_CUSTOMER, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        return Response(validation_batch_detail(project, task_batch_id), status=status.HTTP_200_OK)


class ValidationBatchResolveView(AuthenticatedAPIView):
    def post(self, request, project_id: str, task_batch_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id, require_owner=True if user.role == User.ROLE_CUSTOMER else False)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        if user.role not in (User.ROLE_CUSTOMER, User.ROLE_ADMIN):
            return Response({"detail": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        serializer = ValidationBatchResolveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = resolve_validation_batch(
            project,
            task_batch_id,
            actor=user,
            items=serializer.validated_data["items"],
            batch_comment=serializer.validated_data.get("batch_comment", ""),
        )
        return Response(result, status=status.HTTP_200_OK)


class SecurityEventsView(AuthenticatedAPIView):
    def get(self, request, project_id: str):
        try:
            user = self.get_user(request)
        except PermissionError:
            return Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        project = self.get_project_for_user(user, project_id)
        if not project:
            return Response({"detail": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        events = SecurityEvent.objects(project=project).order_by("-created_at").limit(200)
        payload = [
            {
                "id": str(event.id),
                "event_type": event.event_type,
                "severity": event.severity,
                "created_at": event.created_at,
                "payload": event.payload,
                "actor_id": str(event.actor.id) if event.actor else None,
            }
            for event in events
        ]
        return Response({"items": payload}, status=status.HTTP_200_OK)
