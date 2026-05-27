from __future__ import annotations

from datetime import datetime

from mongoengine import (
    BooleanField,
    CASCADE,
    DateTimeField,
    DictField,
    Document,
    FloatField,
    IntField,
    ListField,
    ReferenceField,
    StringField,
)

from ..datasets_core.models import Dataset
from ..users.models import User
from .task_registry import TASK_BBOX_ANNOTATION, TASK_TYPE_CHOICES, WIDGET_BBOX, WIDGET_TYPE_CHOICES


class Project(Document):
    STATUS_OPEN = "open"
    STATUS_ACTIVE = "active"
    STATUS_PAUSED = "paused"
    STATUS_CLOSED = "closed"

    STATUS_CHOICES = (
        (STATUS_OPEN, "open"),
        (STATUS_ACTIVE, "active"),
        (STATUS_PAUSED, "paused"),
        (STATUS_CLOSED, "closed"),
    )

    TYPE_STANDARD = "standard"
    TYPE_CV = "cv"

    TYPE_CHOICES = (
        (TYPE_STANDARD, "standard"),
        (TYPE_CV, "cv"),
    )

    ANNOTATION_GENERIC = "generic"
    ANNOTATION_BBOX = "bbox"

    ANNOTATION_CHOICES = (
        (ANNOTATION_GENERIC, "generic"),
        (ANNOTATION_BBOX, "bbox"),
    )

    owner = ReferenceField(User, required=True, reverse_delete_rule=CASCADE)
    title = StringField(required=True, max_length=255)
    description = StringField(default="", max_length=4000)
    status = StringField(required=True, choices=[c[0] for c in STATUS_CHOICES], default=STATUS_ACTIVE)

    project_type = StringField(required=True, choices=[c[0] for c in TYPE_CHOICES], default=TYPE_CV)
    annotation_type = StringField(required=True, choices=[c[0] for c in ANNOTATION_CHOICES], default=ANNOTATION_BBOX)
    task_type = StringField(required=True, choices=[c[0] for c in TASK_TYPE_CHOICES], default=TASK_BBOX_ANNOTATION)
    widget_type = StringField(required=True, choices=[c[0] for c in WIDGET_TYPE_CHOICES], default=WIDGET_BBOX)
    source_project = ReferenceField("self", null=True, reverse_delete_rule=CASCADE)
    source_config = DictField(default=dict)
    instructions = StringField(default="")
    instructions_file_uri = StringField(default="")
    instructions_file_name = StringField(default="")
    instructions_version = IntField(default=0, min_value=0)
    instructions_updated_at = DateTimeField(null=True)
    label_schema = ListField(DictField(), default=list)
    participant_rules = DictField(default=dict)

    allowed_annotators = ListField(ReferenceField(User), default=list)
    allowed_reviewers = ListField(ReferenceField(User), default=list)

    frame_interval_sec = FloatField(default=1.0, min_value=0.1)
    assignments_per_task = IntField(default=2, min_value=1)
    agreement_threshold = FloatField(default=0.75, min_value=0.0, max_value=1.0)
    iou_threshold = FloatField(default=0.5, min_value=0.0, max_value=1.0)

    created_at = DateTimeField(default=datetime.utcnow)
    updated_at = DateTimeField(default=datetime.utcnow)

    meta = {
        "collection": "projects",
        "strict": False,  # Игнорировать поля, которых нет в модели
        "indexes": [
            "owner",
            "status",
            "project_type",
            "task_type",
            "widget_type",
            ("created_at", "-created_at"),
        ],
    }

    def save(self, *args, **kwargs):
        self.updated_at = datetime.utcnow()
        return super().save(*args, **kwargs)


class ProjectMembership(Document):
    ROLE_ANNOTATOR = "annotator"
    ROLE_REVIEWER = "reviewer"

    ROLE_CHOICES = (
        (ROLE_ANNOTATOR, "annotator"),
        (ROLE_REVIEWER, "reviewer"),
    )

    project = ReferenceField(Project, required=True, reverse_delete_rule=CASCADE)
    user = ReferenceField(User, required=True, reverse_delete_rule=CASCADE)
    role = StringField(required=True, choices=[c[0] for c in ROLE_CHOICES])
    specialization = StringField(default="", max_length=255)
    group_name = StringField(default="", max_length=255)
    groups = ListField(StringField(max_length=100), default=list)
    is_active = BooleanField(default=True)
    created_at = DateTimeField(default=datetime.utcnow)
    updated_at = DateTimeField(default=datetime.utcnow)

    meta = {
        "collection": "project_memberships",
        "indexes": [
            {"fields": ["project", "user", "role"], "unique": True},
            "user",
            "role",
        ],
    }

    def save(self, *args, **kwargs):
        self.updated_at = datetime.utcnow()
        return super().save(*args, **kwargs)


