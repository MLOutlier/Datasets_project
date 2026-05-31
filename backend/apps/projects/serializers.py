from __future__ import annotations

from typing import Any, Dict, List

from bson import ObjectId
from rest_framework import serializers

from ..datasets_core.models import Dataset
from ..users.models import User
from .models import Project, ProjectMembership, Task
from .services.instructions import instruction_bundle
from .task_registry import (
    TASK_BBOX_VALIDATION,
    TASK_TYPE_CHOICES,
    TASK_VIDEO_INTERVAL_VALIDATION,
    WIDGET_TYPE_CHOICES,
    annotation_type_for_task,
    default_widget_for_task,
    is_source_task_allowed,
    is_widget_allowed,
    source_task_types_for_task,
    task_requires_source_project,
)

QUALITY_PRESETS = {
    "standard": {
        "assignments_per_task": 2,
        "agreement_threshold": 0.75,
        "iou_threshold": 0.5,
        "golden_min_score": 0.8,
        "interval_validators_per_item": 2,
        "bbox_validators_per_batch": 2,
        "annotation_golden_interval": 9,
        "bbox_golden_items_per_batch": 10,
        "description": "Balanced speed, cost, and quality.",
    },
    "high_accuracy": {
        "assignments_per_task": 3,
        "agreement_threshold": 0.85,
        "iou_threshold": 0.6,
        "golden_min_score": 0.9,
        "interval_validators_per_item": 3,
        "bbox_validators_per_batch": 3,
        "annotation_golden_interval": 6,
        "bbox_golden_items_per_batch": 12,
        "description": "More independent answers and stricter control checks.",
    },
    "fast": {
        "assignments_per_task": 1,
        "agreement_threshold": 0.65,
        "iou_threshold": 0.45,
        "golden_min_score": 0.75,
        "interval_validators_per_item": 1,
        "bbox_validators_per_batch": 1,
        "annotation_golden_interval": 12,
        "bbox_golden_items_per_batch": 6,
        "description": "Lower latency and cost with lighter agreement requirements.",
    },
}

VALIDATION_UPLOAD_MODE = "upload"
VALIDATION_SOURCE_MODE = "source_project"


