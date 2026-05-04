from __future__ import annotations

from bson import ObjectId
from rest_framework import serializers

from apps.projects.models import Project
from apps.users.models import User
from .models import Assignment, ImportSession, ReviewRecord, VideoInterval


class ImportFinalizeSerializer(serializers.Serializer):
    import_id = serializers.CharField()

    def validate_import_id(self, value: str) -> str:
        if not ObjectId.is_valid(value):
            raise serializers.ValidationError("Invalid import_id")
        return value


class AssignmentSubmitSerializer(serializers.Serializer):
    label_data = serializers.DictField()
    comment = serializers.CharField(required=False, allow_blank=True, default="")
    is_final = serializers.BooleanField(required=False, default=True)

    def validate_label_data(self, value):
        boxes = value.get("boxes", [])
        if not isinstance(boxes, list):
            raise serializers.ValidationError("label_data.boxes must be a list")
        assignment = self.context.get("assignment")
        frame = assignment.work_item.frame if assignment else None
        label_schema = assignment.project.label_schema if assignment else []
        allowed_labels = {
            str(item.get("name") or item.get("label") or "").strip()
            for item in (label_schema or [])
            if str(item.get("name") or item.get("label") or "").strip()
        }
        for index, box in enumerate(boxes):
            if not isinstance(box, dict):
                raise serializers.ValidationError(f"label_data.boxes[{index}] must be an object")
            for key in ("x", "y", "width", "height", "label"):
                if key not in box:
                    raise serializers.ValidationError(f"Each box must include '{key}'")
            try:
                x = float(box["x"])
                y = float(box["y"])
                width = float(box["width"])
                height = float(box["height"])
            except (TypeError, ValueError):
                raise serializers.ValidationError(f"label_data.boxes[{index}] coordinates must be numeric")
            label = str(box["label"]).strip()
            if not label:
                raise serializers.ValidationError(f"label_data.boxes[{index}].label must not be empty")
            if width <= 0 or height <= 0:
                raise serializers.ValidationError(f"label_data.boxes[{index}] width/height must be greater than zero")
            if frame:
                if x < 0 or y < 0:
                    raise serializers.ValidationError(f"label_data.boxes[{index}] must be inside frame bounds")
                if x + width > frame.width or y + height > frame.height:
                    raise serializers.ValidationError(f"label_data.boxes[{index}] exceeds frame bounds")
            if allowed_labels and label not in allowed_labels:
                raise serializers.ValidationError(f"label_data.boxes[{index}] uses unknown label '{label}'")
        return value


class ReviewResolveSerializer(serializers.Serializer):
    resolution = serializers.DictField()
    comment = serializers.CharField(required=False, allow_blank=True, default="")

    def validate_resolution(self, value):
        boxes = value.get("boxes", [])
        if not isinstance(boxes, list):
            raise serializers.ValidationError("resolution.boxes must be a list")
        review = self.context.get("review")
        frame = review.work_item.frame if review else None
        label_schema = review.project.label_schema if review else []
        allowed_labels = {
            str(item.get("name") or item.get("label") or "").strip()
            for item in (label_schema or [])
            if str(item.get("name") or item.get("label") or "").strip()
        }
        for index, box in enumerate(boxes):
            if not isinstance(box, dict):
                raise serializers.ValidationError(f"resolution.boxes[{index}] must be an object")
            for key in ("x", "y", "width", "height", "label"):
                if key not in box:
                    raise serializers.ValidationError(f"Each resolution box must include '{key}'")
            try:
                x = float(box["x"])
                y = float(box["y"])
                width = float(box["width"])
                height = float(box["height"])
            except (TypeError, ValueError):
                raise serializers.ValidationError(f"resolution.boxes[{index}] coordinates must be numeric")
            label = str(box["label"]).strip()
            if not label:
                raise serializers.ValidationError(f"resolution.boxes[{index}].label must not be empty")
            if width <= 0 or height <= 0:
                raise serializers.ValidationError(f"resolution.boxes[{index}] width/height must be greater than zero")
            if frame:
                if x < 0 or y < 0 or x + width > frame.width or y + height > frame.height:
                    raise serializers.ValidationError(f"resolution.boxes[{index}] exceeds frame bounds")
            if allowed_labels and label not in allowed_labels:
                raise serializers.ValidationError(f"resolution.boxes[{index}] uses unknown label '{label}'")
        return value