class ProjectInstructionAsset(Document):
    TYPE_INSTRUCTION = "instruction"
    TYPE_LINK = "link"
    TYPE_EMBEDDED = "embedded"
    TYPE_GOOD_EXAMPLE = "good_example"
    TYPE_BAD_EXAMPLE = "bad_example"
    TYPE_ANNOTATED_EXAMPLE = "annotated_example"

    TYPE_CHOICES = (
        (TYPE_INSTRUCTION, "instruction"),
        (TYPE_LINK, "link"),
        (TYPE_EMBEDDED, "embedded"),
        (TYPE_GOOD_EXAMPLE, "good_example"),
        (TYPE_BAD_EXAMPLE, "bad_example"),
        (TYPE_ANNOTATED_EXAMPLE, "annotated_example"),
    )

    project = ReferenceField(Project, required=True, reverse_delete_rule=CASCADE)
    created_by = ReferenceField(User, null=True, reverse_delete_rule=CASCADE)
    asset_type = StringField(required=True, choices=[c[0] for c in TYPE_CHOICES], default=TYPE_INSTRUCTION)
    title = StringField(default="", max_length=255)
    body = StringField(default="", max_length=12000)
    url = StringField(default="", max_length=2048)
    file_uri = StringField(default="", max_length=2048)
    file_name = StringField(default="", max_length=512)
    mime_type = StringField(default="", max_length=255)
    file_size = IntField(default=0, min_value=0)
    label_data = DictField(default=dict)
    metadata = DictField(default=dict)
    created_at = DateTimeField(default=datetime.utcnow)
    updated_at = DateTimeField(default=datetime.utcnow)

    meta = {
        "collection": "project_instruction_assets",
        "indexes": ["project", "asset_type", "created_by", ("project", "created_at")],
    }

    def save(self, *args, **kwargs):
        self.updated_at = datetime.utcnow()
        return super().save(*args, **kwargs)


class InstructionAcknowledgement(Document):
    project = ReferenceField(Project, required=True, reverse_delete_rule=CASCADE)
    user = ReferenceField(User, required=True, reverse_delete_rule=CASCADE)
    instructions_version = IntField(default=0, min_value=0)
    acknowledged_at = DateTimeField(default=datetime.utcnow)

    meta = {
        "collection": "instruction_acknowledgements",
        "indexes": [
            "project",
            "user",
            ("project", "user", "-acknowledged_at"),
        ],
    }


class Task(Document):
    """Legacy generic task model retained for the non-CV pages."""

    STATUS_PENDING = "pending"
    STATUS_IN_PROGRESS = "in_progress"
    STATUS_REVIEW = "review"
    STATUS_COMPLETED = "completed"
    STATUS_REJECTED = "rejected"

    STATUS_CHOICES = (
        (STATUS_PENDING, "pending"),
        (STATUS_IN_PROGRESS, "in_progress"),
        (STATUS_REVIEW, "review"),
        (STATUS_COMPLETED, "completed"),
        (STATUS_REJECTED, "rejected"),
    )

    project = ReferenceField(Project, null=True, reverse_delete_rule=CASCADE)
    dataset = ReferenceField(Dataset, required=True, reverse_delete_rule=CASCADE)
    annotator = ReferenceField(User, null=True, reverse_delete_rule=CASCADE)

    title = StringField(required=True, max_length=500, default="Task")

    # Active Learning: чем выше difficulty_score, тем раньше задача будет выбрана.
    difficulty_score = FloatField(required=True, default=0.5, min_value=0)
    status = StringField(required=True, choices=[c[0] for c in STATUS_CHOICES], default=STATUS_PENDING)
    deadline_at = DateTimeField(null=True)
    input_ref = StringField(required=False, null=True, max_length=1024)
    metadata = DictField(default=dict)
    created_at = DateTimeField(default=datetime.utcnow)
    updated_at = DateTimeField(default=datetime.utcnow)

    meta = {
        "collection": "tasks",
        "strict": False,  # Игнорировать поля, которых нет в модели (для обратной совместимости)
        "indexes": [
            "status",
            ("difficulty_score", "-difficulty_score"),
            "annotator",
            ("dataset", "created_at"),
            ("deadline_at",),
        ],
    }

    def save(self, *args, **kwargs):
        self.updated_at = datetime.utcnow()
        return super().save(*args, **kwargs)
