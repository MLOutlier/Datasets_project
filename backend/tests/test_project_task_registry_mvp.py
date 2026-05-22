import pytest

from apps.cv_annotation.models import FrameItem, ImportAsset, ImportSession, WorkItem
from apps.projects.models import Project, Task
from apps.projects.services.materializer import ProjectTaskMaterializer
from apps.projects.task_registry import TASK_TYPE_SPECS


@pytest.mark.django_db
class TestProjectTaskRegistryMvp:
    def test_registry_exposes_materialization_contract(self, client, auth_headers):
        response = client.get("/api/projects/task-registry/", **auth_headers)

        assert response.status_code == 200
        task_types = {item["value"]: item for item in response.data["task_types"]}
        assert set(TASK_TYPE_SPECS.keys()).issubset(task_types.keys())
        for spec in task_types.values():
            assert spec["default_widget"] in spec["widgets"]
            assert spec["data_source"]
            assert spec["materializer"]
            assert spec["quality_strategy"]
            assert isinstance(spec["readiness_gates"], list)
            assert isinstance(spec["result_schema"], dict)

    def test_overview_exposes_readiness_and_next_action(self, client, auth_headers):
        response = client.post(
            "/api/projects/",
            {"title": "Classification readiness", "task_type": "classification", "label_schema": [{"name": "yes"}, {"name": "no"}]},
            **auth_headers,
            format="json",
        )
        assert response.status_code == 201

        overview = client.get(f"/api/projects/{response.data['id']}/overview/", **auth_headers)

        assert overview.status_code == 200
        assert overview.data["task_contract"]["value"] == "classification"
        assert overview.data["readiness_gates"][0]["key"] == "project_created"
        assert overview.data["next_action"]["key"] == "tasks_created"

    @pytest.mark.parametrize("task_type", list(TASK_TYPE_SPECS.keys()))
    def test_customer_can_create_every_registered_project_type(self, client, auth_headers, user_customer, task_type):
        spec = TASK_TYPE_SPECS[task_type]
        payload = {
            "title": f"{task_type} project",
            "task_type": task_type,
            "widget_type": spec.default_widget,
            "label_schema": [{"name": "object"}] if spec.ui_hints and spec.ui_hints.get("needs_labels") else [],
        }
        if spec.requires_source_project:
            source = Project(
                owner=user_customer,
                title=f"{task_type} source",
                task_type=spec.ui_hints["source_task_type"],
                widget_type=TASK_TYPE_SPECS[spec.ui_hints["source_task_type"]].default_widget,
            )
            source.save()
            payload["source_project_id"] = str(source.id)

        response = client.post("/api/projects/", payload, **auth_headers, format="json")

        assert response.status_code == 201
        assert response.data["task_type"] == task_type
        assert response.data["widget_type"] == spec.default_widget
        assert response.data["annotation_type"] == spec.annotation_type

    def test_incompatible_widget_is_rejected(self, client, auth_headers):
        response = client.post(
            "/api/projects/",
            {"title": "Bad widget", "task_type": "classification", "widget_type": "bbox", "label_schema": [{"name": "yes"}]},
            **auth_headers,
            format="json",
        )

        assert response.status_code == 400
        assert "widget_type" in response.data

    def test_validation_project_requires_source_project(self, client, auth_headers):
        response = client.post(
            "/api/projects/",
            {"title": "Validation without source", "task_type": "bbox_validation", "widget_type": "bbox_validation"},
            **auth_headers,
            format="json",
        )

        assert response.status_code == 400
        assert "source_project_id" in response.data

    def test_generic_items_materialization_is_idempotent_by_source_key(self, user_customer):
        project = Project(
            owner=user_customer,
            title="Generic classifier",
            task_type="classification",
            widget_type="classification",
            label_schema=[{"name": "yes"}, {"name": "no"}],
        )
        project.save()
        items = [
            {"title": "First", "prompt": "Choose yes/no", "metadata": {"source_key": "row-1"}},
            {"title": "Duplicate", "prompt": "Duplicate", "metadata": {"source_key": "row-1"}},
        ]

        result = ProjectTaskMaterializer(project).materialize_generic_items(items)

        assert result.created == 1
        assert result.skipped == 1
        assert Task.objects(project=project).count() == 1

    def test_bbox_source_materialization_is_idempotent(self, user_customer):
        source = Project(owner=user_customer, title="Source bbox", task_type="bbox_annotation", widget_type="bbox")
        source.save()
        target = Project(
            owner=user_customer,
            title="Target validation",
            task_type="bbox_validation",
            widget_type="bbox_validation",
            source_project=source,
        )
        target.save()
        import_session = ImportSession(project=source, created_by=user_customer, status=ImportSession.STATUS_FINALIZED)
        import_session.save()
        asset = ImportAsset(
            import_session=import_session,
            project=source,
            file_uri="/media/source.png",
            file_name="source.png",
            file_size=10,
            mime_type="image/png",
            asset_type=ImportAsset.TYPE_IMAGE,
            processing_status=ImportAsset.STATUS_PROCESSED,
        )
        asset.save()
        frame = FrameItem(project=source, asset=asset, frame_uri="/media/source.png", width=100, height=100)
        frame.save()
        WorkItem(
            project=source,
            frame=frame,
            status=WorkItem.STATUS_COMPLETED,
            final_annotation={"boxes": [{"x": 1, "y": 2, "width": 10, "height": 12, "label": "object"}]},
            validation_status=WorkItem.VALIDATION_APPROVED,
        ).save()

        first = ProjectTaskMaterializer(target).materialize_source()
        second = ProjectTaskMaterializer(target).materialize_source()

        assert first.created == 1
        assert second.created == 0
        assert WorkItem.objects(project=target).count() == 1
