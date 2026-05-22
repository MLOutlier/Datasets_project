from __future__ import annotations

from dataclasses import dataclass


TASK_VIDEO_ANNOTATION = "video_annotation"
TASK_VIDEO_INTERVAL_VALIDATION = "video_interval_validation"
TASK_BBOX_ANNOTATION = "bbox_annotation"
TASK_BBOX_VALIDATION = "bbox_validation"
TASK_TEXT_ANNOTATION = "text_annotation"
TASK_IMAGE_ANNOTATION = "image_annotation"
TASK_CLASSIFICATION = "classification"
TASK_COMPARISON = "comparison"

WIDGET_VIDEO_INTERVALS = "video_intervals"
WIDGET_INTERVAL_VALIDATION = "interval_validation"
WIDGET_BBOX = "bbox"
WIDGET_BBOX_VALIDATION = "bbox_validation"
WIDGET_TEXT = "text"
WIDGET_IMAGE_LABELS = "image_labels"
WIDGET_CLASSIFICATION = "classification"
WIDGET_COMPARISON = "comparison"


@dataclass(frozen=True)
class TaskTypeSpec:
    value: str
    title: str
    default_widget: str
    widgets: tuple[str, ...]
    annotation_type: str
    requires_source_project: bool = False
    uses_cv_workflow: bool = True
    description: str = ""
    input_modes: tuple[str, ...] = ()
    export_formats: tuple[str, ...] = ("json", "csv")
    executor_route: str = ""
    data_source: str = "media_upload"
    materializer: str = "media_import"
    quality_strategy: str = "consensus"
    readiness_gates: tuple[str, ...] = ()
    result_schema: dict | None = None
    ui_hints: dict | None = None

    def to_dict(self) -> dict:
        result_schema = self.result_schema or {"type": self.annotation_type}
        return {
            "value": self.value,
            "title": self.title,
            "description": self.description,
            "default_widget": self.default_widget,
            "widgets": list(self.widgets),
            "annotation_type": self.annotation_type,
            "requires_source_project": self.requires_source_project,
            "uses_cv_workflow": self.uses_cv_workflow,
            "input_modes": list(self.input_modes),
            "export_formats": list(self.export_formats),
            "executor_route": self.executor_route,
            "data_source": self.data_source,
            "materializer": self.materializer,
            "quality_strategy": self.quality_strategy,
            "readiness_gates": list(self.readiness_gates),
            "result_schema": result_schema,
            "ui_hints": self.ui_hints or {},
            "widget_config": {
                "widget_type": self.default_widget,
                "input_schema": {"mode": list(self.input_modes)},
                "output_schema": result_schema,
                "validation_rules": {
                    "requires_source_project": self.requires_source_project,
                    "allowed_widgets": list(self.widgets),
                    "quality_strategy": self.quality_strategy,
                },
                "ui_hints": self.ui_hints or {},
            },
        }


