import io
from pathlib import Path

import pytest
from PIL import Image

from apps.cv_annotation.models import (
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
    VideoInterval,
    WorkAnnotation,
    WorkItem,
)
from apps.cv_annotation.services.workflow import (
    _build_golden_validation_question,
    compare_bbox_annotations,
    ensure_interval_validation_assignments,
    materialize_bbox_annotation_interval_source,
    materialize_interval_validation_source,
    maybe_create_hidden_golden_assignment,
    submit_bbox_validation_assignment,
    submit_golden_annotation_assignment,
    validator_interval_queue,
)
from apps.projects.task_registry import (
    TASK_BBOX_ANNOTATION,
    TASK_VIDEO_ANNOTATION,
    TASK_VIDEO_INTERVAL_VALIDATION,
    WIDGET_BBOX,
    WIDGET_INTERVAL_VALIDATION,
    WIDGET_VIDEO_INTERVALS,
    source_task_types_for_task,
)
from apps.users.models import User
from apps.projects.models import Project, ProjectMembership
from apps.users.serializers import create_access_token


def make_test_image(name: str = "frame.png"):
    image = Image.new("RGB", (128, 96), color=(255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    buffer.name = name
    return buffer


def make_cv_project(owner, annotators=None, reviewers=None, participant_rules=None):
    project = Project(
        owner=owner,
        title="Golden project",
        project_type=Project.TYPE_CV,
        annotation_type=Project.ANNOTATION_BBOX,
        instructions="Draw every object",
        label_schema=[{"name": "drone"}, {"name": "car"}],
        allowed_annotators=annotators or [],
        allowed_reviewers=reviewers or [],
        assignments_per_task=1,
        agreement_threshold=0.75,
        iou_threshold=0.5,
        participant_rules=participant_rules or {},
    )
    project.save()
    return project


def make_cv_frame(project, owner, frame_number=1):
    import_session = ImportSession(project=project, created_by=owner, status=ImportSession.STATUS_FINALIZED)
    import_session.save()
    asset = ImportAsset(
        import_session=import_session,
        project=project,
        file_uri=f"/media/test-{frame_number}.png",
        file_name=f"test-{frame_number}.png",
        file_size=128,
        mime_type="image/png",
        asset_type=ImportAsset.TYPE_IMAGE,
        processing_status=ImportAsset.STATUS_PROCESSED,
    )
    asset.save()
    frame = FrameItem(
        project=project,
        asset=asset,
        frame_uri=asset.file_uri,
        frame_number=frame_number,
        width=128,
        height=96,
    )
    frame.save()
    return frame


def make_video_interval_source(owner, author, validator):
    source_project = Project(
        owner=owner,
        title="Interval annotation source",
        project_type=Project.TYPE_CV,
        annotation_type=Project.ANNOTATION_BBOX,
        task_type=TASK_VIDEO_ANNOTATION,
        widget_type=WIDGET_VIDEO_INTERVALS,
        allowed_annotators=[author, validator],
        assignments_per_task=1,
        participant_rules={"assignment_scope": "selected_only"},
    ).save()
    for user in (author, validator):
        ProjectMembership(project=source_project, user=user, role=ProjectMembership.ROLE_ANNOTATOR, is_active=True).save()
    import_session = ImportSession(project=source_project, created_by=owner, status=ImportSession.STATUS_FINALIZED).save()
    asset = ImportAsset(
        import_session=import_session,
        project=source_project,
        file_uri="/media/projects/test/source.mp4",
        file_name="source.mp4",
        file_size=128,
        mime_type="video/mp4",
        asset_type=ImportAsset.TYPE_VIDEO,
        processing_status=ImportAsset.STATUS_PROCESSED,
    ).save()
    interval = VideoInterval(
        project=source_project,
        asset=asset,
        start_frame=10,
        end_frame=20,
        start_sec=10.0,
        end_sec=20.0,
        status=VideoInterval.STATUS_DRAFT,
        source=VideoInterval.SOURCE_MANUAL,
        confidence=1.0,
        created_by=author,
    ).save()
    validation_project = Project(
        owner=owner,
        title="Interval validation",
        project_type=Project.TYPE_CV,
        annotation_type=Project.ANNOTATION_BBOX,
        task_type=TASK_VIDEO_INTERVAL_VALIDATION,
        widget_type=WIDGET_INTERVAL_VALIDATION,
        source_project=source_project,
        allowed_annotators=[author, validator],
        assignments_per_task=1,
        participant_rules={"assignment_scope": "selected_only", "interval_validators_per_item": 1},
    ).save()
    for user in (author, validator):
        ProjectMembership(project=validation_project, user=user, role=ProjectMembership.ROLE_ANNOTATOR, is_active=True).save()
    return source_project, validation_project, asset, interval


@pytest.mark.django_db
class TestIntervalValidationMedia:
    def test_interval_validation_assigns_other_annotator_only(self, user_customer, user_annotator, monkeypatch):
        validator = User(email="validator@example.com", username="validator_user", role=User.ROLE_ANNOTATOR)
        validator.set_password("test-password-for-dev-only")
        validator.save()
        _, validation_project, _, source_interval = make_video_interval_source(user_customer, user_annotator, validator)

        created = materialize_interval_validation_source(validation_project)
        assert created == 1
        copied = VideoInterval.objects(project=validation_project).first()
        assert copied is not None
        assert copied.created_by == user_annotator
        assert (copied.metadata or {}).get("source_interval_id") == str(source_interval.id)

        assigned = ensure_interval_validation_assignments(validation_project, min_validators=1)
        assert assigned == 1
        assignment = IntervalValidationAssignment.objects(project=validation_project).first()
        assert assignment is not None
        assert assignment.validator == validator
        assert assignment.validator != copied.created_by

        monkeypatch.setattr(
            "apps.cv_annotation.services.workflow._ensure_interval_review_clip",
            lambda interval, padding_sec=None: {"ready": True, "clip_uri": "/media/projects/test/review.mp4", "uri": "/media/projects/test/review.mp4"},
        )
        assert validator_interval_queue(user_annotator) == []
        assert validator_interval_queue(validator)[0]["assignment_id"] == str(assignment.id)

    def test_interval_validation_queue_prefers_review_clip(self, user_customer, user_annotator, monkeypatch):
        validator = User(email="validator2@example.com", username="validator_user2", role=User.ROLE_ANNOTATOR)
        validator.set_password("test-password-for-dev-only")
        validator.save()
        _, validation_project, _, _ = make_video_interval_source(user_customer, user_annotator, validator)
        materialize_interval_validation_source(validation_project)
        ensure_interval_validation_assignments(validation_project, min_validators=1)

        monkeypatch.setattr(
            "apps.cv_annotation.services.workflow._ensure_interval_review_clip",
            lambda interval, padding_sec=None: {"ready": True, "clip_uri": "/media/projects/test/review.mp4", "uri": "/media/projects/test/review.mp4", "start_sec": 8.0},
        )

        item = validator_interval_queue(validator)[0]
        assert item["media_uri"] == "/media/projects/test/review.mp4"
        assert item["media_kind"] == "clip"
        assert item["media_ready"] is True
        assert item["clip_ready"] is True

    def test_interval_validation_queue_falls_back_to_source_video(self, user_customer, user_annotator, monkeypatch, settings):
        validator = User(email="validator3@example.com", username="validator_user3", role=User.ROLE_ANNOTATOR)
        validator.set_password("test-password-for-dev-only")
        validator.save()
        _, validation_project, asset, _ = make_video_interval_source(user_customer, user_annotator, validator)
        source_path = Path(settings.MEDIA_ROOT) / "projects" / "test" / "source.mp4"
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_bytes(b"not-a-real-video")
        materialize_interval_validation_source(validation_project)
        ensure_interval_validation_assignments(validation_project, min_validators=1)

        monkeypatch.setattr(
            "apps.cv_annotation.services.workflow._ensure_interval_review_clip",
            lambda interval, padding_sec=None: {"ready": False, "reason": "ffmpeg_unavailable"},
        )

        item = validator_interval_queue(validator)[0]
        assert item["media_uri"] == asset.file_uri
        assert item["media_kind"] == "source"
        assert item["media_ready"] is True
        assert item["media_reason"] == "ffmpeg_unavailable"

    def test_bbox_annotation_source_is_previous_validated_interval_stage(self):
        assert source_task_types_for_task(TASK_VIDEO_INTERVAL_VALIDATION) == (TASK_VIDEO_ANNOTATION,)
        assert source_task_types_for_task(TASK_BBOX_ANNOTATION) == (TASK_VIDEO_INTERVAL_VALIDATION,)

    def test_bbox_source_materialization_merges_overlapping_validated_intervals(self, user_customer, user_annotator):
        source_project = Project(
            owner=user_customer,
            title="Video source",
            project_type=Project.TYPE_CV,
            annotation_type=Project.ANNOTATION_BBOX,
            task_type=TASK_VIDEO_ANNOTATION,
            widget_type=WIDGET_VIDEO_INTERVALS,
            allowed_annotators=[user_annotator],
        ).save()
        import_session = ImportSession(project=source_project, created_by=user_customer, status=ImportSession.STATUS_FINALIZED).save()
        asset = ImportAsset(
            import_session=import_session,
            project=source_project,
            file_uri="/media/projects/test/source.mp4",
            file_name="source.mp4",
            file_size=128,
            mime_type="video/mp4",
            asset_type=ImportAsset.TYPE_VIDEO,
            processing_status=ImportAsset.STATUS_PROCESSED,
        ).save()
        for frame_number in range(1, 31):
            FrameItem(
                project=source_project,
                asset=asset,
                frame_uri=f"/media/projects/test/frames/frame_{frame_number:06d}.jpg",
                frame_number=frame_number,
                timestamp_sec=float(frame_number),
                width=128,
                height=96,
            ).save()
        validation_project = Project(
            owner=user_customer,
            title="Validated intervals",
            project_type=Project.TYPE_CV,
            annotation_type=Project.ANNOTATION_BBOX,
            task_type=TASK_VIDEO_INTERVAL_VALIDATION,
            widget_type=WIDGET_INTERVAL_VALIDATION,
            source_project=source_project,
            allowed_annotators=[user_annotator],
        ).save()
        VideoInterval(
            project=validation_project,
            asset=asset,
            start_frame=10,
            end_frame=20,
            start_sec=10.0,
            end_sec=20.0,
            status=VideoInterval.STATUS_APPROVED,
            source=VideoInterval.SOURCE_MANUAL,
            created_by=user_annotator,
        ).save()
        VideoInterval(
            project=validation_project,
            asset=asset,
            start_frame=15,
            end_frame=25,
            start_sec=15.0,
            end_sec=25.0,
            status=VideoInterval.STATUS_APPROVED,
            source=VideoInterval.SOURCE_MANUAL,
            created_by=user_annotator,
        ).save()
        bbox_project = Project(
            owner=user_customer,
            title="BBox from validated intervals",
            project_type=Project.TYPE_CV,
            annotation_type=Project.ANNOTATION_BBOX,
            task_type=TASK_BBOX_ANNOTATION,
            widget_type=WIDGET_BBOX,
            source_project=validation_project,
            allowed_annotators=[user_annotator],
            assignments_per_task=1,
        ).save()

        created = materialize_bbox_annotation_interval_source(bbox_project)

        assert created == 16
        work_items = list(WorkItem.objects(project=bbox_project))
        assert len(work_items) == 16
        assert sorted(item.frame.frame_number for item in work_items) == list(range(10, 26))
        assert len({(item.workflow_meta or {}).get("source_frame_id") for item in work_items}) == 16
        assert materialize_bbox_annotation_interval_source(bbox_project) == 0


@pytest.mark.django_db
class TestGoldenDatasetWorkflow:
    def test_validation_probe_generation_sets_expected_decisions_and_breaks_geometry(self, user_customer):
        project = make_cv_project(user_customer)
        frame = make_cv_frame(project, user_customer)
        frame_negative = make_cv_frame(project, user_customer, frame_number=2)
        reference = {"boxes": [{"x": 10, "y": 10, "width": 24, "height": 18, "label": "drone"}]}
        golden = GoldenFrame(
            project=project,
            frame=frame,
            reference_annotation=reference,
            status=GoldenFrame.STATUS_ACTIVE,
        ).save()

        seen = {}
        for index in range(250):
            question = _build_golden_validation_question(golden, seed=f"seed-{index}")
            seen.setdefault(question["issue_type"], question)
            if {"correct", "missing_box", "bad_geometry", "wrong_label", "extra_box"}.issubset(seen.keys()):
                break

        assert seen["correct"]["expected_decision"] == "approve"
        assert seen["correct"]["probe_annotation"] == reference
        for issue_type in ["missing_box", "bad_geometry", "wrong_label", "extra_box"]:
            assert seen[issue_type]["expected_decision"] == "needs_changes"

        geometry_score = compare_bbox_annotations(
            reference,
            seen["bad_geometry"]["probe_annotation"],
            project.iou_threshold,
        )
        assert geometry_score["tp"] == 0
        assert geometry_score["average_iou"] < project.iou_threshold

    def test_validation_golden_score_uses_stored_expected_decision(self, user_customer, user_annotator):
        project = make_cv_project(user_customer, annotators=[user_annotator])
        frame = make_cv_frame(project, user_customer)
        reference = {"boxes": [{"x": 10, "y": 10, "width": 24, "height": 18, "label": "drone"}]}
        golden = GoldenFrame(
            project=project,
            frame=frame,
            reference_annotation=reference,
            status=GoldenFrame.STATUS_ACTIVE,
        ).save()
        assignment = BBoxValidationAssignment(
            project=project,
            validator=user_annotator,
            work_item_ids=[],
            golden_frame_ids=[str(golden.id)],
            golden_questions=[
                {
                    "golden_id": str(golden.id),
                    "probe_annotation": reference,
                    "expected_decision": "needs_changes",
                    "issue_type": "stored_probe_expectation",
                }
            ],
        ).save()

        result = submit_bbox_validation_assignment(
            assignment,
            decisions={},
            golden_decisions={str(golden.id): "approve"},
            min_score=0.8,
            min_validators=1,
        )

        assert result["status"] == "rejected_by_golden"
        assert result["golden_score"] == 0.0
        attempt = GoldenAttempt.objects.get(golden_frame=golden, user=user_annotator, stage=GoldenAttempt.STAGE_VALIDATION)
        assert attempt.passed is False
        assert attempt.issue_type == "stored_probe_expectation"
        golden.reload()
        assert golden.validation_seen == 1
        assert golden.validation_failed == 1

    def test_hidden_annotation_golden_creates_attempt_without_work_annotation(self, user_customer, user_annotator):
        project = make_cv_project(
            user_customer,
            annotators=[user_annotator],
            participant_rules={"annotation_golden_interval": 1},
        )
        frame = make_cv_frame(project, user_customer)
        reference = {"boxes": [{"x": 12, "y": 14, "width": 25, "height": 16, "label": "drone"}]}
        source_item = WorkItem(
            project=project,
            frame=frame,
            status=WorkItem.STATUS_COMPLETED,
            final_annotation=reference,
            validation_status=WorkItem.VALIDATION_APPROVED,
        ).save()
        golden = GoldenFrame(
            project=project,
            frame=frame,
            reference_annotation=reference,
            source_work_item=source_item,
            status=GoldenFrame.STATUS_ACTIVE,
        ).save()
        ordinary_assignment = Assignment(
            project=project,
            work_item=source_item,
            annotator=user_annotator,
            status=Assignment.STATUS_SUBMITTED,
        ).save()

        hidden_assignment = maybe_create_hidden_golden_assignment(project, user_annotator)
        assert hidden_assignment is not None
        assert hidden_assignment.golden_frame == golden

        attempt, evaluation = submit_golden_annotation_assignment(
            hidden_assignment,
            reference,
            comment="",
            is_final=True,
        )

        assert attempt is not None
        assert attempt.passed is True
        assert evaluation["state"] == "golden_checked"
        assert WorkAnnotation.objects(assignment=ordinary_assignment).count() == 0
        assert WorkAnnotation.objects.count() == 0
        assert GoldenAnnotationAssignment.objects(id=hidden_assignment.id).first().status == GoldenAnnotationAssignment.STATUS_SUBMITTED
        golden.reload()
        assert golden.annotation_seen == 1
        assert golden.annotation_passed == 1

    def test_customer_can_promote_and_retire_golden_frame(self, client, auth_headers, user_customer):
        project = make_cv_project(user_customer)
        frame = make_cv_frame(project, user_customer)
        golden = GoldenFrame(
            project=project,
            frame=frame,
            reference_annotation={"boxes": [{"x": 10, "y": 10, "width": 20, "height": 20, "label": "drone"}]},
            status=GoldenFrame.STATUS_CANDIDATE,
        ).save()

        list_response = client.get(f"/api/projects/{project.id}/golden-candidates/", **auth_headers)
        assert list_response.status_code == 200
        assert list_response.data["candidate_count"] == 1
        assert list_response.data["active_count"] == 0

        promote_response = client.post(
            f"/api/projects/{project.id}/golden-candidates/{golden.id}/promote/",
            {"review_notes": "good control frame"},
            **auth_headers,
            format="json",
        )
        assert promote_response.status_code == 200
        assert promote_response.data["status"] == GoldenFrame.STATUS_ACTIVE

        retire_response = client.post(
            f"/api/projects/{project.id}/golden-candidates/{golden.id}/retire/",
            {"review_notes": "outdated"},
            **auth_headers,
            format="json",
        )
        assert retire_response.status_code == 200
        assert retire_response.data["status"] == GoldenFrame.STATUS_RETIRED

    def test_customer_can_create_manual_positive_and_negative_golden_cases(self, client, auth_headers, user_customer):
        project = make_cv_project(user_customer)
        frame = make_cv_frame(project, user_customer)
        reference = {"boxes": [{"x": 10, "y": 10, "width": 20, "height": 20, "label": "drone"}]}
        negative_probe = {"boxes": [{"x": 80, "y": 80, "width": 20, "height": 20, "label": "drone"}]}

        positive_response = client.post(
            f"/api/projects/{project.id}/golden-candidates/",
            {
                "frame_id": str(frame_negative.id),
                "case_type": "positive",
                "status": "active",
                "reference_annotation": reference,
            },
            **auth_headers,
            format="json",
        )
        assert positive_response.status_code == 201
        assert positive_response.data["case_type"] == "positive"
        assert positive_response.data["expected_decision"] == "approve"
        assert positive_response.data["status"] == GoldenFrame.STATUS_ACTIVE

        negative_response = client.post(
            f"/api/projects/{project.id}/golden-candidates/",
            {
                "frame_id": str(frame.id),
                "case_type": "negative",
                "status": "candidate",
                "reference_annotation": reference,
                "probe_annotation": negative_probe,
                "issue_type": "bad_geometry",
            },
            **auth_headers,
            format="json",
        )
        assert negative_response.status_code == 201
        assert negative_response.data["case_type"] == "negative"
        assert negative_response.data["expected_decision"] == "needs_changes"
        assert negative_response.data["issue_type"] == "bad_geometry"

    def test_negative_golden_is_not_used_as_annotation_hidden_task(self, user_customer, user_annotator):
        project = make_cv_project(
            user_customer,
            annotators=[user_annotator],
            participant_rules={"annotation_golden_interval": 1},
        )
        frame = make_cv_frame(project, user_customer)
        reference = {"boxes": [{"x": 12, "y": 14, "width": 25, "height": 16, "label": "drone"}]}
        source_item = WorkItem(
            project=project,
            frame=frame,
            status=WorkItem.STATUS_COMPLETED,
            final_annotation=reference,
            validation_status=WorkItem.VALIDATION_APPROVED,
        ).save()
        GoldenFrame(
            project=project,
            frame=frame,
            reference_annotation=reference,
            probe_annotation={"boxes": []},
            source_work_item=source_item,
            case_type=GoldenFrame.CASE_NEGATIVE,
            status=GoldenFrame.STATUS_ACTIVE,
        ).save()
        Assignment(
            project=project,
            work_item=source_item,
            annotator=user_annotator,
            status=Assignment.STATUS_SUBMITTED,
        ).save()

        assert maybe_create_hidden_golden_assignment(project, user_annotator) is None


@pytest.mark.django_db
class TestUnifiedCvWorkflow:
    def test_customer_can_create_cv_project(self, client, auth_headers, user_annotator, user_reviewer):
        payload = {
            "title": "Drone project",
            "description": "BBox drone dataset",
            "project_type": "cv",
            "annotation_type": "bbox",
            "instructions": "Annotate every drone",
            "label_schema": [{"name": "drone"}],
            "allowed_annotator_ids": [str(user_annotator.id)],
            "allowed_reviewer_ids": [str(user_reviewer.id)],
            "frame_interval_sec": 1.0,
            "assignments_per_task": 2,
            "agreement_threshold": 0.75,
            "iou_threshold": 0.5,
        }
        response = client.post("/api/projects/", payload, **auth_headers, format="json")
        assert response.status_code == 201
        assert response.data["project_type"] == "cv"
        assert response.data["allowed_reviewer_ids"] == [str(user_reviewer.id)]

    def test_image_import_finalize_and_queue(self, client, auth_headers, auth_headers_annotator, auth_headers_reviewer, user_customer, user_annotator, user_reviewer):
        second_annotator = user_annotator
        payload = {
            "title": "Drone project",
            "description": "BBox drone dataset",
            "project_type": "cv",
            "annotation_type": "bbox",
            "instructions": "Annotate every drone",
            "label_schema": [{"name": "drone"}],
            "allowed_annotator_ids": [str(user_annotator.id)],
            "allowed_reviewer_ids": [str(user_reviewer.id)],
            "assignments_per_task": 1,
        }
        project_resp = client.post("/api/projects/", payload, **auth_headers, format="json")
        project_id = project_resp.data["id"]

        upload = make_test_image()
        response = client.post(
            f"/api/projects/{project_id}/imports/",
            {"file": upload},
            **auth_headers,
        )
        assert response.status_code == 201
        import_id = response.data["import_id"]
        assert response.data["preview"]["frames_total"] == 1

        finalize = client.post(f"/api/projects/{project_id}/imports/{import_id}/finalize/", {}, **auth_headers, format="json")
        assert finalize.status_code == 200
        assert finalize.data["overview"]["work_items"]["total"] == 1

        queue = client.get("/api/annotator/queue/", **auth_headers_annotator)
        assert queue.status_code == 200
        assert len(queue.data["items"]) == 1
        assert queue.data["items"][0]["project_id"] == project_id

    def test_conflict_is_requeued_without_reviewer(self, client, auth_headers, user_annotator, user_reviewer):
        from apps.users.models import User

        second_annotator = User(email="annotator2@example.com", username="annotator_two", role=User.ROLE_ANNOTATOR)
        second_annotator.set_password("password123")
        second_annotator.save()
        third_annotator = User(email="annotator4@example.com", username="annotator_four", role=User.ROLE_ANNOTATOR)
        third_annotator.set_password("password123")
        third_annotator.save()

        project_resp = client.post(
            "/api/projects/",
            {
                "title": "Conflict project",
                "project_type": "cv",
                "annotation_type": "bbox",
                "instructions": "Find drones",
                "label_schema": [{"name": "drone"}],
                "allowed_annotator_ids": [str(user_annotator.id), str(second_annotator.id), str(third_annotator.id)],
                "allowed_reviewer_ids": [str(user_reviewer.id)],
                "assignments_per_task": 2,
                "agreement_threshold": 0.9,
                "iou_threshold": 0.5,
            },
            **auth_headers,
            format="json",
        )
        project_id = project_resp.data["id"]

        upload = make_test_image("conflict.png")
        upload_resp = client.post(f"/api/projects/{project_id}/imports/", {"file": upload}, **auth_headers)
        import_id = upload_resp.data["import_id"]
        client.post(f"/api/projects/{project_id}/imports/{import_id}/finalize/", {}, **auth_headers, format="json")

        assignments = list(Assignment.objects(project=Project.objects.get(id=project_id)).order_by("order_index"))
        assert len(assignments) == 2

        token_one = client.get(f"/api/annotator/assignments/{assignments[0].id}/", HTTP_AUTHORIZATION=f"Bearer {create_access_token(user_annotator)}")
        assert token_one.status_code == 200

        submit_one = client.post(
            f"/api/annotator/assignments/{assignments[0].id}/submit/",
            {"label_data": {"boxes": [{"x": 10, "y": 10, "width": 20, "height": 20, "label": "drone"}]}, "is_final": True},
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(user_annotator)}",
            format="json",
        )
        assert submit_one.status_code == 200

        submit_two = client.post(
            f"/api/annotator/assignments/{assignments[1].id}/submit/",
            {"label_data": {"boxes": [{"x": 70, "y": 50, "width": 18, "height": 18, "label": "drone"}]}, "is_final": True},
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(second_annotator)}",
            format="json",
        )
        assert submit_two.status_code == 200
        assert submit_two.data["evaluation"]["state"] == "requeued"

        work_item = WorkItem.objects.get(project=Project.objects.get(id=project_id))
        work_item.reload()
        assert work_item.status == WorkItem.STATUS_PENDING
        assert work_item.review_required is False
        assert work_item.review_status == "requeued_low_agreement"

        assignments = list(Assignment.objects(work_item=work_item))
        assert len(assignments) == 3
        assert Assignment.objects(work_item=work_item, status=Assignment.STATUS_ASSIGNED).count() >= 1
        assert WorkAnnotation.objects(work_item=work_item, status=WorkAnnotation.STATUS_SUBMITTED).count() == 2

    def test_conflict_without_fresh_annotator_is_marked_insufficient(self, client, auth_headers, user_annotator, user_reviewer):
        from apps.users.models import User

        second_annotator = User(email="annotator-only-second@example.com", username="annotator_only_second", role=User.ROLE_ANNOTATOR)
        second_annotator.set_password("password123")
        second_annotator.save()

        project_resp = client.post(
            "/api/projects/",
            {
                "title": "Conflict with no spare annotator",
                "project_type": "cv",
                "annotation_type": "bbox",
                "instructions": "Find drones",
                "label_schema": [{"name": "drone"}],
                "allowed_annotator_ids": [str(user_annotator.id), str(second_annotator.id)],
                "allowed_reviewer_ids": [str(user_reviewer.id)],
                "assignments_per_task": 2,
                "agreement_threshold": 0.9,
                "iou_threshold": 0.5,
            },
            **auth_headers,
            format="json",
        )
        project_id = project_resp.data["id"]

        upload = make_test_image("conflict-no-spare.png")
        upload_resp = client.post(f"/api/projects/{project_id}/imports/", {"file": upload}, **auth_headers)
        client.post(f"/api/projects/{project_id}/imports/{upload_resp.data['import_id']}/finalize/", {}, **auth_headers, format="json")

        project = Project.objects.get(id=project_id)
        assignments = list(Assignment.objects(project=project).order_by("order_index"))

        client.post(
            f"/api/annotator/assignments/{assignments[0].id}/submit/",
            {"label_data": {"boxes": [{"x": 10, "y": 10, "width": 20, "height": 20, "label": "drone"}]}, "is_final": True},
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(user_annotator)}",
            format="json",
        )
        submit_two = client.post(
            f"/api/annotator/assignments/{assignments[1].id}/submit/",
            {"label_data": {"boxes": [{"x": 70, "y": 50, "width": 18, "height": 18, "label": "drone"}]}, "is_final": True},
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(second_annotator)}",
            format="json",
        )

        assert submit_two.status_code == 200
        assert submit_two.data["evaluation"]["state"] == "insufficient_annotators"
        work_item = WorkItem.objects.get(project=project)
        assert work_item.validation_status == WorkItem.VALIDATION_INSUFFICIENT_ANNOTATORS

    def test_finalize_only_assigns_allowed_annotators(self, client, auth_headers, user_annotator):
        from apps.users.models import User

        disallowed_annotator = User(email="annotator3@example.com", username="annotator_three", role=User.ROLE_ANNOTATOR)
        disallowed_annotator.set_password("password123")
        disallowed_annotator.save()

        project_resp = client.post(
            "/api/projects/",
            {
                "title": "Allowed annotators only",
                "project_type": "cv",
                "annotation_type": "bbox",
                "instructions": "Only allowed annotators should receive tasks",
                "label_schema": [{"name": "drone"}],
                "allowed_annotator_ids": [str(user_annotator.id)],
                "assignments_per_task": 1,
            },
            **auth_headers,
            format="json",
        )
        project_id = project_resp.data["id"]

        upload = make_test_image("allowed-only.png")
        upload_resp = client.post(f"/api/projects/{project_id}/imports/", {"file": upload}, **auth_headers)
        assert upload_resp.status_code == 201

        finalize_resp = client.post(
            f"/api/projects/{project_id}/imports/{upload_resp.data['import_id']}/finalize/",
            {},
            **auth_headers,
            format="json",
        )
        assert finalize_resp.status_code == 200

        assignments = list(Assignment.objects(project=Project.objects.get(id=project_id)))
        assert len(assignments) == 1
        assert str(assignments[0].annotator.id) == str(user_annotator.id)

    def test_annotator_can_see_projects_and_open_next_assignment(self, client, auth_headers, auth_headers_annotator, user_annotator):
        project_resp = client.post(
            "/api/projects/",
            {
                "title": "Project level annotator flow",
                "project_type": "cv",
                "annotation_type": "bbox",
                "instructions": "Read the rules before opening tasks",
                "label_schema": [{"name": "drone"}],
                "allowed_annotator_ids": [str(user_annotator.id)],
                "assignments_per_task": 1,
            },
            **auth_headers,
            format="json",
        )
        project_id = project_resp.data["id"]

        upload = make_test_image("project-flow.png")
        upload_resp = client.post(f"/api/projects/{project_id}/imports/", {"file": upload}, **auth_headers)
        assert upload_resp.status_code == 201
        client.post(f"/api/projects/{project_id}/imports/{upload_resp.data['import_id']}/finalize/", {}, **auth_headers, format="json")

        projects_resp = client.get("/api/annotator/projects/", **auth_headers_annotator)
        assert projects_resp.status_code == 200
        all_stage_cards = [
            *projects_resp.data["available_projects"],
            *projects_resp.data["active_projects"],
            *projects_resp.data["completed_projects"],
        ]
        assert len(all_stage_cards) == 4
        assert {item["stage"] for item in all_stage_cards} == {
            "interval_annotation",
            "interval_validation",
            "bbox_annotation",
            "bbox_validation",
        }
        assert all(item["project_id"] == project_id for item in all_stage_cards)
        assert any(item["stage"] == "bbox_annotation" and item["route"].startswith("/labeling/projects/") for item in all_stage_cards)

        detail_resp = client.get(f"/api/annotator/projects/{project_id}/", **auth_headers_annotator)
        assert detail_resp.status_code == 200
        assert detail_resp.data["next_assignment_id"] is not None

        next_resp = client.get(f"/api/annotator/projects/{project_id}/next-assignment/", **auth_headers_annotator)
        assert next_resp.status_code == 200
        assert next_resp.data["assignment_id"] == detail_resp.data["next_assignment_id"]

    def test_unselected_annotator_does_not_receive_project(self, client, auth_headers, auth_headers_annotator, user_annotator):
        from apps.users.models import User

        outsider = User(email="outsider@example.com", username="outsider_user", role=User.ROLE_ANNOTATOR)
        outsider.set_password("password123")
        outsider.save()

        project_resp = client.post(
            "/api/projects/",
            {
                "title": "Restricted project",
                "project_type": "cv",
                "annotation_type": "bbox",
                "instructions": "Selected annotators only",
                "label_schema": [{"name": "drone"}],
                "allowed_annotator_ids": [str(user_annotator.id)],
                "participant_rules": {"assignment_scope": "selected_only"},
                "assignments_per_task": 1,
            },
            **auth_headers,
            format="json",
        )
        project_id = project_resp.data["id"]

        upload_resp = client.post(f"/api/projects/{project_id}/imports/", {"file": make_test_image("restricted.png")}, **auth_headers)
        assert upload_resp.status_code == 201
        finalize_resp = client.post(
            f"/api/projects/{project_id}/imports/{upload_resp.data['import_id']}/finalize/",
            {},
            **auth_headers,
            format="json",
        )
        assert finalize_resp.status_code == 200

        outsider_projects = client.get(
            "/api/annotator/projects/",
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(outsider)}",
        )
        assert outsider_projects.status_code == 200
        assert outsider_projects.data["available_projects"] == []
        assert outsider_projects.data["active_projects"] == []

    def test_annotator_with_assignment_can_continue_even_without_membership(self, client, auth_headers, user_annotator):
        project_resp = client.post(
            "/api/projects/",
            {
                "title": "Assignment access without membership",
                "project_type": "cv",
                "annotation_type": "bbox",
                "instructions": "Should still open by assignment",
                "label_schema": [{"name": "drone"}],
                "allowed_annotator_ids": [str(user_annotator.id)],
                "assignments_per_task": 1,
            },
            **auth_headers,
            format="json",
        )
        project_id = project_resp.data["id"]

        upload_resp = client.post(f"/api/projects/{project_id}/imports/", {"file": make_test_image("membership-gap.png")}, **auth_headers)
        assert upload_resp.status_code == 201
        client.post(f"/api/projects/{project_id}/imports/{upload_resp.data['import_id']}/finalize/", {}, **auth_headers, format="json")

        ProjectMembership.objects(project=Project.objects.get(id=project_id), user=user_annotator).delete()

        detail_resp = client.get(
            f"/api/annotator/projects/{project_id}/",
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(user_annotator)}",
        )
        assert detail_resp.status_code == 200

        next_resp = client.get(
            f"/api/annotator/projects/{project_id}/next-assignment/",
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(user_annotator)}",
        )
        assert next_resp.status_code == 200
        assert next_resp.data["assignment_id"]

    def test_second_annotator_keeps_remaining_assignments_after_first_finishes(self, client, auth_headers, user_annotator, user_reviewer):
        from apps.users.models import User

        second_annotator = User(email="annotator-second@example.com", username="annotator_second", role=User.ROLE_ANNOTATOR)
        second_annotator.set_password("password123")
        second_annotator.save()

        project_resp = client.post(
            "/api/projects/",
            {
                "title": "25 frame sequence",
                "project_type": "cv",
                "annotation_type": "bbox",
                "instructions": "Keep remaining tasks available",
                "label_schema": [{"name": "drone"}],
                "allowed_annotator_ids": [str(user_annotator.id), str(second_annotator.id)],
                "allowed_reviewer_ids": [str(user_reviewer.id)],
                "assignments_per_task": 2,
                "agreement_threshold": 0.75,
                "iou_threshold": 0.5,
            },
            **auth_headers,
            format="json",
        )
        project_id = project_resp.data["id"]

        import_id = None
        for index in range(25):
            upload_resp = client.post(
                f"/api/projects/{project_id}/imports/",
                {"file": make_test_image(f"frame-{index}.png"), **({"import_id": import_id} if import_id else {})},
                **auth_headers,
            )
            assert upload_resp.status_code == 201
            import_id = upload_resp.data["import_id"]

        finalize_resp = client.post(f"/api/projects/{project_id}/imports/{import_id}/finalize/", {}, **auth_headers, format="json")
        assert finalize_resp.status_code == 200
        project = Project.objects.get(id=project_id)
        assert Assignment.objects(project=project, annotator=user_annotator).count() == 25
        assert Assignment.objects(project=project, annotator=second_annotator).count() == 25
        assert finalize_resp.data["summary"]["workflow_batches_total"] == 3
        assert finalize_resp.data["summary"]["workflow_settings"]["task_batch_size"] == 10
        assert finalize_resp.data["summary"]["workflow_settings"]["min_sequence_size"] == 3

        def submit_next(annotator, x_offset):
            next_resp = client.get(
                f"/api/annotator/projects/{project_id}/next-assignment/",
                HTTP_AUTHORIZATION=f"Bearer {create_access_token(annotator)}",
            )
            assert next_resp.status_code == 200
            assignment_id = next_resp.data["assignment_id"]
            detail_resp = client.get(
                f"/api/annotator/assignments/{assignment_id}/",
                HTTP_AUTHORIZATION=f"Bearer {create_access_token(annotator)}",
            )
            assert detail_resp.status_code == 200
            assert detail_resp.data["workflow_meta"]["task_batch_size"] in [10, 5]
            assert detail_resp.data["workflow_meta"]["min_sequence_size"] == 3
            submit_resp = client.post(
                f"/api/annotator/assignments/{assignment_id}/submit/",
                {"label_data": {"boxes": [{"x": 10 + x_offset, "y": 10, "width": 20, "height": 20, "label": "drone"}]}, "is_final": True},
                HTTP_AUTHORIZATION=f"Bearer {create_access_token(annotator)}",
                format="json",
            )
            assert submit_resp.status_code == 200

        for _ in range(10):
            submit_next(user_annotator, 0)
            submit_next(second_annotator, 0)

        for _ in range(15):
            submit_next(user_annotator, 0)

        next_second = client.get(
            f"/api/annotator/projects/{project_id}/next-assignment/",
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(second_annotator)}",
        )
        assert next_second.status_code == 200

        open_assignments = Assignment.objects(
            project=project,
            annotator=second_annotator,
            status__in=[Assignment.STATUS_ASSIGNED, Assignment.STATUS_IN_PROGRESS, Assignment.STATUS_DRAFT],
        ).count()
        submitted_assignments = WorkAnnotation.objects(
            annotator=second_annotator,
            work_item__project=project,
            status__in=[WorkAnnotation.STATUS_SUBMITTED, WorkAnnotation.STATUS_ACCEPTED],
        ).count()
        assert open_assignments == 15
        assert submitted_assignments == 10

    def test_completed_project_stays_visible_in_completed_bucket(self, client, auth_headers, user_annotator):
        project_resp = client.post(
            "/api/projects/",
            {
                "title": "Completed bucket project",
                "project_type": "cv",
                "annotation_type": "bbox",
                "instructions": "Should remain visible after the last task",
                "label_schema": [{"name": "drone"}],
                "allowed_annotator_ids": [str(user_annotator.id)],
                "assignments_per_task": 1,
            },
            **auth_headers,
            format="json",
        )
        project_id = project_resp.data["id"]

        upload_resp = client.post(f"/api/projects/{project_id}/imports/", {"file": make_test_image("completed-bucket.png")}, **auth_headers)
        assert upload_resp.status_code == 201
        client.post(f"/api/projects/{project_id}/imports/{upload_resp.data['import_id']}/finalize/", {}, **auth_headers, format="json")

        next_resp = client.get(
            f"/api/annotator/projects/{project_id}/next-assignment/",
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(user_annotator)}",
        )
        assert next_resp.status_code == 200

        submit_resp = client.post(
            f"/api/annotator/assignments/{next_resp.data['assignment_id']}/submit/",
            {"label_data": {"boxes": [{"x": 10, "y": 10, "width": 20, "height": 20, "label": "drone"}]}, "is_final": True},
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(user_annotator)}",
            format="json",
        )
        assert submit_resp.status_code == 200

        projects_resp = client.get(
            "/api/annotator/projects/",
            HTTP_AUTHORIZATION=f"Bearer {create_access_token(user_annotator)}",
        )
        assert projects_resp.status_code == 200
        assert projects_resp.data["available_projects"] == []
        assert projects_resp.data["active_projects"] == []
        assert len(projects_resp.data["completed_projects"]) == 1
        assert projects_resp.data["completed_projects"][0]["project_id"] == project_id
