from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.projects.models import Project, ProjectMembership
from apps.projects.task_registry import (
    TASK_BBOX_ANNOTATION,
    TASK_BBOX_VALIDATION,
    TASK_VIDEO_ANNOTATION,
    TASK_VIDEO_INTERVAL_VALIDATION,
    WIDGET_BBOX,
    WIDGET_BBOX_VALIDATION,
    WIDGET_INTERVAL_VALIDATION,
    WIDGET_VIDEO_INTERVALS,
)
from apps.users.models import User


DEMO_PASSWORD = "demo123"


class Command(BaseCommand):
    help = "Create a predictable MVP+ demo workspace for the current CV workflow."

    def handle(self, *args, **options):
        customer = self._ensure_user(
            email="demo.customer@test.local",
            username="demo_customer",
            role=User.ROLE_CUSTOMER,
            rating=0.0,
        )
        annotators = [
            self._ensure_user(
                email=f"demo.annotator{i}@test.local",
                username=f"demo_annotator_{i}",
                role=User.ROLE_ANNOTATOR,
                rating=4.0 + i * 0.1,
                group_name="mvp-demo",
            )
            for i in range(1, 6)
        ]

        label_schema = [
            {"name": "person", "color": "#2563eb"},
            {"name": "vehicle", "color": "#16a34a"},
            {"name": "other", "color": "#f59e0b"},
        ]

        video_project = self._ensure_project(
            owner=customer,
            title="MVP+ Demo 1 - Video intervals",
            task_type=TASK_VIDEO_ANNOTATION,
            widget_type=WIDGET_VIDEO_INTERVALS,
            label_schema=[],
            annotators=annotators,
            instructions="Upload a video, then mark meaningful intervals with the Video.js annotator.",
            participant_rules={
                "assignment_scope": "selected_only",
                "interval_annotators_per_chunk": 1,
                "interval_validators_per_item": 1,
                "task_batch_size": 10,
                "min_sequence_size": 3,
                "stage_pools": {
                    "interval_annotation": [str(user.id) for user in annotators[:3]],
                    "interval_validation": [str(user.id) for user in annotators[3:]],
                },
            },
        )

        self._ensure_project(
            owner=customer,
            title="MVP+ Demo 2 - Interval validation",
            task_type=TASK_VIDEO_INTERVAL_VALIDATION,
            widget_type=WIDGET_INTERVAL_VALIDATION,
            label_schema=[],
            annotators=annotators,
            source_project=video_project,
            source_config={"source_project_id": str(video_project.id), "interval_statuses": ["draft"]},
            instructions="Validate intervals created in the source video project.",
            participant_rules={
                "assignment_scope": "selected_only",
                "interval_validators_per_item": 1,
                "stage_pools": {"interval_validation": [str(user.id) for user in annotators[3:]]},
            },
        )

        bbox_project = self._ensure_project(
            owner=customer,
            title="MVP+ Demo 3 - BBox annotation",
            task_type=TASK_BBOX_ANNOTATION,
            widget_type=WIDGET_BBOX,
            label_schema=label_schema,
            annotators=annotators,
            instructions="Draw bounding boxes on imported images or approved video frames.",
            participant_rules={
                "assignment_scope": "selected_only",
                "task_batch_size": 10,
                "min_sequence_size": 3,
                "bbox_validators_per_batch": 1,
                "stage_pools": {
                    "bbox_annotation": [str(user.id) for user in annotators[:3]],
                    "bbox_validation": [str(user.id) for user in annotators[3:]],
                },
            },
        )

        self._ensure_project(
            owner=customer,
            title="MVP+ Demo 4 - BBox validation",
            task_type=TASK_BBOX_VALIDATION,
            widget_type=WIDGET_BBOX_VALIDATION,
            label_schema=label_schema,
            annotators=annotators,
            source_project=bbox_project,
            source_config={"source_project_id": str(bbox_project.id)},
            instructions="Validate final boxes from the source BBox project queue.",
            participant_rules={
                "assignment_scope": "selected_only",
                "bbox_validators_per_batch": 1,
                "stage_pools": {"bbox_validation": [str(user.id) for user in annotators[3:]]},
            },
        )

        self.stdout.write(self.style.SUCCESS("MVP+ demo workspace is ready."))
        self.stdout.write("")
        self.stdout.write("Customer:")
        self.stdout.write(f"  login: demo.customer@test.local")
        self.stdout.write(f"  password: {DEMO_PASSWORD}")
        self.stdout.write("Annotators:")
        for user in annotators:
            self.stdout.write(f"  login: {user.email} | password: {DEMO_PASSWORD}")
        self.stdout.write("")
        self.stdout.write("Docker frontend: http://localhost:3001")
        self.stdout.write("Run inside backend container or local backend env:")
        self.stdout.write("  python manage.py seed_mvp_demo")

    def _ensure_user(
        self,
        *,
        email: str,
        username: str,
        role: str,
        rating: float,
        group_name: str = "",
    ) -> User:
        user = User.objects(email=email).first()
        if not user:
            user = User(
                email=email,
                username=username,
                role=role,
                is_active=True,
                rating=rating,
                group_name=group_name,
                groups=[group_name] if group_name else [],
                experience_level="demo",
            )
            user.set_password(DEMO_PASSWORD)
            user.save()
            self.stdout.write(self.style.SUCCESS(f"created user {email}"))
            return user

        changed = False
        if user.role != role:
            user.role = role
            changed = True
        if not user.is_active:
            user.is_active = True
            changed = True
        if group_name and user.group_name != group_name:
            user.group_name = group_name
            user.groups = list({*(user.groups or []), group_name})
            changed = True
        if changed:
            user.save()
        self.stdout.write(f"using user {email}")
        return user

    def _ensure_project(
        self,
        *,
        owner: User,
        title: str,
        task_type: str,
        widget_type: str,
        label_schema: list[dict],
        annotators: list[User],
        instructions: str,
        participant_rules: dict,
        source_project: Project | None = None,
        source_config: dict | None = None,
    ) -> Project:
        project = Project.objects(owner=owner, title=title).first()
        if not project:
            project = Project(owner=owner, title=title)

        project.description = "Seeded MVP+ demo project."
        project.status = Project.STATUS_ACTIVE
        project.project_type = Project.TYPE_CV
        project.annotation_type = Project.ANNOTATION_BBOX
        project.task_type = task_type
        project.widget_type = widget_type
        project.source_project = source_project
        project.source_config = source_config or {}
        project.instructions = instructions
        project.label_schema = label_schema
        project.participant_rules = participant_rules
        project.allowed_annotators = annotators
        project.allowed_reviewers = []
        project.frame_interval_sec = 1.0
        project.assignments_per_task = 1
        project.agreement_threshold = 0.75
        project.iou_threshold = 0.5
        project.save()

        for user in annotators:
            membership = ProjectMembership.objects(project=project, user=user, role=ProjectMembership.ROLE_ANNOTATOR).first()
            if not membership:
                membership = ProjectMembership(project=project, user=user, role=ProjectMembership.ROLE_ANNOTATOR)
            membership.specialization = user.specialization
            membership.group_name = user.group_name
            membership.is_active = True
            membership.save()

        self.stdout.write(self.style.SUCCESS(f"ready project {title}: {project.id}"))
        return project