TASK_TYPE_SPECS: dict[str, TaskTypeSpec] = {
    TASK_VIDEO_ANNOTATION: TaskTypeSpec(
        value=TASK_VIDEO_ANNOTATION,
        title="Video interval annotation",
        description="Executors mark relevant intervals in uploaded videos.",
        default_widget=WIDGET_VIDEO_INTERVALS,
        widgets=(WIDGET_VIDEO_INTERVALS,),
        annotation_type="bbox",
        input_modes=("video_upload",),
        export_formats=("json", "csv"),
        executor_route="/labeling/intervals?projectId={project_id}&stage=intervals",
        data_source="media_upload",
        materializer="video_import_to_interval_chunks",
        quality_strategy="interval_consensus",
        readiness_gates=("project_created", "video_uploaded", "interval_chunks_assigned", "intervals_submitted", "export_ready"),
        result_schema={"type": "video_intervals", "fields": ["start_frame", "end_frame", "label", "confidence"]},
        ui_hints={"needs_labels": False, "media_upload": True},
    ),
    TASK_VIDEO_INTERVAL_VALIDATION: TaskTypeSpec(
        value=TASK_VIDEO_INTERVAL_VALIDATION,
        title="Video interval validation",
        description="Executors validate intervals from a video annotation source project.",
        default_widget=WIDGET_INTERVAL_VALIDATION,
        widgets=(WIDGET_INTERVAL_VALIDATION,),
        annotation_type="bbox",
        requires_source_project=True,
        input_modes=("source_project",),
        export_formats=("json", "csv"),
        executor_route="/labeling/intervals?projectId={project_id}&stage=interval-validation",
        data_source="source_project",
        materializer="source_intervals_to_validation",
        quality_strategy="majority_quorum",
        readiness_gates=("source_project_selected", "source_synced", "validators_assigned", "validation_submitted", "report_ready"),
        result_schema={"type": "interval_validation", "fields": ["decision", "comment"]},
        ui_hints={"needs_labels": False, "source_task_type": TASK_VIDEO_ANNOTATION},
    ),
    TASK_BBOX_ANNOTATION: TaskTypeSpec(
        value=TASK_BBOX_ANNOTATION,
        title="Bounding box annotation",
        description="Executors draw bounding boxes on uploaded images or frames.",
        default_widget=WIDGET_BBOX,
        widgets=(WIDGET_BBOX,),
        annotation_type="bbox",
        input_modes=("image_upload", "video_frames"),
        export_formats=("coco", "yolo", "voc", "csv", "both"),
        executor_route="/labeling/projects/{project_id}",
        data_source="media_upload",
        materializer="media_import_to_work_items",
        quality_strategy="bbox_iou_consensus_golden",
        readiness_gates=("project_created", "media_uploaded", "work_items_created", "assignments_completed", "bbox_validated", "export_ready"),
        result_schema={"type": "bbox", "fields": ["boxes"], "box_fields": ["x", "y", "width", "height", "label"]},
        ui_hints={"needs_labels": True, "media_upload": True},
    ),
    TASK_BBOX_VALIDATION: TaskTypeSpec(
        value=TASK_BBOX_VALIDATION,
        title="Bounding box validation",
        description="Executors validate final boxes from a bbox annotation source project.",
        default_widget=WIDGET_BBOX_VALIDATION,
        widgets=(WIDGET_BBOX_VALIDATION,),
        annotation_type="bbox",
        requires_source_project=True,
        input_modes=("source_project",),
        export_formats=("json", "csv"),
        executor_route="/labeling/bbox-validation?projectId={project_id}",
        data_source="source_project",
        materializer="source_bbox_to_validation_batches",
        quality_strategy="bbox_validation_golden",
        readiness_gates=("source_project_selected", "source_synced", "validation_batches_assigned", "validation_submitted", "report_ready"),
        result_schema={"type": "bbox_validation", "fields": ["decision", "comment"]},
        ui_hints={"needs_labels": True, "source_task_type": TASK_BBOX_ANNOTATION},
    ),
    TASK_TEXT_ANNOTATION: TaskTypeSpec(
        value=TASK_TEXT_ANNOTATION,
        title="Text annotation",
        description="Executors submit a free-form text answer.",
        default_widget=WIDGET_TEXT,
        widgets=(WIDGET_TEXT,),
        annotation_type="generic",
        uses_cv_workflow=False,
        input_modes=("manual_items", "csv"),
        export_formats=("json", "jsonl", "csv"),
        executor_route="/labeling/generic/{project_id}",
        data_source="manual_or_csv",
        materializer="manual_items_to_generic_tasks",
        quality_strategy="multi_annotator_review",
        readiness_gates=("project_created", "tasks_created", "answers_submitted", "review_complete", "export_ready"),
        result_schema={"type": "text", "fields": ["text"]},
        ui_hints={"needs_labels": False, "generic": True},
    ),
    TASK_IMAGE_ANNOTATION: TaskTypeSpec(
        value=TASK_IMAGE_ANNOTATION,
        title="Image labeling",
        description="Executors choose labels for uploaded images without drawing boxes.",
        default_widget=WIDGET_IMAGE_LABELS,
        widgets=(WIDGET_IMAGE_LABELS,),
        annotation_type="generic",
        uses_cv_workflow=False,
        input_modes=("image_upload",),
        export_formats=("json", "jsonl", "csv"),
        executor_route="/labeling/generic/{project_id}",
        data_source="media_upload",
        materializer="image_import_to_generic_tasks",
        quality_strategy="label_consensus",
        readiness_gates=("project_created", "images_uploaded", "tasks_created", "labels_submitted", "export_ready"),
        result_schema={"type": "image_labels", "fields": ["label", "answer"]},
        ui_hints={"needs_labels": True, "media_upload": True, "generic": True},
    ),
    TASK_CLASSIFICATION: TaskTypeSpec(
        value=TASK_CLASSIFICATION,
        title="Classification",
        description="Executors choose one class from the project label schema.",
        default_widget=WIDGET_CLASSIFICATION,
        widgets=(WIDGET_CLASSIFICATION,),
        annotation_type="generic",
        uses_cv_workflow=False,
        input_modes=("manual_items", "csv"),
        export_formats=("json", "jsonl", "csv"),
        executor_route="/labeling/generic/{project_id}",
        data_source="manual_or_csv",
        materializer="manual_items_to_generic_tasks",
        quality_strategy="classification_consensus",
        readiness_gates=("project_created", "tasks_created", "classes_submitted", "review_complete", "export_ready"),
        result_schema={"type": "classification", "fields": ["label"]},
        ui_hints={"needs_labels": True, "generic": True},
    ),
    TASK_COMPARISON: TaskTypeSpec(
        value=TASK_COMPARISON,
        title="Comparison",
        description="Executors choose between option A and option B.",
        default_widget=WIDGET_COMPARISON,
        widgets=(WIDGET_COMPARISON,),
        annotation_type="generic",
        uses_cv_workflow=False,
        input_modes=("manual_items", "csv"),
        export_formats=("json", "jsonl", "csv"),
        executor_route="/labeling/generic/{project_id}",
        data_source="manual_or_csv",
        materializer="manual_items_to_generic_tasks",
        quality_strategy="preference_consensus",
        readiness_gates=("project_created", "pairs_created", "choices_submitted", "review_complete", "export_ready"),
        result_schema={"type": "comparison", "fields": ["choice", "answer"]},
        ui_hints={"needs_labels": False, "generic": True, "comparison": True},
    ),
}