class ProjectSerializer(serializers.Serializer):
    id = serializers.CharField(read_only=True)
    owner_id = serializers.CharField(source="owner.id", read_only=True)

    title = serializers.CharField(max_length=255)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    status = serializers.ChoiceField(choices=[c[0] for c in Project.STATUS_CHOICES], default=Project.STATUS_ACTIVE)

    project_type = serializers.ChoiceField(choices=[c[0] for c in Project.TYPE_CHOICES], default=Project.TYPE_CV)
    annotation_type = serializers.ChoiceField(choices=[c[0] for c in Project.ANNOTATION_CHOICES], default=Project.ANNOTATION_BBOX)
    task_type = serializers.ChoiceField(choices=[c[0] for c in TASK_TYPE_CHOICES], default=Project._fields["task_type"].default)
    widget_type = serializers.ChoiceField(choices=[c[0] for c in WIDGET_TYPE_CHOICES], required=False)
    source_project_id = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    source_config = serializers.DictField(required=False, default=dict)
    instructions = serializers.CharField(required=False, allow_blank=True, default="")
    instructions_file_uri = serializers.CharField(read_only=True)
    instructions_file_name = serializers.CharField(read_only=True)
    instructions_version = serializers.IntegerField(read_only=True)
    instructions_updated_at = serializers.DateTimeField(read_only=True)
    label_schema = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    participant_rules = serializers.DictField(required=False, default=dict)
    allowed_annotator_ids = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    allowed_reviewer_ids = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    frame_interval_sec = serializers.FloatField(required=False, default=1.0, min_value=0.1)
    assignments_per_task = serializers.IntegerField(required=False, default=2, min_value=1)
    agreement_threshold = serializers.FloatField(required=False, default=0.75, min_value=0.0, max_value=1.0)
    iou_threshold = serializers.FloatField(required=False, default=0.5, min_value=0.0, max_value=1.0)

    created_at = serializers.DateTimeField(read_only=True)
    updated_at = serializers.DateTimeField(read_only=True)

    def validate_label_schema(self, value: Any) -> List[Dict[str, Any]]:
        """
        label_schema хранится как список dict без строгой схемы (mongo DictField).
        Но для UX и корректной разметки нам критично:
        - непустые имена меток
        - уникальность имён (case-insensitive)
        - разумные лимиты на размер текста/количество элементов
        - обратная совместимость (поля вроде `label` вместо `name`)
        """

        if value is None:
            return []
        if not isinstance(value, list):
            raise serializers.ValidationError("label_schema must be a list")

        MAX_LABELS = 200
        MAX_NAME_LEN = 64
        MAX_DESC_LEN = 512
        MAX_RULES = 50
        MAX_EXAMPLES = 50
        MAX_LINE_LEN = 280

        if len(value) > MAX_LABELS:
            raise serializers.ValidationError(f"label_schema is too large (max {MAX_LABELS})")

        normalized: List[Dict[str, Any]] = []
        seen = set()
        seen_colors = set()

        def _clean_str(raw: Any, max_len: int) -> str:
            if raw is None:
                return ""
            if not isinstance(raw, str):
                raw = str(raw)
            raw = raw.strip()
            if len(raw) > max_len:
                raw = raw[:max_len]
            return raw

        def _clean_str_list(raw: Any, max_items: int) -> List[str]:
            if raw is None:
                return []
            if isinstance(raw, str):
                # допускаем старый/упрощенный ввод строкой: делим по строкам
                items = [line.strip() for line in raw.splitlines()]
            elif isinstance(raw, list):
                items = raw
            else:
                return []
            out: List[str] = []
            for item in items:
                s = _clean_str(item, MAX_LINE_LEN)
                if not s:
                    continue
                out.append(s)
                if len(out) >= max_items:
                    break
            return out

        for idx, item in enumerate(value):
            if not isinstance(item, dict):
                raise serializers.ValidationError(f"label_schema[{idx}] must be an object")

            raw_name = item.get("name") or item.get("label") or item.get("title")
            name = _clean_str(raw_name, MAX_NAME_LEN)
            if not name:
                raise serializers.ValidationError(f"label_schema[{idx}].name is required")

            key = name.lower()
            if key in seen:
                raise serializers.ValidationError(f"Duplicate label name: {name}")
            seen.add(key)

            description = _clean_str(item.get("description"), MAX_DESC_LEN)
            color = _clean_str(item.get("color"), 32) or None
            if color:
                color_key = color.lower()
                if color_key in seen_colors:
                    raise serializers.ValidationError(f"Duplicate label color: {color}")
                seen_colors.add(color_key)

            rules = _clean_str_list(item.get("rules"), MAX_RULES) or None

            examples_raw = item.get("examples")
            examples: Dict[str, Any] | None = None
            if isinstance(examples_raw, dict):
                good = _clean_str_list(examples_raw.get("good"), MAX_EXAMPLES)
                bad = _clean_str_list(examples_raw.get("bad"), MAX_EXAMPLES)
                if good or bad:
                    examples = {"good": good, "bad": bad}

            # attributes оставляем "как есть" если dict, иначе игнорируем
            attributes = item.get("attributes")
            if not isinstance(attributes, dict):
                attributes = None

            payload: Dict[str, Any] = {"name": name}
            if color:
                payload["color"] = color
            if description:
                payload["description"] = description
            if rules:
                payload["rules"] = rules
            if examples:
                payload["examples"] = examples
            if attributes:
                payload["attributes"] = attributes

            normalized.append(payload)

        return normalized

    def _normalize_participant_rules(self, attrs: Dict[str, Any], task_type: str) -> Dict[str, Any]:
        initial_data = getattr(self, "initial_data", {}) or {}
        explicit_rules = initial_data.get("participant_rules")
        rules = dict(attrs.get("participant_rules") or {})
        quality_level = str(rules.get("quality_level") or "standard").strip()
        if quality_level not in QUALITY_PRESETS:
            quality_level = "standard"
        rules["quality_level"] = quality_level
        preset = QUALITY_PRESETS[quality_level]

        for field in ("assignments_per_task", "agreement_threshold", "iou_threshold"):
            if field not in initial_data and attrs.get(field) in (None, ""):
                attrs[field] = preset[field]
            elif field not in initial_data and explicit_rules is not None and "quality_level" in rules:
                attrs[field] = preset[field]

        for key in (
            "golden_min_score",
            "interval_validators_per_item",
            "bbox_validators_per_batch",
            "annotation_golden_interval",
            "bbox_golden_items_per_batch",
        ):
            if key not in rules:
                rules[key] = preset[key]

        if task_type in {TASK_VIDEO_INTERVAL_VALIDATION, TASK_BBOX_VALIDATION}:
            input_mode = str(rules.get("validation_input_mode") or VALIDATION_SOURCE_MODE).strip()
            rules["validation_input_mode"] = VALIDATION_UPLOAD_MODE if input_mode in {VALIDATION_UPLOAD_MODE, "validation_upload"} else VALIDATION_SOURCE_MODE
        elif "validation_input_mode" not in rules:
            rules["validation_input_mode"] = VALIDATION_SOURCE_MODE

        rules["quality_preset_description"] = preset["description"]
        attrs["participant_rules"] = rules
        return rules

    def validate(self, attrs: Dict[str, Any]) -> Dict[str, Any]:
        request = self.context.get("request")
        user = getattr(request, "user", None)
        task_type = attrs.get("task_type") or Project._fields["task_type"].default
        widget_type = attrs.get("widget_type")
        if not widget_type or "widget_type" not in getattr(self, "initial_data", {}):
            widget_type = default_widget_for_task(task_type)
            attrs["widget_type"] = widget_type
        if not is_widget_allowed(task_type, widget_type):
            raise serializers.ValidationError({"widget_type": f"Widget '{widget_type}' is not compatible with task type '{task_type}'."})

        attrs["annotation_type"] = annotation_type_for_task(task_type)
        attrs["project_type"] = Project.TYPE_CV if attrs["annotation_type"] == Project.ANNOTATION_BBOX else Project.TYPE_STANDARD
        participant_rules = self._normalize_participant_rules(attrs, task_type)

        source_project_id = attrs.pop("source_project_id", None)
        source_project = None
        if source_project_id:
            if not ObjectId.is_valid(str(source_project_id)):
                raise serializers.ValidationError({"source_project_id": "Invalid source project id."})
            source_project = Project.objects(id=ObjectId(str(source_project_id))).first()
            if not source_project:
                raise serializers.ValidationError({"source_project_id": "Source project not found."})
            if user and user.role != User.ROLE_ADMIN and str(source_project.owner.id) != str(user.id):
                raise serializers.ValidationError({"source_project_id": "Source project is not available."})
            source_task_type = getattr(source_project, "task_type", "bbox_annotation") or "bbox_annotation"
            if not is_source_task_allowed(task_type, source_task_type):
                allowed = ", ".join(source_task_types_for_task(task_type)) or "none"
                raise serializers.ValidationError({"source_project_id": f"Source project type '{source_task_type}' is not compatible with '{task_type}'. Allowed: {allowed}."})
        validation_upload = (
            task_type in {TASK_VIDEO_INTERVAL_VALIDATION, TASK_BBOX_VALIDATION}
            and participant_rules.get("validation_input_mode") == VALIDATION_UPLOAD_MODE
        )
        if task_requires_source_project(task_type) and not source_project and not validation_upload:
            raise serializers.ValidationError({"source_project_id": "This task type requires a source project."})
        attrs["_source_project"] = source_project
        attrs["_clear_source_project"] = bool(validation_upload and not source_project_id)
        return attrs

    def _resolve_users(self, ids: List[str], role: str) -> List[User]:
        users: List[User] = []
        seen = set()
        for raw_id in ids:
            if not ObjectId.is_valid(raw_id) or raw_id in seen:
                continue
            user = User.objects(id=ObjectId(raw_id), role=role, is_active=True).first()
            if user:
                users.append(user)
                seen.add(raw_id)
        return users

    def create(self, validated_data: Dict[str, Any]) -> Project:
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user:
            raise serializers.ValidationError("Authentication required.")

        annotator_ids = validated_data.pop("allowed_annotator_ids", [])
        reviewer_ids = validated_data.pop("allowed_reviewer_ids", [])
        source_project = validated_data.pop("_source_project", None)
        validated_data.pop("_clear_source_project", None)

        annotators = self._resolve_users(annotator_ids, User.ROLE_ANNOTATOR)
        reviewers = self._resolve_users(reviewer_ids, User.ROLE_REVIEWER)

        project = Project(owner=user, allowed_annotators=annotators, allowed_reviewers=reviewers, source_project=source_project, **validated_data)
        project.save()

        self._sync_memberships(project, annotators, reviewers)
        return project

    def update(self, instance: Project, validated_data: Dict[str, Any]) -> Project:
        annotator_ids = validated_data.pop("allowed_annotator_ids", None)
        reviewer_ids = validated_data.pop("allowed_reviewer_ids", None)
        source_project = validated_data.pop("_source_project", None)
        clear_source_project = bool(validated_data.pop("_clear_source_project", False))

        for field in (
            "title",
            "description",
            "status",
            "project_type",
            "annotation_type",
            "task_type",
            "widget_type",
            "source_config",
            "instructions",
            "label_schema",
            "participant_rules",
            "frame_interval_sec",
            "assignments_per_task",
            "agreement_threshold",
            "iou_threshold",
        ):
            if field in validated_data:
                setattr(instance, field, validated_data[field])
        if clear_source_project:
            instance.source_project = None
        elif "source_project_id" in getattr(self, "initial_data", {}) or source_project is not None:
            instance.source_project = source_project

        annotators = instance.allowed_annotators
        reviewers = instance.allowed_reviewers
        if annotator_ids is not None:
            annotators = self._resolve_users(annotator_ids, User.ROLE_ANNOTATOR)
            instance.allowed_annotators = annotators
        if reviewer_ids is not None:
            reviewers = self._resolve_users(reviewer_ids, User.ROLE_REVIEWER)
            instance.allowed_reviewers = reviewers

        instance.save()
        self._sync_memberships(instance, annotators, reviewers)
        return instance

    def _sync_memberships(self, project: Project, annotators: List[User], reviewers: List[User]) -> None:
        active_pairs = set()
        for role, users in ((ProjectMembership.ROLE_ANNOTATOR, annotators), (ProjectMembership.ROLE_REVIEWER, reviewers)):
            for user in users:
                membership = ProjectMembership.objects(project=project, user=user, role=role).first()
                if not membership:
                    membership = ProjectMembership(
                        project=project,
                        user=user,
                        role=role,
                        specialization=user.specialization,
                        group_name=user.group_name,
                        groups=user.groups or ([user.group_name] if user.group_name else []),
                    )
                membership.is_active = True
                if not getattr(membership, "groups", None):
                    membership.groups = user.groups or ([user.group_name] if user.group_name else [])
                membership.save()
                active_pairs.add((str(user.id), role))

        for membership in ProjectMembership.objects(project=project):
            key = (str(membership.user.id), membership.role)
            if key not in active_pairs:
                membership.is_active = False
                membership.save()

    def to_representation(self, instance: Project) -> Dict[str, Any]:
        annotator_count = len(instance.allowed_annotators or [])
        reviewer_count = len(instance.allowed_reviewers or [])
        active_annotator_count = ProjectMembership.objects(
            project=instance,
            role=ProjectMembership.ROLE_ANNOTATOR,
            is_active=True,
        ).count()
        available_executor_count = int(active_annotator_count or annotator_count)
        recommended_min = 5
        minimum_full_cycle = 3
        workflow_warnings = []
        if annotator_count < int(instance.assignments_per_task or 1):
            workflow_warnings.append("Not enough annotators for the configured assignments_per_task.")
        if annotator_count < minimum_full_cycle:
            workflow_warnings.append("Full independent annotation and validation requires at least 3 annotators.")
        elif annotator_count < recommended_min:
            workflow_warnings.append("Quality is limited with fewer than 5 annotators.")
        return {
            "id": str(instance.id),
            "owner_id": str(instance.owner.id),
            "title": instance.title,
            "description": instance.description,
            "status": instance.status,
            "project_type": instance.project_type,
            "annotation_type": instance.annotation_type,
            "task_type": getattr(instance, "task_type", "bbox_annotation") or "bbox_annotation",
            "widget_type": getattr(instance, "widget_type", "bbox") or "bbox",
            "source_project_id": str(instance.source_project.id) if getattr(instance, "source_project", None) else None,
            "source_project_title": instance.source_project.title if getattr(instance, "source_project", None) else "",
            "source_config": getattr(instance, "source_config", {}) or {},
            "instructions": instance.instructions,
            "instructions_file_uri": getattr(instance, "instructions_file_uri", "") or "",
            "instructions_file_name": getattr(instance, "instructions_file_name", "") or "",
            "instructions_version": int(getattr(instance, "instructions_version", 0) or 0),
            "instructions_updated_at": getattr(instance, "instructions_updated_at", None),
            "instructions_bundle": instruction_bundle(instance, self.context.get("request").user if self.context.get("request") else None),
            "label_schema": instance.label_schema or [],
            "participant_rules": {
                **(instance.participant_rules or {}),
                "quality_presets": QUALITY_PRESETS,
            },
            "allowed_annotator_ids": [str(user.id) for user in instance.allowed_annotators or []],
            "allowed_reviewer_ids": [str(user.id) for user in instance.allowed_reviewers or []],
            "allowed_annotator_count": annotator_count,
            "allowed_reviewer_count": reviewer_count,
            "available_executor_count": available_executor_count,
            "frame_interval_sec": instance.frame_interval_sec,
            "assignments_per_task": instance.assignments_per_task,
            "agreement_threshold": instance.agreement_threshold,
            "iou_threshold": instance.iou_threshold,
            "workflow_readiness": {
                "annotators": annotator_count,
                "minimum_full_cycle": minimum_full_cycle,
                "recommended": recommended_min,
                "can_run_full_cycle": annotator_count >= minimum_full_cycle,
                "quality_mode": "draft" if annotator_count <= 1 else "limited" if annotator_count < minimum_full_cycle else "standard" if annotator_count < recommended_min else "recommended",
                "warnings": workflow_warnings,
            },
            "created_at": instance.created_at,
            "updated_at": instance.updated_at,
        }


