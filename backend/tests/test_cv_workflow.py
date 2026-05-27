import io
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
    ReviewRecord,
    WorkAnnotation,
    WorkItem,
)
from apps.cv_annotation.services.workflow import (
    _build_golden_validation_question,
    compare_bbox_annotations,
    maybe_create_hidden_golden_assignment,
    submit_bbox_validation_assignment,
    submit_golden_annotation_assignment,
)
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


@pytest.mark.django_db
class TestGoldenDatasetWorkflow:
    def test_validation_probe_generation_sets_expected_decisions_and_breaks_geometry(self, user_customer):
        project = make_cv_project(user_customer)
        frame = make_cv_frame(project, user_customer)
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

    def test_import_returns_bad_request_when_upload_storage_is_not_writable(self, client, auth_headers, monkeypatch):
        project_resp = client.post(
            "/api/projects/",
            {
                "title": "Readonly media project",
                "project_type": "cv",
                "annotation_type": "bbox",
                "instructions": "Upload should fail cleanly",
                "label_schema": [{"name": "drone"}],
                "assignments_per_task": 1,
            },
            **auth_headers,
            format="json",
        )
        project_id = project_resp.data["id"]

        def fail_save(*_args, **_kwargs):
            raise OSError("permission denied")

        monkeypatch.setattr("apps.cv_annotation.views.save_project_file", fail_save)

        upload_resp = client.post(
            f"/api/projects/{project_id}/imports/",
            {"file": make_test_image("readonly.png")},
            **auth_headers,
        )

        assert upload_resp.status_code == 400
        assert upload_resp.data["detail"] == "Upload storage is not writable. Check MEDIA_ROOT permissions."

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
