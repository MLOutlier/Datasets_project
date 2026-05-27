from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from rest_framework import serializers

from ..datasets_core.models import Dataset
from ..labeling.models import Annotation
from ..projects.models import Task
from ..users.models import User
from .models import QualityMetric, QualityReview, RatingHistory
from .services.dawid_skene import dawid_skene_em, extract_class_label
from .services.iou_matching import greedy_iou_matching
from apps.users.notification_utils import notify_task_approved, notify_task_rejected

def _safe_float(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def compute_ner_metrics(true_spans: Set[Tuple[int, int, str]], pred_spans: Set[Tuple[int, int, str]]) -> Dict[str, float]:
    """
    Precision/Recall/F1 для NER по точному совпадению span (start,end,tag).
    """
    tp = len(true_spans & pred_spans)
    fp = len(pred_spans - true_spans)
    fn = len(true_spans - pred_spans)

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0
    return {"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn}


def extract_spans_ner(label_data: Dict[str, Any]) -> Set[Tuple[int, int, str]]:
    spans = label_data.get("spans", [])
    result: Set[Tuple[int, int, str]] = set()
    if not isinstance(spans, list):
        return result
    for span in spans:
        if not isinstance(span, dict):
            continue
        start = span.get("start")
        end = span.get("end")
        tag = span.get("tag")
        if isinstance(start, int) and isinstance(end, int) and isinstance(tag, str):
            result.add((start, end, tag))
    return result


class ReviewSerializer(serializers.Serializer):
    """
    Serializer для создания проверки качества (cross-check).
    Поддерживает multi-annotator через Dawid-Skene или IoU matching.
    """

    task_id = serializers.CharField()
    annotation_ids = serializers.ListField(
        child=serializers.CharField(),
        required=False,
        default=list,
    )
    # Обратная совместимость: старые поля
    annotation_a_id = serializers.CharField(required=False, allow_null=True)
    annotation_b_id = serializers.CharField(required=False, allow_null=True)

    arbitrator = serializers.CharField(required=False, allow_null=True)
    arbitration_requested = serializers.BooleanField(required=False, default=False)
    arbitration_comment = serializers.CharField(required=False, allow_blank=True, allow_null=True)

    # Ответные поля
    review_status = serializers.CharField(read_only=True)
    metrics = serializers.DictField(read_only=True)
    final_label_data = serializers.DictField(read_only=True)
    annotator_quality = serializers.DictField(read_only=True)

    def validate(self, attrs: Dict[str, Any]) -> Dict[str, Any]:
        task_id = attrs["task_id"]
        task = Task.objects(id=task_id).first()
        if not task:
            raise serializers.ValidationError("Task не найден.")

        # Собираем ID аннотаций (новый или старый формат)
        ann_ids = attrs.get("annotation_ids", [])
        if not ann_ids:
            # Обратная совместимость
            a_id = attrs.get("annotation_a_id")
            b_id = attrs.get("annotation_b_id")
            if a_id:
                ann_ids.append(a_id)
            if b_id:
                ann_ids.append(b_id)

        if len(ann_ids) < 2:
            raise serializers.ValidationError("Нужно минимум 2 аннотации для cross-check.")

        annotations = []
        for aid in ann_ids:
            ann = Annotation.objects(id=aid).first()
            if not ann:
                raise serializers.ValidationError(f"Аннотация {aid} не найдена.")
            if str(ann.task.id) != str(task.id):
                raise serializers.ValidationError(f"Аннотация {aid} не принадлежит task {task_id}.")
            annotations.append(ann)

        # Проверяем, что все аннотаторы разные
        annotator_ids = [str(a.annotator.id) for a in annotations]
        if len(set(annotator_ids)) < 2:
            raise serializers.ValidationError("Cross-check требует минимум 2 разных исполнителя.")

        # Проверяем совпадение форматов
        first_format = annotations[0].annotation_format
        for ann in annotations[1:]:
            if ann.annotation_format != first_format:
                raise serializers.ValidationError("annotation_format у всех аннотаций должен совпадать.")

        attrs["_task"] = task
        attrs["_annotations"] = annotations
        attrs["_annotation_format"] = first_format
        return attrs

    def _compute_metrics_dawid_skene(
        self,
        annotations: List[Annotation],
        annotation_format: str,
    ) -> Dict[str, Any]:
        """
        Вычисляет метрики через Dawid-Skene EM (для классификации и generic).
        """
        ann_data = [
            {
                "annotator_id": str(a.annotator.id),
                "label_data": a.label_data,
            }
            for a in annotations
        ]

        result = dawid_skene_em(ann_data, annotation_format)

        # Вычисляем F1 для каждого аннотатора относительно консенсуса
        annotator_metrics = {}
        for ann in annotations:
            ann_id = str(ann.annotator.id)
            quality = result["annotator_quality"].get(ann_id, {})
            accuracy = quality.get("accuracy", 0.0)
            annotator_metrics[ann_id] = {
                "accuracy": accuracy,
                "f1": accuracy,
                "confusion_matrix": quality.get("confusion_matrix", {}),
                "error_rate": quality.get("error_rate", 0.0),
            }

        # Определяем финальную метку
        best_label = result.get("final_label", "")
        best_confidence = result.get("final_confidence", 0.0)

        return {
            "method": "dawid_skene",
            "iterations": result["iterations"],
            "converged": result["converged"],
            "annotator_metrics": annotator_metrics,
            "final_label": best_label,
            "final_confidence": best_confidence,
            "aggregate_f1": round(
                sum(m["f1"] for m in annotator_metrics.values()) / max(len(annotator_metrics), 1),
                4,
            ),
        }

    def _compute_metrics_pairwise(
        self,
        annotations: List[Annotation],
        annotation_format: str,
    ) -> Dict[str, Any]:
        """
        Попарное сравнение для NER и bbox (через IoU).
        """
        if len(annotations) != 2:
            return {"method": "pairwise", "error": "Pairwise требует ровно 2 аннотации"}

        ann_a, ann_b = annotations[0], annotations[1]

        if annotation_format == "ner_v1":
            true_spans = extract_spans_ner(ann_a.label_data)
            pred_spans = extract_spans_ner(ann_b.label_data)
            metrics = compute_ner_metrics(true_spans, pred_spans)
            return {
                "method": "pairwise_ner",
                **metrics,
                "annotator_metrics": {
                    str(ann_a.annotator.id): {"f1": metrics["f1"]},
                    str(ann_b.annotator.id): {"f1": metrics["f1"]},
                },
                "aggregate_f1": metrics["f1"],
            }

        if annotation_format == "cv_v1" or "bbox" in annotation_format.lower():
            boxes_a = ann_a.label_data.get("boxes", [])
            boxes_b = ann_b.label_data.get("boxes", [])
            result_ab = greedy_iou_matching(boxes_a, boxes_b)
            result_ba = greedy_iou_matching(boxes_b, boxes_a)
            avg_f1 = (result_ab["f1"] + result_ba["f1"]) / 2
            return {
                "method": "pairwise_iou",
                "f1": round(avg_f1, 4),
                "precision": round((result_ab["precision"] + result_ba["precision"]) / 2, 4),
                "recall": round((result_ab["recall"] + result_ba["recall"]) / 2, 4),
                "tp": result_ab["tp"],
                "fp": result_ab["fp"],
                "fn": result_ab["fn"],
                "annotator_metrics": {
                    str(ann_a.annotator.id): {"f1": avg_f1},
                    str(ann_b.annotator.id): {"f1": avg_f1},
                },
                "aggregate_f1": avg_f1,
            }

        # generic_v1
        match = 1.0 if ann_a.label_data == ann_b.label_data else 0.0
        return {
            "method": "pairwise_generic",
            "f1": match,
            "precision": match,
            "recall": match,
            "annotator_metrics": {
                str(ann_a.annotator.id): {"f1": match},
                str(ann_b.annotator.id): {"f1": match},
            },
            "aggregate_f1": match,
        }

    def create(self, validated_data: Dict[str, Any]) -> QualityReview:
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not user:
            raise serializers.ValidationError("Authentication required.")

        task: Task = validated_data.pop("_task")
        annotations: List[Annotation] = validated_data.pop("_annotations")
        annotation_format: str = validated_data.pop("_annotation_format")

        # Выбираем метод расчёта метрик
        if annotation_format in ("classification_v1", "generic_v1"):
            all_metrics = self._compute_metrics_dawid_skene(annotations, annotation_format)
        else:
            all_metrics = self._compute_metrics_pairwise(annotations, annotation_format)

        arbitration_requested = validated_data.get("arbitration_requested", False)
        arbitration_comment = validated_data.get("arbitration_comment")
        arbitrator_id = validated_data.get("arbitrator")
        arbitrator = None
        if arbitrator_id:
            arbitrator = User.objects(id=arbitrator_id, role=User.ROLE_ADMIN).first()

        # ✅ final_label_data теперь словарь
        final_label_data = {
            "label": all_metrics.get("final_label", ""),
            "confidence": all_metrics.get("final_confidence", 0.0),
        }

        review = QualityReview(
            task=task,
            dataset=task.dataset,
            annotations=annotations,
            review_status=QualityReview.STATUS_COMPLETED if not arbitration_requested else QualityReview.STATUS_ARBITRATED,
            metrics=all_metrics,
            final_label_data=final_label_data,
            em_iterations=all_metrics.get("iterations", 0),
            convergence_achieved=all_metrics.get("converged", False),
            arbitration_requested=bool(arbitration_requested),
            arbitration_comment=arbitration_comment,
            arbitrator=arbitrator if arbitration_requested else None,
        )
        # ✅ Сохраняем без валидации
        try:
            review.save()
        except Exception:
            review.save(validate=False)

        # Сохраняем QualityMetric для каждого аннотатора
        annotator_metrics = all_metrics.get("annotator_metrics", {})
        for ann in annotations:
            ann_id = str(ann.annotator.id)
            am = annotator_metrics.get(ann_id, {})
            QualityMetric(
                dataset=task.dataset,
                task=task,
                annotator=ann.annotator,
                precision=_safe_float(all_metrics.get("precision", am.get("f1", 0.0))),
                recall=_safe_float(all_metrics.get("recall", am.get("f1", 0.0))),
                f1=_safe_float(am.get("f1", all_metrics.get("aggregate_f1", 0.0))),
                confusion_matrix=am.get("confusion_matrix", {}),
                details=all_metrics,
            ).save()

        # Обновляем рейтинг каждого аннотатора (EWMA)
        from django.conf import settings
        alpha = getattr(settings, 'ANNOTATOR_RATING_ALPHA', 0.1)

        for ann in annotations:
            ann_id_str = str(ann.annotator.id)
            am = annotator_metrics.get(ann_id_str, {})
            f1_score = _safe_float(am.get("f1", all_metrics.get("aggregate_f1", 0.0)))
            accuracy = _safe_float(am.get("accuracy", f1_score))

            difficulty = _safe_float(getattr(task, 'difficulty_score', 0.5))
            complexity_weight = 0.5 + 0.5 * difficulty
            task_score = accuracy * complexity_weight

            old_rating = _safe_float(ann.annotator.rating or 0.0)
            new_rating = alpha * task_score + (1.0 - alpha) * old_rating
            rating_delta = new_rating - old_rating

            # Атомарно обновляем рейтинг
            User._get_collection().update_one(
                {"_id": ann.annotator.id},
                {"$set": {"rating": round(new_rating, 4)}},
            )

            # Сохраняем историю
            RatingHistory(
                user=ann.annotator,
                task=task,
                dataset=task.dataset,
                f1_score=f1_score,
                difficulty=difficulty,
                accuracy=accuracy,
                task_score=task_score,
                rating_delta=round(rating_delta, 4),
                rating_before=round(old_rating, 4),
                rating_after=round(new_rating, 4),
                iteration_count=all_metrics.get("iterations", 0),
                annotation_format=annotation_format,
            ).save()
            
            # ✅ Добавить уведомление о результате проверки качества
            project_title = getattr(task.project, 'title', 'проекте') if task.project else 'проекте'
            if accuracy >= 0.7:
                notify_task_approved(ann.annotator, str(task.id), project_title)
            else:
                notify_task_rejected(ann.annotator, str(task.id), project_title)

        return review