class ValidationBatchResolveSerializer(serializers.Serializer):
    items = serializers.ListField(child=serializers.DictField(), allow_empty=False)
    batch_comment = serializers.CharField(required=False, allow_blank=True, default="")

    def validate_items(self, value):
        normalized = []
        for index, item in enumerate(value):
            work_item_id = str(item.get("work_item_id") or "").strip()
            decision = str(item.get("decision") or "").strip().lower()
            comment = str(item.get("comment") or "").strip()
            if not ObjectId.is_valid(work_item_id):
                raise serializers.ValidationError(f"items[{index}].work_item_id is invalid")
            if decision not in {"approve", "needs_changes"}:
                raise serializers.ValidationError(f"items[{index}].decision must be 'approve' or 'needs_changes'")
            normalized.append({"work_item_id": work_item_id, "decision": decision, "comment": comment})
        return normalized


class VideoIntervalUpsertSerializer(serializers.Serializer):
    id = serializers.CharField(required=False)
    start_frame = serializers.IntegerField(min_value=0)
    end_frame = serializers.IntegerField(min_value=0)
    source = serializers.ChoiceField(choices=[VideoInterval.SOURCE_AUTO, VideoInterval.SOURCE_MANUAL], required=False, default=VideoInterval.SOURCE_MANUAL)
    confidence = serializers.FloatField(required=False, min_value=0.0, max_value=1.0, default=0.0)
    metadata = serializers.DictField(required=False, default=dict)

    def validate(self, attrs):
        if attrs["end_frame"] < attrs["start_frame"]:
            raise serializers.ValidationError("end_frame must be greater than or equal to start_frame")
        interval_id = attrs.get("id")
        if interval_id and not ObjectId.is_valid(interval_id):
            raise serializers.ValidationError({"id": "Invalid interval id"})
        return attrs


class VideoIntervalValidationSerializer(serializers.Serializer):
    interval_ids = serializers.ListField(child=serializers.CharField(), allow_empty=False)
    decision = serializers.ChoiceField(choices=[VideoInterval.STATUS_APPROVED, VideoInterval.STATUS_REJECTED])
    comment = serializers.CharField(required=False, allow_blank=True, default="")

    def validate_interval_ids(self, value):
        normalized = []
        for interval_id in value:
            if not ObjectId.is_valid(interval_id):
                raise serializers.ValidationError(f"Invalid interval id: {interval_id}")
            normalized.append(interval_id)
        return normalized


class VideoChunkSubmitSerializer(serializers.Serializer):
    intervals = serializers.ListField(child=serializers.DictField(), allow_empty=True)
    comment = serializers.CharField(required=False, allow_blank=True, default="")

    def validate_intervals(self, value):
        normalized = []
        for index, item in enumerate(value):
            try:
                start_frame = int(item.get("start_frame"))
                end_frame = int(item.get("end_frame"))
            except Exception:
                raise serializers.ValidationError(f"intervals[{index}] must have numeric start_frame/end_frame")
            if start_frame < 0 or end_frame < 0 or end_frame < start_frame:
                raise serializers.ValidationError(f"intervals[{index}] has invalid frame boundaries")
            normalized.append(
                {
                    "start_frame": start_frame,
                    "end_frame": end_frame,
                    "confidence": float(item.get("confidence") or 0.0),
                    "label": str(item.get("label") or "object"),
                }
            )
        return normalized


class IntervalValidationDecisionSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=[VideoInterval.STATUS_APPROVED, VideoInterval.STATUS_REJECTED])
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class BBoxValidationSubmitSerializer(serializers.Serializer):
    decisions = serializers.DictField(child=serializers.CharField(), default=dict)
    golden_decisions = serializers.DictField(child=serializers.CharField(), default=dict)


class ParticipantSerializer(serializers.Serializer):
    id = serializers.CharField(read_only=True)
    username = serializers.CharField(read_only=True)
    email = serializers.EmailField(read_only=True)
    role = serializers.CharField(read_only=True)
    rating = serializers.FloatField(read_only=True)
    specialization = serializers.CharField(read_only=True)
    group_name = serializers.CharField(read_only=True)


class ProjectOverviewSerializer(serializers.Serializer):
    project_id = serializers.CharField()
    project = serializers.DictField()
    imports = serializers.DictField()
    work_items = serializers.DictField()
    assignments = serializers.DictField()
    reviews = serializers.DictField()
    annotators = serializers.ListField(child=serializers.DictField())


class QueueItemSerializer(serializers.Serializer):
    assignment_id = serializers.CharField()
    project_id = serializers.CharField()
    project_title = serializers.CharField()
    work_item_id = serializers.CharField()
    frame_url = serializers.CharField()
    status = serializers.CharField()
    instruction = serializers.CharField()
    label_schema = serializers.ListField(child=serializers.DictField())
    created_at = serializers.DateTimeField()


class ReviewQueueItemSerializer(serializers.Serializer):
    review_id = serializers.CharField()
    project_id = serializers.CharField()
    project_title = serializers.CharField()
    work_item_id = serializers.CharField()
    frame_url = serializers.CharField()
    agreement_score = serializers.FloatField()
    metrics = serializers.DictField()
    annotations = serializers.ListField(child=serializers.DictField())