TASK_TYPE_CHOICES = tuple((key, key) for key in TASK_TYPE_SPECS)
WIDGET_TYPE_CHOICES = tuple(
    (widget, widget)
    for widget in sorted({widget for spec in TASK_TYPE_SPECS.values() for widget in spec.widgets})
)


def default_widget_for_task(task_type: str) -> str:
    return TASK_TYPE_SPECS.get(task_type, TASK_TYPE_SPECS[TASK_BBOX_ANNOTATION]).default_widget


def annotation_type_for_task(task_type: str) -> str:
    return TASK_TYPE_SPECS.get(task_type, TASK_TYPE_SPECS[TASK_BBOX_ANNOTATION]).annotation_type


def task_uses_cv_workflow(task_type: str) -> bool:
    return TASK_TYPE_SPECS.get(task_type, TASK_TYPE_SPECS[TASK_BBOX_ANNOTATION]).uses_cv_workflow


def task_requires_source_project(task_type: str) -> bool:
    return TASK_TYPE_SPECS.get(task_type, TASK_TYPE_SPECS[TASK_BBOX_ANNOTATION]).requires_source_project


def is_widget_allowed(task_type: str, widget_type: str) -> bool:
    spec = TASK_TYPE_SPECS.get(task_type)
    return bool(spec and widget_type in spec.widgets)


def task_type_registry_payload() -> dict:
    widgets = sorted({widget for spec in TASK_TYPE_SPECS.values() for widget in spec.widgets})
    return {
        "version": 1,
        "default_task_type": TASK_BBOX_ANNOTATION,
        "default_widget_type": WIDGET_BBOX,
        "task_types": [spec.to_dict() for spec in TASK_TYPE_SPECS.values()],
        "widgets": [
            {
                "value": widget,
                "title": widget.replace("_", " ").title(),
            }
            for widget in widgets
        ],
    }