class TaskSerializer(serializers.Serializer):
    id = serializers.CharField(read_only=True)
    project_id = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    dataset_id = serializers.CharField()
    annotator_id = serializers.CharField(required=False, allow_null=True, allow_blank=True)

    title = serializers.CharField(max_length=500, required=False, default="Task")

    status = serializers.ChoiceField(choices=[c[0] for c in Task.STATUS_CHOICES], default=Task.STATUS_PENDING)
    difficulty_score = serializers.FloatField(required=False, default=0.5, min_value=0)
    deadline_at = serializers.DateTimeField(required=False, allow_null=True)
    input_ref = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    metadata = serializers.DictField(required=False, default=dict)

    created_at = serializers.DateTimeField(read_only=True)
    updated_at = serializers.DateTimeField(read_only=True)

    def validate(self, attrs: Dict[str, Any]) -> Dict[str, Any]:
        dataset_id = attrs.get("dataset_id")
        project_id = attrs.get("project_id")
        annotator_id = attrs.get("annotator_id")

        dataset = Dataset.objects(id=dataset_id).first()
        if not dataset:
            raise serializers.ValidationError("Dataset not found.")

        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user:
            raise serializers.ValidationError("Authentication required.")
        if str(dataset.owner.id) != str(user.id):
            raise serializers.ValidationError("You are not dataset owner.")

        project = None
        if project_id:
            project = Project.objects(id=project_id, owner=user).first()
            if not project:
                raise serializers.ValidationError("Project not found or unavailable.")

        annotator = None
        if annotator_id:
            annotator = User.objects(id=annotator_id, role=User.ROLE_ANNOTATOR).first()
            if not annotator:
                raise serializers.ValidationError("annotator_id is invalid.")

        attrs["_dataset"] = dataset
        attrs["_project"] = project
        attrs["_annotator"] = annotator
        return attrs

    def create(self, validated_data: Dict[str, Any]) -> Task:
        dataset: Dataset = validated_data.pop("_dataset")
        project = validated_data.pop("_project")
        annotator = validated_data.pop("_annotator")
        status = validated_data.get("status") or Task.STATUS_PENDING
        if annotator and status == Task.STATUS_PENDING:
            status = Task.STATUS_IN_PROGRESS
        if not annotator:
            status = Task.STATUS_PENDING
        task = Task(
            project=project,
            dataset=dataset,
            annotator=annotator,
            title=validated_data.get("title", "Task"),
            status=status,
            difficulty_score=validated_data.get("difficulty_score", 0.5),
            deadline_at=validated_data.get("deadline_at"),
            input_ref=validated_data.get("input_ref"),
            metadata=validated_data.get("metadata") or {},
        )
        task.save()
        return task

    def update(self, instance: Task, validated_data: Dict[str, Any]) -> Task:
        for field in ("status", "difficulty_score", "deadline_at", "input_ref", "metadata"):
            if field in validated_data:
                setattr(instance, field, validated_data[field])
        if "annotator_id" in validated_data:
            annotator_id = validated_data.get("annotator_id")
            instance.annotator = User.objects(id=annotator_id).first() if annotator_id else None
        if "project_id" in validated_data:
            project_id = validated_data.get("project_id")
            instance.project = Project.objects(id=project_id).first() if project_id else None
        instance.save()
        return instance

    def to_representation(self, instance: Task) -> Dict[str, Any]:
        return {
            "id": str(instance.id),
            "task_id": str(instance.id),
            "project_id": str(instance.project.id) if instance.project else None,
            "dataset_id": str(instance.dataset.id),
            "annotator_id": str(instance.annotator.id) if instance.annotator else None,
            "title": instance.title,
            "status": instance.status,
            "difficulty_score": instance.difficulty_score,
            "deadline_at": instance.deadline_at,
            "input_ref": instance.input_ref,
            "metadata": getattr(instance, "metadata", {}) or {},
            "frame_url": instance.input_ref,
            "created_at": instance.created_at,
            "updated_at": instance.updated_at,
        }
